#!/usr/bin/env node
// Ensures a QuantumCoin devnet is installed and running for tests, on any OS.
//
// - Downloads the platform's qc-release-<platform>-devnet-<release> archive
//   and checks it against a SHA-256 pinned in this file before anything is
//   written, extracted or run. Every failure is fatal (fail closed); there is
//   no fallback to an unverified archive.
// - The archive is cached in <devnet dir>/.cache (mode 0700), never in the
//   shared temp directory, and a cached copy is re-verified before reuse.
// - Initializes the chain the same way upstream builds its devnet packages:
//   `dp --datadir data init genesis.json`, then copies the validator keystore
//   into data/keystore.
// - Records the verified archive hash in <devnet dir>/.verified-sha256 and
//   refuses to launch an install that lacks a matching record.
// - Launches the official connectvalidator script with an HTTP RPC port and
//   waits for the RPC to come up. If the RPC already answers, the running node
//   is reused.
//
// Usage: node scripts/devnet.js ensure    install if needed, then start
//        node scripts/devnet.js install   install only
//
// Environment:
//   QC_DEVNET_DIR       install directory
//   QC_DEVNET_RELEASE   release tag (default test-v2.0.74)
//   QC_DEVNET_SHA256    required for a release with no pinned hash below
//   QC_RPC_URL, QC_CHAIN_ID

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");

const IS_WINDOWS = process.platform === "win32";

const PLATFORMS = {
  win32: { tag: "windows", ext: "zip", binary: "dp.exe" },
  darwin: { tag: "mac", ext: "tar.gz", binary: "dp" },
  linux: { tag: "ubuntu", ext: "tar.gz", binary: "dp" },
};
const PLATFORM = PLATFORMS[process.platform];
if (!PLATFORM) {
  console.error(`devnet: unsupported platform ${process.platform}`);
  process.exit(1);
}

// SHA-256 of qc-release-<tag>-devnet-<release>.<ext>. Taken from the release's
// releasehash-<tag>-devnet-<release>.txt files, which agree with GitHub's own
// asset digests. To add a release, pin all three platforms here.
const PINNED_SHA256 = {
  "test-v2.0.74": {
    mac: "963edf1c32bb98253eb957a92106d733917f5101b60164491cdcc93ac5015906",
    ubuntu: "2cf60b00e8728adca311a57169b3b93279fd246211e690405df539d1e1f46e8e",
    windows: "463352720c851e6d5dd58051b65f0d739e9c988527f1e0316987be4678af1215",
  },
};

// Validator account that connectvalidator unlocks; its keystore ships in the
// archive root and must be copied into data/keystore.
const VALIDATOR_ACCOUNT = "45dc00282f80628911a15775cd821a3747d2c62e14e54d1339f057c9e921be71";

const DEVNET_DIR = path.resolve(
  process.env.QC_DEVNET_DIR || (IS_WINDOWS ? "C:\\devnet" : path.join(os.homedir(), "quantumcoin-devnet"))
);
const RELEASE = process.env.QC_DEVNET_RELEASE || "test-v2.0.74";
const RPC_URL = process.env.QC_RPC_URL || "http://127.0.0.1:18545";
const RPC_PORT = Number(new URL(RPC_URL).port || 18545);
const CHAIN_ID = Number(process.env.QC_CHAIN_ID || 123123);
const ASSET = `qc-release-${PLATFORM.tag}-devnet-${RELEASE}.${PLATFORM.ext}`;
const ASSET_URL = `https://github.com/quantumcoinproject/quantum-coin-go/releases/download/${RELEASE}/${ASSET}`;
const CACHE_DIR = path.join(DEVNET_DIR, ".cache");
const CACHE_PATH = path.join(CACHE_DIR, ASSET);
const MARKER_PATH = path.join(DEVNET_DIR, ".verified-sha256");

