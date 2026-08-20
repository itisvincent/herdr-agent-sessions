// panel.js — Herdr plugin pane: scans on-disk agent sessions and lets the user
// resume one in a new pane. Orca-AI-Vault-style right panel.
//
// Flow:
//   1. Walk each agent's session roots (agents.js) -> candidate files.
//   2. Best-effort extract sessionId + cwd, sort by mtime desc.
//   3. Render an interactive list (raw ANSI, no deps).
//   4. On Enter: split the main pane and resume the agent there via
//      `herdr agent start` (primary) or `herdr pane run` (fallback).
//
// Env provided by Herdr: HERDR_BIN_PATH, HERDR_PANE_ID, HERDR_PLUGIN_CONTEXT_JSON.

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnSync, spawn } = require("node:child_process");
const { AGENT_SOURCES, resumeArgv, resumeShellCommand } = require("./agents");

const HERDR = process.env.HERDR_BIN_PATH || "herdr";
const PLATFORM = process.platform;
const PER_AGENT_LIMIT = 300;

// Current Herdr workspace cwd, from the plugin context Herdr injects into panes.
function parseWorkspaceCwd() {
  try {
    const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || "{}");
    if (typeof ctx.workspace_cwd === "string") return ctx.workspace_cwd;
    if (ctx.workspace && typeof ctx.workspace.cwd === "string") return ctx.workspace.cwd;
    if (typeof ctx.workspaceCwd === "string") return ctx.workspaceCwd;
  } catch {}
  return null;
}
const WORKSPACE_CWD = parseWorkspaceCwd();

function normPath(p) {
  if (!p) return "";
  const stripped = p.startsWith("\\\\?\\") ? p.slice(4) : p;
  return stripped.replace(/[\\/]+/g, "\\").toLowerCase().replace(/\\+$/, "");
}
function isInWorkspace(sessionCwd) {
  if (!WORKSPACE_CWD || !sessionCwd) return false;
  const w = normPath(WORKSPACE_CWD);
  const s = normPath(sessionCwd);
  return s === w || s.startsWith(w + "\\");
}

function openInFileManager(dir) {
  const cmd = PLATFORM === "win32" ? ["explorer", dir]
    : PLATFORM === "darwin" ? ["open", dir]
    : ["xdg-open", dir];
  try { const p = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: "ignore" }); p.unref(); return true; } catch { return false; }
}

// OpenCode SQLite rows use a synthetic `<dbPath>#<sessionId>` path.
function realSessionFile(session) {
  const p = session?.filePath;
  if (!p) return null;
  const hash = p.lastIndexOf("#");
  if (hash > 0) {
    const dbPath = p.slice(0, hash);
    if (/^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/i.test(path.basename(dbPath))) return dbPath;
  }
  return p;
}

// Reveal the session file in its parent folder (select it in Explorer / Finder).
function revealSessionFile(filePath) {
  try {
    if (PLATFORM === "win32") {
      const p = spawn("explorer", [`/select,${filePath}`], { detached: true, stdio: "ignore" });
      p.unref();
      return true;
    }
    if (PLATFORM === "darwin") {
      const p = spawn("open", ["-R", filePath], { detached: true, stdio: "ignore" });
      p.unref();
      return true;
    }
    const p = spawn("xdg-open", [path.dirname(filePath)], { detached: true, stdio: "ignore" });
    p.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

async function walk(root, source, depth, acc) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return; // missing root / permission -> skip silently
  }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (source.directoryPredicate && !source.directoryPredicate(ent.name, depth)) continue;
      await walk(path.join(root, ent.name), source, depth + 1, acc);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (!source.extensions.includes(ext)) continue;
      const full = path.join(root, ent.name);
      if (source.filePredicate && !source.filePredicate(full)) continue;
      acc.push(full);
    }
  }
}

