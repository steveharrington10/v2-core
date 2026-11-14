// Shared wrapper around the @quantumcoin/solc npm package (solc-js build of
// QuantumCoin's 32-byte-address Solidity 0.7.6 compiler). Replaces the native
// solc.exe invocations; output is byte-identical with the same settings
// (optimizer runs 999999, no metadata hash).

const fs = require("node:fs");
const path = require("node:path");
const solc = require("@quantumcoin/solc");

// The deployed mainnet bytecode was built with exactly this compiler. Other
// releases may change wrap-around arithmetic or address width (the core
// contracts depend on both), so nothing is compiled with any other version.
const PINNED_COMPILER_VERSION = "0.7.6+commit.6da11747.mod.Emscripten.clang";

function assertPinnedCompiler() {
  const actual = solc.version();
  if (actual !== PINNED_COMPILER_VERSION) {
    throw new Error(
      `@quantumcoin/solc ${actual} is not the pinned compiler ${PINNED_COMPILER_VERSION}; run npm ci`
    );
  }
}

function toSourceName(filePath) {
  return path.resolve(filePath).split(path.sep).join("/");
}

// solc passes import paths after applying settings.remappings and resolving
// relative imports against the importer's source unit name. Because source
// unit names are absolute paths (and remapping targets are too), the resolved
// path can be read directly from disk.
function importCallback(importPath) {
  try {
    return { contents: fs.readFileSync(importPath, "utf8") };
  } catch {
    return { error: `File not found: ${importPath}` };
  }
}

/**
 * Compile one or more source files.
 * @param {string[]} sourcePaths absolute or repo-relative .sol paths
 * @param {string[]} remappings e.g. ["@quantumswap/v2-core=C:/github/quantumswap/v2-core"]
 * @returns standard-JSON output (with errors already checked)
 */
function compile(sourcePaths, remappings = []) {
  assertPinnedCompiler();
  const sources = {};
  for (const sourcePath of sourcePaths) {
    sources[toSourceName(sourcePath)] = { content: fs.readFileSync(sourcePath, "utf8") };
  }
  const input = {
    language: "Solidity",
    sources,
    settings: {
      remappings: remappings.map((r) => r.split(path.sep).join("/")),
      optimizer: { enabled: true, runs: 999999 },
      metadata: { bytecodeHash: "none" },
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: importCallback }));
  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.formattedMessage || e.message).join("\n"));
  }
  return output;
}

/** Find a contract by name anywhere in a compile output. */
function getContract(output, contractName) {
  for (const file of Object.keys(output.contracts || {})) {
    const contract = output.contracts[file][contractName];
    if (contract) {
      return {
        abi: contract.abi,
        bytecode: `0x${contract.evm.bytecode.object}`,
        deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
      };
    }
  }
  throw new Error(`solc output missing contract ${contractName}`);
}

/**
 * Compile and return a single { abi, bytecode } artifact.
 */
function compileContract(sourcePath, contractName, remappings = [], extraSources = []) {
  const output = compile([sourcePath, ...extraSources], remappings);
  return getContract(output, contractName);
}

/**
 * Write NAME.abi / NAME.bin / NAME.bin-runtime files for every compiled
 * contract (mirrors `solc --bin --bin-runtime --abi -o <dir>`).
 * @returns {string[]} names of the contracts written
 */
function writeArtifacts(output, outDir, onlyNames = null) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const file of Object.keys(output.contracts || {})) {
    for (const [name, contract] of Object.entries(output.contracts[file])) {
      if (onlyNames && !onlyNames.includes(name)) continue;
      if (!contract.evm || !contract.evm.bytecode || contract.evm.bytecode.object === "") continue; // skip interfaces/abstract
      fs.writeFileSync(path.join(outDir, `${name}.abi`), JSON.stringify(contract.abi));
      fs.writeFileSync(path.join(outDir, `${name}.bin`), contract.evm.bytecode.object);
      fs.writeFileSync(path.join(outDir, `${name}.bin-runtime`), contract.evm.deployedBytecode.object);
      written.push(name);
    }
  }
  return written;
}

function compilerVersion() {
  return solc.version();
}

module.exports = {
  PINNED_COMPILER_VERSION,
  assertPinnedCompiler,
  compile,
  getContract,
  compileContract,
  writeArtifacts,
  compilerVersion,
};
