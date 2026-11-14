// In-process EVM harness for the offline semantic checks. Needs no devnet.
//
// The production-settings bytecode runs in @ethereumjs/evm. Arithmetic,
// storage, hashing and CALL behave there as on the QuantumCoin EVM, and the
// compiler never masks addresses, so the 20-byte addresses this EVM assigns
// travel as full 32-byte words. That lets block.timestamp be driven across
// 2^32, which the devnet cannot do.

const path = require("node:path");
const { EVM } = require("@ethereumjs/evm");
const { Common, Chain, Hardfork } = require("@ethereumjs/common");
const { Account, Address, hexToBytes, bytesToHex, bytesToBigInt, utf8ToBytes } = require("@ethereumjs/util");
const { keccak256: keccakBytes } = require("ethereum-cryptography/keccak.js");

const qcSolc = require("../../scripts/qc-solc");

const ROOT = path.resolve(__dirname, "..", "..");
const MAX_UINT256 = 2n ** 256n - 1n;

function keccak256(hex) {
  return bytesToHex(keccakBytes(hexToBytes(hex)));
}

// A 32-byte word as 0x-prefixed lowercase hex.
function word(value) {
  if (typeof value === "bigint") return `0x${BigInt.asUintN(256, value).toString(16).padStart(64, "0")}`;
  if (typeof value === "boolean") return word(value ? 1n : 0n);
  if (value instanceof Address) return word(bytesToHex(value.bytes));
  const hex = String(value).toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{0,64}$/.test(hex)) throw new Error(`not a word: ${value}`);
  return `0x${hex.padStart(64, "0")}`;
}

// ABI-encodes arguments: Uint8Array is dynamic `bytes`, anything else a static word.
function encodeArgs(args) {
  const head = [];
  const tail = [];
  let tailOffset = 32n * BigInt(args.length);
  for (const arg of args) {
    if (arg instanceof Uint8Array) {
      head.push(word(tailOffset));
      const data = bytesToHex(arg).slice(2);
      const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
      tail.push(word(BigInt(arg.length)).slice(2) + padded);
      tailOffset += 32n + BigInt(padded.length / 2);
    } else {
      head.push(word(arg));
    }
  }
  return head.map((w) => w.slice(2)).join("") + tail.join("");
}

function selector(signature) {
  return keccak256(bytesToHex(utf8ToBytes(signature))).slice(0, 10);
}

function encodeCall(signature, args = []) {
  return selector(signature) + encodeArgs(args);
}

function words(bytes) {
  const hex = bytesToHex(bytes).slice(2);
  const out = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) out.push(BigInt(`0x${hex.slice(i, i + 64)}`));
  return out;
}

// Decodes Error(string) revert data; null if the data is not a reason string.
function revertReason(bytes) {
  const hex = bytesToHex(bytes);
  if (!hex.startsWith("0x08c379a0")) return null;
  const body = hexToBytes(`0x${hex.slice(10)}`);
  const [offset] = words(body.slice(0, 32));
  const length = Number(bytesToBigInt(body.slice(Number(offset), Number(offset) + 32)));
  const start = Number(offset) + 32;
  return Buffer.from(body.slice(start, start + length)).toString("utf8");
}

// Accounts in this EVM are 20 bytes; a call target given as a 32-byte word
// must therefore have its high 12 bytes clear.
function toEvmAddress(target) {
  if (target instanceof Address) return target;
  const hex = word(target);
  if (!hex.startsWith(`0x${"0".repeat(24)}`)) throw new Error(`cannot call a 32-byte-only address here: ${hex}`);
  return new Address(hexToBytes(`0x${hex.slice(26)}`));
}

const compiled = new Map();
function artifact(sourceRelative, contractName) {
  const key = `${sourceRelative}:${contractName}`;
  if (!compiled.has(key)) {
    const output = qcSolc.compile([path.join(ROOT, sourceRelative)]);
    compiled.set(key, qcSolc.getContract(output, contractName));
  }
  return compiled.get(key);
}

class Sandbox {
  static async create() {
    const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Istanbul });
    const sandbox = new Sandbox();
    sandbox.evm = await EVM.create({ common });
    sandbox.sender = new Address(hexToBytes(`0x${"11".repeat(20)}`));
    sandbox.timestamp = 1n; // block.timestamp for every following call
    sandbox.nonce = 0n;
    return sandbox;
  }

  // Same shape as @ethereumjs/evm's internal defaultBlock(), with our timestamp.
  _block() {
    return {
      header: {
        number: 1n,
        cliqueSigner: () => Address.zero(),
        coinbase: Address.zero(),
        timestamp: this.timestamp,
        difficulty: 0n,
        prevRandao: new Uint8Array(32),
        gasLimit: 30_000_000n,
        baseFeePerGas: undefined,
        getBlobGasPrice: () => undefined,
      },
    };
  }

  async _run(to, data) {
    const result = await this.evm.runCall({
      caller: this.sender,
      to: to === undefined ? undefined : toEvmAddress(to),
      data: hexToBytes(data),
      gasLimit: 30_000_000n,
      skipBalance: true,
      block: this._block(),
    });
    const { exceptionError, returnValue } = result.execResult;
    return {
      ok: !exceptionError,
      error: exceptionError ? exceptionError.error : null,
      reason: exceptionError ? revertReason(returnValue) : null,
      returnValue,
      createdAddress: result.createdAddress,
    };
  }

  async deploy(contract, args = []) {
    // runCall derives the CREATE address from (sender nonce - 1) and does not
    // bump the nonce itself, so give every deployment a fresh one.
    const account = (await this.evm.stateManager.getAccount(this.sender)) || new Account();
    account.nonce = ++this.nonce;
    await this.evm.stateManager.putAccount(this.sender, account);
    const result = await this._run(undefined, contract.bytecode + encodeArgs(args));
    if (!result.ok) throw new Error(`deployment failed: ${result.reason || result.error}`);
    return result.createdAddress;
  }

  // Executes a call; returns { ok, reason, returnValue, error } without throwing.
  async tryCall(target, signature, args = []) {
    return this._run(target, encodeCall(signature, args));
  }

  async tryRaw(target, data) {
    return this._run(target, data);
  }

  // Executes a call that must succeed; returns its return value as words.
  async call(target, signature, args = []) {
    const result = await this.tryCall(target, signature, args);
    if (!result.ok) throw new Error(`${signature} reverted: ${result.reason || result.error}`);
    return words(result.returnValue);
  }

  async storage(target, slot) {
    const value = await this.evm.stateManager.getContractStorage(toEvmAddress(target), hexToBytes(word(BigInt(slot))));
    return value.length === 0 ? 0n : bytesToBigInt(value);
  }
}

module.exports = {
  Sandbox,
  artifact,
  encodeCall,
  keccak256,
  revertReason,
  selector,
  word,
  words,
  MAX_UINT256,
};