async function scanOne(source) {
  // Sources with a custom discover() (e.g. OpenCode SQLite) bypass the file walk.
  if (source.discover) {
    try { return await source.discover(); } catch { return []; }
  }
  const files = [];
  for (const root of source.roots()) {
    await walk(root, source, 0, files);
  }
  const eligibleFiles = [];
  for (const filePath of files) {
    if (!source.sessionPredicate) {
      eligibleFiles.push(filePath);
      continue;
    }
    try {
      if (await source.sessionPredicate(filePath)) eligibleFiles.push(filePath);
    } catch {}
  }
  // stat + sort by mtime desc, cap
  const stated = [];
  for (const f of eligibleFiles) {
    try {
      const st = await fs.stat(f);
      stated.push({ path: f, mtimeMs: st.mtimeMs });
    } catch {}
  }
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const candidates = stated.slice(0, PER_AGENT_LIMIT);

  const sessions = [];
  for (const c of candidates) {
    let id = null;
    try { id = await source.idFromFile(c.path); } catch {}
    if (!id) continue; // can't resume without an id/path
    let cwd = null;
    try { cwd = await source.cwdFromFile(c.path); } catch {}
    let title = null;
    if (source.titleFromFile) {
      try { title = await source.titleFromFile(c.path); } catch {}
    }
    sessions.push({
      agent: source.agent,
      label: source.label,
      resume: source.resume,
      filePath: c.path,
      sessionId: id,
      cwd,
      title,
      mtimeMs: c.mtimeMs,
    });
  }
  if (source.dedupeSessionIds) {
    const seen = new Set();
    return sessions.filter((session) => {
      const key = `${session.agent}\0${session.sessionId}\0${path.basename(session.filePath)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return sessions;
}

async function scanAll() {
  const perAgent = await Promise.all(AGENT_SOURCES.map(scanOne));
  return perAgent.flat().sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ---------------------------------------------------------------------------
// Herdr CLI helpers
// ---------------------------------------------------------------------------

function herdrJson(args) {
  const res = spawnSync(HERDR, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (res.status !== 0) {
    return { error: res.stderr?.trim() || `herdr ${args.join(" ")} exited ${res.status}` };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { error: `non-JSON output from herdr ${args.join(" ")}` };
  }
}

// Find a pane_id string anywhere in a JSON response.
function findPaneId(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.pane_id === "string") return obj.pane_id;
  if (obj.result) {
    const r = obj.result;
    if (typeof r.pane_id === "string") return r.pane_id;
    if (r.pane && typeof r.pane.pane_id === "string") return r.pane.pane_id;
    if (r.root_pane && typeof r.root_pane.pane_id === "string") return r.root_pane.pane_id;
    if (r.neighbor && typeof r.neighbor.pane_id === "string") return r.neighbor.pane_id;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = findPaneId(v);
      if (found) return found;
    }
  }
  return null;
}

// The main pane is the plugin pane's left neighbor. If none, use current.
function mainPaneId() {
  const r = herdrJson(["pane", "neighbor", "--direction", "left", "--current"]);
  const id = findPaneId(r);
  if (id) return id;
  // fallback: current
  const c = herdrJson(["pane", "current"]);
  return findPaneId(c);
}

function sanitizeName(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "agent";
}

function extractWorkspaceId(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.workspace_id === "string") return obj.workspace_id;
  const r = obj.result;
  if (r?.workspace?.workspace_id) return r.workspace.workspace_id;
  if (typeof r?.workspace_id === "string") return r.workspace_id;
  return null;
}

function loadSnapshot() {
  const j = herdrJson(["api", "snapshot"]);
  return j.snapshot || j.result?.snapshot || null;
}

function workspacesWithPanes() {
  const snap = loadSnapshot();
  if (!snap) return [];
  const byId = new Map();
  for (const ws of snap.workspaces || []) {
    byId.set(ws.workspace_id, { ...ws, panes: [], cwds: [] });
  }
  for (const p of snap.panes || []) {
    const rec = byId.get(p.workspace_id);
    if (!rec) continue;
    rec.panes.push(p);
    if (p.cwd) rec.cwds.push(p.cwd);
  }
  return [...byId.values()];
}

function pathsRelated(a, b) {
  const x = normPath(a);
  const y = normPath(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y + "\\") || y.startsWith(x + "\\");
}

function findWorkspaceForCwd(cwd) {
  if (!cwd) return null;
  const list = workspacesWithPanes();
  const exact = list.find((ws) => ws.cwds.some((c) => normPath(c) === normPath(cwd)));
  if (exact) return exact;
  const related = list.find((ws) => ws.cwds.some((c) => pathsRelated(c, cwd)));
  if (related) return related;
  const base = path.basename(cwd).toLowerCase();
  return list.find((ws) => (ws.label || "").toLowerCase() === base) || null;
}

function pickResumeTarget(ws) {
  const pluginDir = normPath(__dirname);
  const usable = (ws.panes || []).filter((p) => {
    const pc = normPath(p.cwd);
    if (pluginDir && pc === pluginDir) return false;
    if (pc.includes("herdr-agent-sessions")) return false;
    return true;
  });
  // Prefer an idle shell so we can resume in-place (no extra split).
  const idle = usable.find((p) => !p.agent);
  if (idle) return { paneId: idle.pane_id, idle: true };
  const any = usable[0] || ws.panes[0];
  return { paneId: any?.pane_id || null, idle: false };
}

// Focus an existing workspace whose cwd matches, or create one.
function attachWorkspace(cwd) {
  if (!cwd) return { created: false, workspaceId: null, paneId: null, idle: false, label: null };
  const existing = findWorkspaceForCwd(cwd);
  if (existing) {
    herdrJson(["workspace", "focus", existing.workspace_id]);
    const picked = pickResumeTarget(existing);
    return {
      created: false,
      workspaceId: existing.workspace_id,
      paneId: picked.paneId,
      idle: picked.idle,
      label: existing.label || existing.workspace_id,
    };
  }
  const label = path.basename(cwd) || "session";
  const created = herdrJson(["workspace", "create", "--cwd", cwd, "--label", label, "--focus"]);
  if (created.error) throw new Error(created.error);
  return {
    created: true,
    workspaceId: extractWorkspaceId(created),
    paneId: findPaneId(created),
    idle: true,
    label,
  };
}

// Split a pane to the right; returns the new pane id.
function splitRight(paneId, cwd, extraEnv) {
  const args = ["pane", "split", paneId, "--direction", "right", "--focus"];
  if (cwd) args.push("--cwd", cwd);
  if (extraEnv) {
    for (const [k, v] of Object.entries(extraEnv)) args.push("--env", `${k}=${v}`);
  }
  const r = herdrJson(args);
  const id = findPaneId(r);
  if (!id) throw new Error(r.error || "pane split returned no pane id");
  return id;
}

function createTabInWorkspace(workspaceId, cwd, extraEnv, label) {
  const args = ["tab", "create"];
  if (workspaceId) args.push("--workspace", workspaceId);
  if (cwd) args.push("--cwd", cwd);
  if (label) args.push("--label", String(label).slice(0, 24));
  args.push("--focus");
  if (extraEnv) {
    for (const [k, v] of Object.entries(extraEnv)) args.push("--env", `${k}=${v}`);
  }
  const r = herdrJson(args);
  if (r.error) throw new Error(r.error);
  const paneId = findPaneId(r);
  if (!paneId) throw new Error("tab create returned no pane id");
  return paneId;
}

function isNewTabResume(k) {
  return k === "t";
}

// Resume a session. newTab: open a new tab in the (attached) workspace.
function resumeSession(session, opts) {
  const newTab = !!(opts && opts.newTab);
  const { resume, sessionId, filePath, cwd } = session;
  const argValue = resume.argKind === "path" ? filePath : sessionId;
  const env = session.agent === "codex" ? codexEnvFor(filePath) : undefined;

  let attached = { created: false, workspaceId: null, paneId: null, label: null };
  try {
    attached = attachWorkspace(cwd);
  } catch (e) {
    return { ok: false, message: `workspace attach failed: ${e.message}` };
  }

  let newPaneId;
  if (newTab) {
    try {
      const tabLabel = session.label || session.agent || "session";
      newPaneId = createTabInWorkspace(
        attached.workspaceId || process.env.HERDR_WORKSPACE_ID,
        cwd,
        env,
        tabLabel,
      );
    } catch (e) {
      return { ok: false, message: `tab create failed: ${e.message}` };
    }
  } else {
    // Idle shell in the target workspace, or split only if every pane has an agent.
    newPaneId = attached.paneId;
    if (!newPaneId || !attached.idle) {
      try {
        newPaneId = splitRight(attached.paneId || mainPaneId(), cwd, env);
      } catch (e) {
        return { ok: false, message: `split failed: ${e.message}` };
      }
    }
  }

  // `herdr agent start` uses Start-Process -FilePath <kind> on Windows.
  // npm global bins (`pi`, `claude`, `opencode`, …) are .cmd / #!/bin/sh shims,
  // not PE executables — Start-Process then throws "%1 is not a valid Win32
  // application". Skip it on Windows and type the resume into the pane shell,
  // which resolves `pi.cmd` correctly.
  if (resume.herdrKind && PLATFORM !== "win32") {
    const name = sanitizeName(`${session.agent}-${sessionId}`) + "-" + Math.random().toString(36).slice(2, 6);
    const argv = resumeArgv(resume, argValue);
    const startArgs = ["agent", "start", name, "--kind", resume.herdrKind, "--pane", newPaneId, "--timeout", "10000", "--", ...argv];
    const r = herdrJson(startArgs);
    if (!r.error) return { ok: true, newPaneId, workspace: attached };
  }

  // Fallback: `herdr pane run` with a shell command.
  const cmd = resumeShellCommand(resume, argValue, PLATFORM);
  const r = herdrJson(["pane", "run", newPaneId, cmd]);
  if (r.error) return { ok: false, message: `pane run failed: ${r.error}` };
  return { ok: true, newPaneId, workspace: attached };
}

// For codex sessions under a non-default CODEX_HOME, propagate it to the pane.
function codexEnvFor(filePath) {
  for (const src of AGENT_SOURCES) {
    if (src.agent !== "codex") continue;
    for (const root of src.roots()) {
      if (filePath.startsWith(root + path.sep) || filePath === root) {
        // root = $CODEX_HOME/sessions
        const codeHome = path.dirname(root);
        const defaultHome = path.join(require("node:os").homedir(), ".codex");
        return codeHome && codeHome !== defaultHome ? { CODEX_HOME: codeHome } : undefined;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// TUI
// ---------------------------------------------------------------------------

const CSI = "\x1b[";
const CLEAR = CSI + "2J" + CSI + "H";
const ALT_ON = "\x1b[?1049h", ALT_OFF = "\x1b[?1049l";
const HIDE = CSI + "?25l", SHOW = CSI + "?25h";

function relTime(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  return `${mo}mo`;
}

function truncate(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "~";
}

const COL_AGENT = 10;
const COL_AGE = 5;

function colLeft(s, n) {
  const t = truncate(String(s || ""), n);
  return t + " ".repeat(Math.max(0, n - t.length));
}

function colRight(s, n) {
  const t = truncate(String(s || ""), n);
  return " ".repeat(Math.max(0, n - t.length)) + t;
}

async function runTUI(sessions) {
  if (sessions.length === 0) {
    process.stdout.write(`\x1b[31mNo agent sessions found on disk.\x1b[0m\r\n(press any key to exit)\r\n`);
    waitAnyKey();
    return;
  }

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let selected = 0;
  let top = 0;
  let filter = "";
  let filtering = false;
  let filtered = sessions;
  let workspaceOnly = false;
  let statusMsg = "";

  function applyFilter() {
    let list = sessions;
    if (workspaceOnly) list = list.filter((s) => isInWorkspace(s.cwd));
    if (filter) {
      const q = filter.toLowerCase();
      list = list.filter((s) => `${s.label} ${s.filePath} ${s.sessionId} ${s.title || ""}`.toLowerCase().includes(q));
    }
    filtered = list;
    selected = Math.min(selected, Math.max(0, filtered.length - 1));
    top = Math.min(top, selected);
  }

  function render() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const out = [];
    out.push(CLEAR + HIDE);

    // header
    const wsTag = workspaceOnly ? `  [workspace: ${truncate(WORKSPACE_CWD || "?", 30)}]` : "";
    const title = ` Agent Sessions  —  ${filtered.length} found` + wsTag + (filter ? `  / filter: ${filter}_` : "");
    out.push("\x1b[1;36m" + truncate(title, cols) + "\x1b[0m");
    const gapAgentAge = " ";
    const gapAgeCwd = "  ";
    const prefix = "  ";
    const head =
      prefix + colLeft("agent", COL_AGENT) + gapAgentAge + colRight("age", COL_AGE) + gapAgeCwd + "cwd";
    out.push("\x1b[2m" + truncate(head, cols) + "\x1b[0m");

    const headerLines = 2;
    const footerLines = 2;
    const listRows = rows - headerLines - footerLines;
    const visible = filtered.slice(top, top + listRows);
    for (let i = 0; i < visible.length; i++) {
      const s = visible[i];
      const idx = top + i;
      const isSel = idx === selected;
      const line =
        colLeft(s.label, COL_AGENT) +
        gapAgentAge +
        colRight(relTime(s.mtimeMs), COL_AGE) +
        gapAgeCwd +
        truncate(s.cwd || s.title || s.sessionId, Math.max(8, cols - COL_AGENT - COL_AGE - 5));
      const row = (isSel ? "> " : prefix) + line;
      out.push(isSel ? "\x1b[30;47m" + truncate(row, cols) + "\x1b[0m" : truncate(row, cols));
    }
    // pad to footer
    while (out.length < headerLines + listRows) out.push("");

    // footer
    out.push("\x1b[2m" + truncate(statusMsg || " ", cols) + "\x1b[0m");
    out.push("\x1b[2m" + "enter resume · t new tab · / filter · w workspace · o folder · f file · r refresh · q quit" + "\x1b[0m");

    process.stdout.write(out.join("\r\n"));
  }

  return new Promise((resolve) => {
    function redraw() { render(); }
    redraw();

    stdin.on("data", (data) => {
      const k = data.toString();
      // Ctrl+C always quits.
      if (k === "\x03") { cleanup(); resolve(); return; }

      // ---- filter mode: printable chars build the query; Esc/Enter exit ----
      if (filtering) {
        if (k === "\x1b") { filtering = false; filter = ""; applyFilter(); statusMsg = ""; render(); return; }
        if (k === "\r" || k === "\n") { filtering = false; statusMsg = ""; render(); return; } // keep filter applied
        if (k === "\x7f") { filter = filter.slice(0, -1); applyFilter(); render(); return; }
        if (/^[\x20-\x7e]$/.test(k)) { filter += k; applyFilter(); render(); return; }
        return; // ignore other keys while filtering
      }

      // ---- normal mode ----
      if (k === "q" || k === "\x1b") { cleanup(); resolve(); return; }
      if (k === "r") { statusMsg = "refreshing…"; render(); scanAll().then((s) => { sessions = s; applyFilter(); statusMsg = `refreshed: ${s.length} sessions`; render(); }); return; }
      if (k === "w") {
        if (!WORKSPACE_CWD) { statusMsg = "workspace cwd unavailable"; render(); return; }
        workspaceOnly = !workspaceOnly; applyFilter();
        statusMsg = workspaceOnly ? `workspace only: ${filtered.length} sessions` : "all sessions";
        render(); return;
      }
      if (k === "o") {
        const s = filtered[selected]; if (!s) return;
        if (!s.cwd) { statusMsg = "no cwd for this session"; render(); return; }
        statusMsg = openInFileManager(s.cwd) ? `opened ${s.cwd}` : `failed to open ${s.cwd}`;
        render(); return;
      }
      if (k === "f") {
        const s = filtered[selected]; if (!s) return;
        const file = realSessionFile(s);
        if (!file) { statusMsg = "no session file for this row"; render(); return; }
        statusMsg = revealSessionFile(file) ? `revealed ${file}` : `failed to reveal ${file}`;
        render(); return;
      }
      if (k === "s") {
        const s = filtered[selected]; if (!s) return;
        if (!s.cwd) { statusMsg = "no cwd for this session"; render(); return; }
        try {
          const mainId = mainPaneId();
          const newPaneId = splitRight(mainId, s.cwd, undefined);
          statusMsg = `shell opened in ${s.cwd} (pane ${newPaneId})`;
        } catch (e) { statusMsg = `failed: ${e.message}`; }
        render(); return;
      }
      if (k === "/") { filtering = true; filter = ""; applyFilter(); statusMsg = "filter: type to filter, Esc clears"; render(); return; }
      if (isNewTabResume(k) || k === "\r" || k === "\n") {
        const s = filtered[selected];
        if (!s) return;
        const newTab = isNewTabResume(k);
        statusMsg = newTab ? `resuming ${s.label} in new tab…` : `resuming ${s.label}…`;
        render();
        setImmediate(() => {
          const res = resumeSession(s, { newTab });
          const wsNote = res.workspace
            ? (res.workspace.created ? "created " : "attached ") + (res.workspace.label || "workspace")
            : "resumed";
          statusMsg = res.ok
            ? wsNote + (newTab ? " · new tab · pane " : " · pane ") + res.newPaneId
            : res.message;
          render();
        });
        return;
      }
      // navigation
      if (k === "\x1b[A" || k === "k") { selected = Math.max(0, selected - 1); if (selected < top) top = selected; render(); return; }
      if (k === "\x1b[B" || k === "j") { selected = Math.min(filtered.length - 1, selected + 1); if (selected >= top + (process.stdout.rows || 24) - 4) top = selected - ((process.stdout.rows || 24) - 5); render(); return; }
      if (k === "g") { selected = 0; top = 0; render(); return; }
      if (k === "G") { selected = filtered.length - 1; top = Math.max(0, selected - 5); render(); return; }
    });

    function cleanup() {
      process.stdout.write(SHOW + ALT_OFF);
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
    }
  });
}

function waitAnyKey() {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.once("data", () => { try { process.stdin.setRawMode(false); } catch {} process.exit(0); });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

(async () => {
  if (typeof process.stdin.setRawMode !== "function") {
    process.stderr.write("panel.js must run inside a Herdr terminal pane (no TTY on stdin).\n");
    process.exit(1);
  }
  process.stdout.write(ALT_ON + HIDE);
  const sessions = await scanAll();
  await runTUI(sessions);
  process.stdout.write(SHOW + ALT_OFF);
  process.exit(0);
})().catch((e) => {
  process.stdout.write(SHOW + ALT_OFF);
  process.stderr.write(`agent-sessions plugin error: ${e.stack || e}\n`);
  process.exit(1);
});
