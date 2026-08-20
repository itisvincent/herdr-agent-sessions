// agents.js — per-agent on-disk session discovery + resume command tables.
//
// Ported from Orca's "AI Vault" scanner (stablyai/orca):
//   src/main/ai-vault/session-scanner-agent-sources.ts        (where sessions live)
//   src/main/ai-vault/session-scanner-opencode-sqlite-*.ts    (OpenCode SQLite)
//   src/shared/ai-vault-resume-command.ts + tui-agent-config.ts (how to resume)
//
// MVP simplifications vs Orca:
//   - No WSL-home fan-out, no parse cache, no per-agent transcript parser.
//   - sessionId / cwd / title are extracted best-effort from filenames, a small
//     head-read JSON key scan, or (OpenCode) the SQLite session table.
//   - antigravity (brain dirs) is not yet discovered.

const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");

const home = os.homedir();
const env = (k, fallback) => {
  const v = process.env[k] && process.env[k].trim();
  return v || fallback;
};
const PER_AGENT_LIMIT = 300;

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter((candidate) => {
    const resolved = path.resolve(candidate);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function orcaUserDataDir() {
  const explicit = (process.env.ORCA_USER_DATA_PATH || process.env.ORCA_USER_DATA_DIR || "").trim();
  if (explicit) return explicit;
  if (process.platform === "win32") {
    return path.join(env("APPDATA", path.join(home, "AppData", "Roaming")), "orca");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "orca");
  }
  return path.join(env("XDG_CONFIG_HOME", path.join(home, ".config")), "orca");
}

function codexSessionRoots() {
  const configuredHome = env("CODEX_HOME", path.join(home, ".codex"));
  const orcaHome = env(
    "ORCA_CODEX_HOME",
    path.join(orcaUserDataDir(), "codex-runtime-home", "home"),
  );
  return uniquePaths([
    path.join(configuredHome, "sessions"),
    path.join(home, ".codex", "sessions"),
    path.join(orcaHome, "sessions"),
  ]);
}

// ---------------------------------------------------------------------------
// Source table
// ---------------------------------------------------------------------------
// Each entry: either a file-walk source { roots, extensions, ... } or a custom
// { discover: async () => Session[] } source (OpenCode). Resume metadata:
//   resume.form controls the argv shape:
//     "resume"        -> [base, "resume", arg]
//     "--session"     -> [base, "--session", arg]
//     "--resume="     -> [base, "--resume="+arg]
//     "--resume"      -> [base, "--resume", arg]
//     "--conversation"-> [base, "--conversation", arg]
//     "rovodev"       -> [base, "rovodev", "run", "--restore", arg]
//   resume.argKind: "id" (use session id) or "path" (use absolute transcript path)
//   resume.herdrKind: Herdr `agent start --kind` value if supported, else null.

const AGENT_SOURCES = [
  {
    agent: "claude", label: "Claude",
    roots: () => [path.join(home, ".claude", "projects")],
    extensions: [".jsonl"],
    directoryPredicate: (name) => name !== "subagents",
    idFromFile: (p) => path.basename(p, ".jsonl"),
    cwdFromFile: cwdFromJsonl,
    resume: { base: "claude", form: "--resume", argKind: "id", herdrKind: "claude" },
  },
  {
    agent: "codex", label: "Codex",
    roots: codexSessionRoots,
    extensions: [".jsonl"],
    sessionPredicate: async (p) => !(await codexSessionIsWorker(p)),
    dedupeSessionIds: true,
    idFromFile: idFromCodexJsonl,
    cwdFromFile: cwdFromJsonl,
    resume: { base: "codex", form: "resume", argKind: "id", herdrKind: "codex" },
  },
  {
    agent: "pi", label: "Pi",
    roots: () => [env("PI_CODING_AGENT_DIR", path.join(home, ".pi", "agent", "sessions"))],
    extensions: [".jsonl"],
    idFromFile: (p) => p, // pi --session accepts a path-or-id; path is safest
    cwdFromFile: cwdFromJsonl,
    resume: { base: "pi", form: "--session", argKind: "path", herdrKind: "pi" },
  },
  {
    agent: "omp", label: "OMP",
    roots: () => [path.join(home, ".omp", "agent", "sessions")],
    extensions: [".jsonl"],
    directoryPredicate: (name, depth) =>
      depth === 0 || !/^\d+_[0-9a-fA-F-]+$/.test(name),
    idFromFile: (p) => p,
    cwdFromFile: cwdFromJsonl,
    resume: { base: "omp", form: "--resume", argKind: "path", herdrKind: "omp" },
  },
  {
    agent: "prime-agent", label: "Prime Agent",
    roots: () => [path.join(home, ".prime", "agent", "sessions")],
    extensions: [".jsonl"],
    idFromFile: (p) => p,
    cwdFromFile: cwdFromJsonl,
    resume: { base: "prime-agent", form: "--resume", argKind: "path", herdrKind: null },
  },
  {
    agent: "gemini", label: "Gemini",
    roots: () => [path.join(home, ".gemini", "tmp")],
    extensions: [".json", ".jsonl"],
    idFromFile: idFromJsonLike,
    cwdFromFile: cwdFromJsonLike,
    resume: { base: "gemini", form: "--resume", argKind: "id", herdrKind: "gemini" },
  },
  {
    agent: "copilot", label: "GitHub Copilot",
    roots: () => [path.join(env("COPILOT_HOME", path.join(home, ".copilot")), "session-state")],
    extensions: [".jsonl"],
    idFromFile: async (p) => (await idFromJsonl(p)) || path.basename(p, ".jsonl"),
    cwdFromFile: cwdFromJsonl,
    resume: { base: "copilot", form: "--resume=", argKind: "id", herdrKind: "copilot" },
  },
  {
    agent: "cursor", label: "Cursor",
    roots: () => [path.join(home, ".cursor", "projects")],
    extensions: [".jsonl"],
    filePredicate: (p) => p.split(/[\\/]/).includes("agent-transcripts"),
    idFromFile: idFromJsonl,
    cwdFromFile: cwdFromJsonl,
    resume: { base: "cursor-agent", form: "--resume", argKind: "id", herdrKind: "cursor" },
  },
  {
    agent: "grok", label: "Grok",
    roots: () => [path.join(home, ".grok", "sessions")],
    extensions: [".json"],
    filePredicate: (p) => path.basename(p) === "summary.json",
    idFromFile: (p) => path.basename(path.dirname(p)),
    cwdFromFile: grokCwdFromFile,
    titleFromFile: grokTitleFromFile,
    resume: { base: "grok", form: "--resume", argKind: "id", herdrKind: "grok" },
  },
  {
    agent: "devin", label: "Devin",
    roots: () => [
      path.join(env("DEVIN_HOME", path.join(home, ".local", "share", "devin", "cli")), "transcripts"),
    ],
    extensions: [".json"],
    idFromFile: idFromJsonLike,
    cwdFromFile: cwdFromJsonLike,
    resume: { base: "devin", form: "--resume", argKind: "id", herdrKind: "devin" },
  },
  {
    agent: "hermes", label: "Hermes",
    roots: () => [path.join(home, ".hermes", "sessions")],
    extensions: [".json"],
    filePredicate: (p) => path.basename(p).startsWith("session_"),
    idFromFile: (p) => path.basename(p, ".json"),
    cwdFromFile: cwdFromJsonLike,
    resume: { base: "hermes", form: "--resume", argKind: "id", herdrKind: "hermes" },
  },
  {
    agent: "rovo", label: "Rovo Dev",
    roots: () => [path.join(home, ".rovodev", "sessions")],
    extensions: [".json"],
    filePredicate: (p) => path.basename(p) === "metadata.json",
    idFromFile: (p) => path.basename(path.dirname(p)),
    cwdFromFile: cwdFromJsonLike,
    resume: { base: "acli", form: "rovodev", argKind: "id", herdrKind: null },
  },
  {
    agent: "droid", label: "Droid",
    roots: () => [path.join(home, ".factory", "sessions"), path.join(home, ".factory", "projects")],
    extensions: [".jsonl"],
    idFromFile: idFromJsonl,
    cwdFromFile: cwdFromJsonl,
    resume: { base: "droid", form: "--resume", argKind: "id", herdrKind: "droid" },
  },
  {
    agent: "kimi", label: "Kimi",
    roots: () => [path.join(home, ".kimi-code", "sessions")],
    extensions: [".json"],
    filePredicate: (p) =>
      path.basename(p) === "state.json" && path.basename(path.dirname(p)).startsWith("session_"),
    idFromFile: idFromJsonLike,
    cwdFromFile: cwdFromJsonLike,
    resume: { base: "kimi", form: "--session", argKind: "id", herdrKind: "kimi" },
  },
  {
    agent: "openclaw", label: "OpenClaw",
    roots: () => {
      const state = env("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
      const legacy = path.join(home, ".clawdbot");
      const norm = (d) => (path.basename(d) === "agents" ? d : path.join(d, "agents"));
      return [norm(state), norm(legacy)];
    },
    extensions: [".jsonl"],
    filePredicate: (p) => p.split(/[\\/]/).includes("sessions"),
    idFromFile: idFromJsonl,
    cwdFromFile: cwdFromJsonl,
    resume: { base: "openclaw", form: "--resume", argKind: "id", herdrKind: null },
  },
  {
    agent: "opencode", label: "OpenCode",
    // OpenCode 1.17.x stores sessions in a SQLite DB (<dataDir>/opencode*.db);
    // older installs used <dataDir>/storage/session/**/*.json. discover() handles
    // both and dedups by session id (SQLite wins on mixed installs).
    discover: () => discoverOpenCodeSessions(),
    resume: { base: "opencode", form: "--session", argKind: "id", herdrKind: "opencode" },
  },
  // antigravity (brain dirs) still needs a shape-specific scanner — follow-up.
];

// ---------------------------------------------------------------------------
// Best-effort extraction helpers
// ---------------------------------------------------------------------------

async function readHead(filePath, bytes = 65536) {
  let fh;
  try {
    fh = await fs.open(filePath, "r");
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    try { await fh?.close(); } catch {}
  }
}

function findFieldInObject(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  const want = new Set(keys);
  for (const k of want) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const found = findFieldInObject(v, keys, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Prefer a whole-document parse (pretty-printed JSON files like Grok
// summary.json), then fall back to JSONL line scan.
function findJsonField(text, keys) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const found = findFieldInObject(JSON.parse(trimmed), keys);
      if (found) return found;
    } catch {}
  }
  for (const line of text.split(/\r?\n/)) {
    const lineTrim = line.trim();
    if (!lineTrim || lineTrim[0] !== "{") continue;
    try {
      const found = findFieldInObject(JSON.parse(lineTrim), keys);
      if (found) return found;
    } catch {}
  }
  return null;
}

// Grok stores sessions as ~/.grok/sessions/<url-encoded-cwd>/<id>/summary.json
// (pretty-printed). cwd lives at info.cwd; the parent folder is a fallback.
async function grokCwdFromFile(filePath) {
  const head = await readHead(filePath, 256 * 1024);
  const fromJson = findJsonField(head, ["cwd", "workingDirectory", "projectPath", "directory"]);
  if (fromJson) return fromJson;
  const encoded = path.basename(path.dirname(path.dirname(filePath)));
  try {
    const decoded = decodeURIComponent(encoded);
    if (decoded && decoded !== encoded) return decoded;
  } catch {}
  return null;
}

async function grokTitleFromFile(filePath) {
  const head = await readHead(filePath, 256 * 1024);
  return findJsonField(head, ["generated_title", "session_summary", "title"]);
}

function uuidFromFilename(filePath) {
  const base = path.basename(filePath);
  const m = base.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  return m ? m[0] : null;
}

async function idFromJsonl(filePath) {
  const head = await readHead(filePath);
  return findJsonField(head, [
    "session_id", "sessionId", "id", "conversation_id", "conversationId", "thread_id", "threadId",
  ]);
}

async function codexSessionMeta(filePath) {
  const head = await readHead(filePath);
  for (const line of head.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    try {
      const record = JSON.parse(trimmed);
      if (record.type === "session_meta" && record.payload && typeof record.payload === "object") {
        return record.payload;
      }
    } catch {}
  }
  return null;
}

function codexPayloadIsWorker(payload) {
  const threadSource = typeof payload.thread_source === "string"
    ? payload.thread_source
    : typeof payload.threadSource === "string" ? payload.threadSource : null;
  if (threadSource) return threadSource.toLowerCase() !== "user";
  return Boolean(payload.source && typeof payload.source === "object" &&
    payload.source.subagent && typeof payload.source.subagent === "object");
}

async function codexSessionIsWorker(filePath) {
  const payload = await codexSessionMeta(filePath);
  return payload ? codexPayloadIsWorker(payload) : false;
}

async function idFromCodexJsonl(filePath) {
  const payload = await codexSessionMeta(filePath);
  return (payload && typeof payload.id === "string" && payload.id) ||
    (await idFromJsonl(filePath)) || uuidFromFilename(filePath);
}

async function idFromJsonLike(filePath) {
  const head = await readHead(filePath);
  return findJsonField(head, [
    "session_id", "sessionId", "id", "conversation_id", "conversationId", "thread_id", "threadId",
  ]);
}

async function cwdFromJsonl(filePath) {
  const head = await readHead(filePath);
  return findJsonField(head, ["cwd", "workingDirectory", "projectPath", "directory", "projectDir"]);
}

async function cwdFromJsonLike(filePath) {
  const head = await readHead(filePath);
  return findJsonField(head, ["cwd", "workingDirectory", "projectPath", "directory", "projectDir"]);
}

// ---------------------------------------------------------------------------
// Resume command construction
// ---------------------------------------------------------------------------

function resumeArgv(resume, argValue) {
  switch (resume.form) {
    case "resume":         return ["resume", argValue];
    case "--session":      return ["--session", argValue];
    case "--resume=":      return [`--resume=${argValue}`];
    case "--resume":       return ["--resume", argValue];
    case "--conversation": return ["--conversation", argValue];
    case "rovodev":        return ["rovodev", "run", "--restore", argValue];
    default:               return [argValue];
  }
}

function shellQuote(value, platform) {
  if (platform === "win32") {
    return `"${String(value).replace(/"/g, '""')}"`;
  }
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resumeShellCommand(resume, argValue, platform) {
  const args = resumeArgv(resume, argValue);
  return [resume.base, ...args.map((a) => shellQuote(a, platform))].join(" ");
}

// ---------------------------------------------------------------------------
// OpenCode discovery (SQLite 1.17.x + legacy JSON files)
// ---------------------------------------------------------------------------
// Ported from Orca's session-scanner-opencode-sqlite-{paths,list,discovery}.ts.
// Uses Node's built-in node:sqlite (Node 22+). Falls back to legacy files only
// when SQLite is unavailable or the DB lacks a `session` table.

function opencodeDataDir() {
  const xdg = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim();
  return xdg ? path.join(xdg, "opencode") : path.join(home, ".local", "share", "opencode");
}

async function listOpenCodeDbs(dataDir) {
  let ents;
  try { ents = await fs.readdir(dataDir, { withFileTypes: true }); } catch { return []; }
  return ents
    .filter((e) => e.isFile() && /^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/.test(e.name))
    .map((e) => path.join(dataDir, e.name))
    .sort();
}

async function walkOpenCodeLegacy(dir, acc) {
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkOpenCodeLegacy(p, acc);
    else if (e.isFile() && e.name.endsWith(".json")) acc.push(p);
  }
}

async function discoverOpenCodeSessions() {
  const dataDir = opencodeDataDir();
  const resume = { base: "opencode", form: "--session", argKind: "id", herdrKind: "opencode" };
  const sessions = [];
  const sqliteIds = new Set();

  // 1. SQLite (1.17.x)
  let DatabaseSync = null;
  try { DatabaseSync = require("node:sqlite").DatabaseSync; } catch {}
  if (DatabaseSync) {
    const dbs = await listOpenCodeDbs(dataDir);
    for (const dbPath of dbs) {
      let db = null;
      try {
        db = new DatabaseSync(dbPath, { readonly: true, fileMustExist: true });
        const hasTable = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session'")
          .get();
        if (!hasTable) { db.close(); db = null; continue; }
        const rows = db
          .prepare(
            "SELECT id, directory, title, time_created, time_updated FROM session " +
              "WHERE parent_id IS NULL AND time_archived IS NULL " +
              "ORDER BY CASE WHEN time_updated > 0 THEN time_updated ELSE time_created END DESC LIMIT ?"
          )
          .all(PER_AGENT_LIMIT);
        for (const r of rows) {
          sqliteIds.add(r.id);
          const mtimeMs = r.time_updated && r.time_updated > 0 ? r.time_updated : r.time_created;
          sessions.push({
            agent: "opencode", label: "OpenCode", resume,
            filePath: `${dbPath}#${r.id}`, sessionId: r.id,
            cwd: r.directory || null, title: r.title || null, mtimeMs,
          });
        }
        db.close(); db = null;
      } catch {
        try { if (db) db.close(); } catch {}
      }
    }
  }

  // 2. Legacy JSON files (<dataDir>/storage/session/**/*.json)
  const legacyRoot = path.join(dataDir, "storage", "session");
  const legacyFiles = [];
  await walkOpenCodeLegacy(legacyRoot, legacyFiles);
  const legacyStated = [];
  for (const f of legacyFiles) {
    try { const st = await fs.stat(f); legacyStated.push({ path: f, mtimeMs: st.mtimeMs }); } catch {}
  }
  legacyStated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of legacyStated.slice(0, PER_AGENT_LIMIT)) {
    const id = path.basename(c.path, ".json");
    if (sqliteIds.has(id)) continue; // SQLite is source of truth on mixed installs
    let cwd = null, title = null;
    try {
      const head = await readHead(c.path);
      cwd = findJsonField(head, ["cwd", "directory", "workDir", "projectPath"]);
      title = findJsonField(head, ["title", "summary"]);
    } catch {}
    sessions.push({
      agent: "opencode", label: "OpenCode", resume,
      filePath: c.path, sessionId: id, cwd, title, mtimeMs: c.mtimeMs,
    });
  }

  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, PER_AGENT_LIMIT);
}

module.exports = {
  AGENT_SOURCES,
  resumeArgv,
  resumeShellCommand,
  findJsonField,
  readHead,
};
