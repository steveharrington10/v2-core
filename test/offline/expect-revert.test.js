// expectRevert must accept only an on-chain revert with exactly the expected
// reason (audit QSV2-02 item 3). Errors are built with quantumcoin.js's own
// makeError, in the shape its JsonRpcProvider throws for a JSON-RPC error.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { qc, expectRevert } = require("../helpers");

function encodeErrorString(reason) {
  const bytes = Buffer.from(reason, "utf8");
  const length = bytes.length.toString(16).padStart(64, "0");
  const padded = bytes.toString("hex").padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return `0x08c379a0${"20".padStart(64, "0")}${length}${padded}`;
}

function rpcError(message, data) {
  const error = { code: 3, message };
  if (data !== undefined) error.data = data;
  return qc.makeError("JSON-RPC error", "UNKNOWN_ERROR", { method: "eth_call", error });
}

function revertWith(reason) {
  return rpcError(`execution reverted: ${reason}`, encodeErrorString(reason));
}

const rejected = (error) => Promise.reject(error);
const minedWithStatus = (status) => Promise.resolve({ wait: async () => ({ status }) });

const K = "QuantumSwapV2: K";

test("rejects errors that are not on-chain reverts", async () => {
  const notReverts = [
    qc.makeError("invalid address", "INVALID_ARGUMENT", { argument: "address", value: "0x01" }),
    rpcError("out of gas"),
    qc.makeError("JSON-RPC request timeout", "UNKNOWN_ERROR", { method: "eth_call", url: "http://127.0.0.1:18545" }),
    new Error("fetch failed"),
  ];
  for (const error of notReverts) {
    await assert.rejects(expectRevert(rejected(error), K), assert.AssertionError, error.message);
    await assert.rejects(expectRevert(rejected(error)), assert.AssertionError, error.message);
  }
});

test("rejects a revert with a different reason, even one containing the expected text", async () => {
  for (const reason of ["QuantumSwapV2: LOCKED", "QuantumSwapV2: INSUFFICIENT_INPUT_AMOUNT", "QuantumSwapV2: KK"]) {
    await assert.rejects(expectRevert(rejected(revertWith(reason)), K), assert.AssertionError, reason);
    await assert.rejects(expectRevert(rejected(rpcError(`execution reverted: ${reason}`)), K), assert.AssertionError);
  }
});

test("rejects a revert whose reason cannot be read when one is expected", async () => {
  await assert.rejects(expectRevert(rejected(rpcError("execution reverted")), K), assert.AssertionError);
  await assert.rejects(expectRevert(minedWithStatus(0), K), assert.AssertionError);
});

test("rejects success", async () => {
  await assert.rejects(expectRevert(Promise.resolve("0x"), K), assert.AssertionError);
  await assert.rejects(expectRevert(minedWithStatus(1)), assert.AssertionError);
});

test("accepts a revert with exactly the expected reason", async () => {
  await expectRevert(rejected(revertWith(K)), K);
  await expectRevert(rejected(rpcError(`execution reverted: ${K}`)), K); // reason in the message only
  await expectRevert(rejected(rpcError("execution reverted", encodeErrorString(K))), K); // revert data only
  await expectRevert(rejected(revertWith("ds-math-sub-underflow")), "ds-math-sub-underflow");
});

test("accepts any on-chain revert when no reason is given", async () => {
  await expectRevert(rejected(rpcError("execution reverted")));
  await expectRevert(rejected(qc.makeError("call reverted", "CALL_EXCEPTION", {})));
  await expectRevert(minedWithStatus(0));
});
