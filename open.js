// open.js — the `open` action. Actions run WITHOUT a TTY, so this action does
// not render the TUI itself; it just asks Herdr to open the `panel` pane
// entrypoint (which IS a real terminal pane) and exits.
const { spawnSync } = require("node:child_process");

const herdr = process.env.HERDR_BIN_PATH || "herdr";
// Windows pane id is separate: relative `node panel.js` cannot be a pane
// command under Herdr's \\?\ plugin cwd (Node EISDIR on `D:`).
const entrypoint = process.platform === "win32" ? "panel-windows" : "panel";
const r = spawnSync(
  herdr,
  ["plugin", "pane", "open", "--plugin", "example.agent-sessions", "--entrypoint", entrypoint],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
);
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(r.status ?? 1);