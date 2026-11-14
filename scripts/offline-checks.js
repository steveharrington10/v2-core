// Runs the offline regression gate (test/offline/*.test.js) in an in-process
// EVM; no devnet needed. Files are listed explicitly because `node --test`
// treats directory and glob arguments differently across Node versions.
//
// Usage: node scripts/offline-checks.js   (or: npm run test:offline)

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const OFFLINE_DIR = path.resolve(__dirname, "..", "test", "offline");

// Returns true when every offline check passes.
function runOfflineChecks() {
  const files = fs
    .readdirSync(OFFLINE_DIR)
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => path.join(OFFLINE_DIR, name));
  if (files.length === 0) throw new Error(`no offline checks found in ${OFFLINE_DIR}`);
  const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status === 0;
}

if (require.main === module) {
  process.exitCode = runOfflineChecks() ? 0 : 1;
}

module.exports = { runOfflineChecks };
