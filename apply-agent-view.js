// Apply a Herdr Agents-panel view: only agents in the focused workspace.
// agent.view.set has no CLI wrapper, so this talks NDJSON to the API socket.
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

function socketTarget() {
  const raw = process.env.HERDR_SOCKET_PATH;
  if (process.platform !== "win32") {
    return raw || path.join(os.homedir(), ".config", "herdr", "herdr.sock");
  }
  // On Windows the on-disk .sock is a marker; the real transport is a named pipe
  // whose name is \\.\pipe\<full marker path>.
  const marker =
    raw ||
    path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "herdr", "herdr.sock");
  const cleaned = marker.startsWith("\\\\?\\") ? marker.slice(4) : marker;
  if (cleaned.startsWith("\\\\.\\pipe\\")) return cleaned;
  return "\\\\.\\pipe\\" + cleaned;
}

const request = {
  id: "agent-view-current-ws",
  method: "agent.view.set",
  params: {
    source: "plugin:example.agent-sessions",
    label: "current-workspace",
    filter: {
      op: "eq",
      field: "workspace_id",
      value: { context: "current_workspace_id" },
    },
    sort: [
      { field: "attention", order: "desc" },
      { field: "state_change_seq", order: "desc" },
    ],
  },
};

const target = socketTarget();
const sock = net.connect(target, () => {
  sock.write(JSON.stringify(request) + "\n");
});
let buf = "";
sock.setEncoding("utf8");
sock.on("data", (chunk) => {
  buf += chunk;
  const nl = buf.indexOf("\n");
  if (nl === -1) return;
  const line = buf.slice(0, nl);
  process.stdout.write(line + "\n");
  sock.end();
  try {
    const res = JSON.parse(line);
    process.exit(res.error ? 1 : 0);
  } catch {
    process.exit(1);
  }
});
sock.on("error", (err) => {
  process.stderr.write(`apply-agent-view: ${target}: ${err.message}\n`);
  process.exit(1);
});
setTimeout(() => {
  process.stderr.write("apply-agent-view: timeout\n");
  process.exit(1);
}, 5000);