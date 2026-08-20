// Portable launcher: resolve scripts via HERDR_PLUGIN_ROOT so the manifest
// does not hardcode a machine-specific path. Strips Windows \\?\ prefixes.
const path = require("node:path");

let root = process.env.HERDR_PLUGIN_ROOT || __dirname;
if (root.startsWith("\\\\?\\")) root = root.slice(4);

const script = process.argv[2];
if (!script) {
  process.stderr.write("boot.js: missing script name\n");
  process.exit(2);
}

require(path.join(root, script));