function expectedSha256() {
  const pinned = PINNED_SHA256[RELEASE] && PINNED_SHA256[RELEASE][PLATFORM.tag];
  const override = process.env.QC_DEVNET_SHA256;
  if (pinned && override && override.toLowerCase() !== pinned) {
    throw new Error(`QC_DEVNET_SHA256 does not match the hash pinned for ${ASSET}; refusing to install`);
  }
  const expected = (pinned || override || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(
      `no pinned sha256 for ${ASSET}; refusing to install. ` +
        "Pin it in scripts/devnet.js, or set QC_DEVNET_SHA256 to a hash you have verified."
    );
  }
  return expected;
}
// Resolved only when installing, so reusing a running node needs no pin.
let EXPECTED_SHA256;
let MARKER;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(method, params = [], timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

async function isRpcUp() {
  try {
    const chainIdHex = await rpc("eth_chainId");
    return Number(chainIdHex) === CHAIN_ID;
  } catch {
    return false;
  }
}

function findFile(dir, name, depth = 3) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".cache") continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

// Creates `dir` if needed and makes sure no other local user can write to it.
// Refuses a directory owned by someone else (for example one pre-created in a
// shared location), since its owner could swap files after verification.
// `forbidden` lists the permission bits to strip (0o022: group/other write).
function securePrivateDir(dir, forbidden) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (IS_WINDOWS) return;
  const stat = fs.statSync(dir);
  if (stat.uid !== process.getuid()) {
    throw new Error(`${dir} is not owned by the current user; refusing to use it`);
  }
  if (stat.mode & forbidden) fs.chmodSync(dir, stat.mode & 0o777 & ~forbidden);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

// Throws unless the buffer is exactly the pinned archive.
function verifyHash(buffer) {
  const actual = sha256(buffer);
  if (actual !== EXPECTED_SHA256) {
    throw new Error(`sha256 mismatch for ${ASSET}: expected ${EXPECTED_SHA256}, got ${actual}`);
  }
}

async function download() {
  console.log(`devnet: downloading ${ASSET_URL}`);
  const response = await fetch(ASSET_URL, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} for ${ASSET_URL}`);
  return Buffer.from(await response.arrayBuffer());
}

// Returns the verified archive bytes, from the private cache or the network.
// Nothing reaches disk until it has been verified.
async function getVerifiedArchive() {
  securePrivateDir(CACHE_DIR, 0o077);
  if (fs.existsSync(CACHE_PATH)) {
    const cached = fs.readFileSync(CACHE_PATH);
    try {
      verifyHash(cached);
      console.log(`devnet: reusing verified cached download ${CACHE_PATH}`);
      return cached;
    } catch (error) {
      console.warn(`devnet: deleting cached download that failed verification (${error.message})`);
      fs.rmSync(CACHE_PATH, { force: true });
    }
  }
  const buffer = await download();
  verifyHash(buffer);
  console.log("devnet: release hash verified");
  const partial = `${CACHE_PATH}.${process.pid}.partial`;
  fs.writeFileSync(partial, buffer, { mode: 0o600 });
  fs.renameSync(partial, CACHE_PATH);
  return buffer;
}

function extract(buffer) {
  console.log(`devnet: extracting to ${DEVNET_DIR}`);
  if (PLATFORM.ext === "zip") {
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath ${quote(CACHE_PATH)} -DestinationPath ${quote(DEVNET_DIR)} -Force`,
    ]);
  } else {
    // Extract the verified bytes from memory, so the file on disk is not re-read.
    execFileSync("tar", ["-xzf", "-", "-C", DEVNET_DIR], { input: buffer, maxBuffer: 64 * 1024 * 1024 });
  }
}

function initChain() {
  const dataDir = path.join(DEVNET_DIR, "data");
  if (!fs.existsSync(path.join(dataDir, "geth", "chaindata"))) {
    console.log("devnet: initializing chain from genesis.json");
    execFileSync(path.join(DEVNET_DIR, PLATFORM.binary), ["--datadir", "data", "init", "genesis.json"], {
      cwd: DEVNET_DIR,
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  const keystoreDir = path.join(dataDir, "keystore");
  const validatorKey = path.join(keystoreDir, VALIDATOR_ACCOUNT);
  if (!fs.existsSync(validatorKey)) {
    const source = path.join(DEVNET_DIR, VALIDATOR_ACCOUNT);
    if (!fs.existsSync(source)) throw new Error(`validator keystore ${VALIDATOR_ACCOUNT} not found in archive`);
    fs.mkdirSync(keystoreDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, validatorKey);
  }
}

async function ensureInstalled() {
  EXPECTED_SHA256 = expectedSha256();
  MARKER = `${EXPECTED_SHA256}  ${ASSET}\n`;
  securePrivateDir(DEVNET_DIR, 0o022);
  if (findFile(DEVNET_DIR, PLATFORM.binary, 0)) {
    const marker = fs.existsSync(MARKER_PATH) ? fs.readFileSync(MARKER_PATH, "utf8") : null;
    if (marker !== MARKER) {
      throw new Error(
        `${DEVNET_DIR} holds a devnet that this script did not install from the verified ${ASSET} ` +
          "(earlier versions of this script did not verify downloads). Delete that directory, or set " +
          "QC_DEVNET_DIR to an empty one, and run again."
      );
    }
    console.log(`devnet: already installed at ${DEVNET_DIR}`);
    initChain();
    return;
  }
  const buffer = await getVerifiedArchive();
  extract(buffer);
  securePrivateDir(DEVNET_DIR, 0o022); // tar applies the archive's own mode to the directory
  // If the archive has a single top-level folder (the Windows zip does), flatten it.
  if (!findFile(DEVNET_DIR, PLATFORM.binary, 0)) {
    const nested = findFile(DEVNET_DIR, PLATFORM.binary, 3);
    if (!nested) throw new Error(`${PLATFORM.binary} not found after extraction`);
    const nestedDir = path.dirname(nested);
    for (const entry of fs.readdirSync(nestedDir)) {
      fs.renameSync(path.join(nestedDir, entry), path.join(DEVNET_DIR, entry));
    }
    fs.rmdirSync(nestedDir);
  }
  if (!IS_WINDOWS) {
    for (const executable of ["dp", "dputil", "relay", "connectvalidator.sh"]) {
      const full = path.join(DEVNET_DIR, executable);
      if (fs.existsSync(full)) fs.chmodSync(full, 0o755);
    }
  }
  // Every file now comes from the verified archive. initChain is idempotent, so
  // a failed init is retried on the next run instead of blocking the install.
  fs.writeFileSync(MARKER_PATH, MARKER);
  initChain();
  console.log("devnet: installed");
}

function launchNode() {
  const logPath = path.join(DEVNET_DIR, "devnet-node.log");
  const logFd = fs.openSync(logPath, "a");
  let command;
  let args;
  if (IS_WINDOWS) {
    command = "powershell.exe";
    args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(DEVNET_DIR, "connectvalidator.ps1"),
      "-RpcPort",
      String(RPC_PORT),
    ];
  } else {
    command = "bash";
    args = [path.join(DEVNET_DIR, "connectvalidator.sh"), String(RPC_PORT)];
  }
  const child = spawn(command, args, {
    cwd: DEVNET_DIR,
    env: process.env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  console.log(`devnet: launched connectvalidator (pid ${child.pid}), log: ${logPath}`);
}

async function ensureRunning() {
  if (await isRpcUp()) {
    console.log(`devnet: RPC already up at ${RPC_URL}`);
    return;
  }
  launchNode();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await isRpcUp()) {
      console.log("devnet: RPC is up");
      return;
    }
    await sleep(2000);
  }
  throw new Error(
    `devnet RPC did not come up at ${RPC_URL} within 180s; see ${path.join(DEVNET_DIR, "devnet-node.log")}`
  );
}

async function main() {
  const command = process.argv[2] || "ensure";
  if (command === "install") {
    await ensureInstalled();
    return;
  }
  if (command !== "ensure") throw new Error(`unknown command: ${command}`);
  // A node already answering is reused as is: nothing is installed or run.
  if (await isRpcUp()) {
    console.log(`devnet: RPC already up at ${RPC_URL}; reusing it`);
    return;
  }
  await ensureInstalled();
  await ensureRunning();
  console.log("devnet: ready");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
