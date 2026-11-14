// Offline regression gate for the fork's load-bearing properties (audit
// QSV2-02; IDs refer to SECURITY_AUDIT.md "Fork-delta verification").
// Runs in an in-process EVM: `npm run test:offline`. No devnet needed.
// scripts/build-production.js refuses to build unless these pass.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { hexToBytes, bytesToHex, generateAddress2 } = require("@ethereumjs/util");

const qcSolc = require("../../scripts/qc-solc");
const { Sandbox, artifact, keccak256, selector, word, MAX_UINT256 } = require("./harness");

// Deployed QuantumCoin mainnet values (SECURITY.md, SECURITY_AUDIT.md). The
// contracts are immutable: if a deliberate source change moves these, update
// them in the same commit, knowing the result can no longer match mainnet.
const MAINNET_INIT_CODE_HASH = "0xe9e4e94e6b4834ef10a33a8aebea9f79595894ba19c1c706b7a80cbba5f34b69";
const MAINNET_FACTORY_RUNTIME_KECCAK = "0x99f0ba7ad7b13cef80e9b7ae4e23761fe2cef74b46b9b45bb03a7394a66f03bd";

const Q112 = 2n ** 112n;
const UINT112_MAX = Q112 - 1n;
const E18 = 10n ** 18n;
const EMPTY_BYTES = new Uint8Array(0);

const factoryArtifact = () => artifact("contracts/QuantumSwapV2Factory.sol", "QuantumSwapV2Factory");
const pairArtifact = () => artifact("contracts/QuantumSwapV2Factory.sol", "QuantumSwapV2Pair");
const erc20Artifact = () => artifact("contracts/test/ERC20.sol", "ERC20");
const probeArtifact = () => artifact("test/offline/SemanticsProbe.sol", "SemanticsProbe");

// A 32-byte address whose high 12 bytes are `high` and low 20 bytes are `low`.
function wideAddress(high, low) {
  return `0x${high.toString(16).padStart(24, "0")}${low.toString(16).padStart(40, "0")}`;
}

function getAmountOut(amountIn, reserveIn, reserveOut) {
  const amountInWithFee = amountIn * 997n;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
}

async function deployPair(sandbox, supply = 10_000n * E18) {
  const factory = await sandbox.deploy(factoryArtifact(), [sandbox.sender]);
  const tokenA = await sandbox.deploy(erc20Artifact(), [supply]);
  const tokenB = await sandbox.deploy(erc20Artifact(), [supply]);
  await sandbox.call(factory, "createPair(address,address)", [tokenA, tokenB]);
  const [pairWord] = await sandbox.call(factory, "getPair(address,address)", [tokenA, tokenB]);
  const pair = word(pairWord);
  const [token0Word] = await sandbox.call(pair, "token0()");
  const aIsToken0 = token0Word === BigInt(word(tokenA));
  return { factory, pair, token0: aIsToken0 ? tokenA : tokenB, token1: aIsToken0 ? tokenB : tokenA };
}

async function reserves(sandbox, pair) {
  const [reserve0, reserve1, blockTimestampLast] = await sandbox.call(pair, "getReserves()");
  return { reserve0, reserve1, blockTimestampLast };
}

async function cumulative(sandbox, pair) {
  const [price0] = await sandbox.call(pair, "price0CumulativeLast()");
  const [price1] = await sandbox.call(pair, "price1CumulativeLast()");
  return { price0, price1 };
}

test("compiler is the pinned @quantumcoin/solc release", () => {
  assert.equal(qcSolc.compilerVersion(), qcSolc.PINNED_COMPILER_VERSION);
});

test("build matches the deployed mainnet bytecode (factory runtime, INIT_CODE_HASH)", () => {
  assert.equal(keccak256(factoryArtifact().deployedBytecode), MAINNET_FACTORY_RUNTIME_KECCAK);
  assert.equal(keccak256(pairArtifact().bytecode), MAINNET_INIT_CODE_HASH);
});

test("compiler keeps unchecked arithmetic and full-width addresses (C1–C8)", async () => {
  const sandbox = await Sandbox.create();
  const probe = await sandbox.deploy(probeArtifact());
  const low = 0xabcdefn << 100n;
  const a = wideAddress(0x01n, low);
  const b = wideAddress(0x02n, low);

  // C1, C2
  assert.deepEqual(await sandbox.call(probe, "sub32(uint32,uint32)", [0n, 1n]), [0xffffffffn]);
  assert.deepEqual(await sandbox.call(probe, "add256(uint256,uint256)", [MAX_UINT256, 2n]), [1n]);

  // C3, C4: abi.encodePacked(address,address) is 64 bytes of raw words.
  const packed = await sandbox.tryCall(probe, "packAddresses(address,address)", [a, b]);
  assert.ok(packed.ok);
  const packedHex = bytesToHex(packed.returnValue).slice(2);
  assert.equal(BigInt(`0x${packedHex.slice(64, 128)}`), 64n, "packed length");
  assert.equal(`0x${packedHex.slice(128, 256)}`, a + b.slice(2));

  // C5: address(uint(bytes32)) keeps all 32 bytes.
  const full = `0x${"f1".repeat(32)}`;
  assert.deepEqual(await sandbox.call(probe, "toAddress(bytes32)", [full]), [BigInt(full)]);

  // C6, C7: == and < use all 256 bits.
  assert.deepEqual(await sandbox.call(probe, "eqAddress(address,address)", [a, b]), [0n]);
  assert.deepEqual(await sandbox.call(probe, "eqAddress(address,address)", [a, a]), [1n]);
  const smallHighBigLow = wideAddress(0x01n, 2n ** 160n - 1n);
  const bigHighSmallLow = wideAddress(0x02n, 1n);
  assert.deepEqual(await sandbox.call(probe, "ltAddress(address,address)", [smallHighBigLow, bigHighSmallLow]), [1n]);
  assert.deepEqual(await sandbox.call(probe, "ltAddress(address,address)", [bigHighSmallLow, smallHighBigLow]), [0n]);

  // C8: any 256-bit word decodes as an address, unmasked.
  assert.deepEqual(await sandbox.call(probe, "rawAddress(address)", [full]), [BigInt(full)]);
});

test("factory: INIT_CODE_HASH and the CREATE2 salt use full 32-byte addresses (F1–F4)", async () => {
  const sandbox = await Sandbox.create();
  const factory = await sandbox.deploy(factoryArtifact(), [sandbox.sender]);
  const pairInitCode = pairArtifact().bytecode;

  // F1
  const [initCodeHash] = await sandbox.call(factory, "INIT_CODE_HASH()");
  assert.equal(word(initCodeHash), keccak256(pairInitCode));

  // F3, F4: tokens equal in their low 20 bytes but different in the high 12.
  const low = 0x1234n << 120n;
  const tokenLow = wideAddress(0n, low);
  const tokenA = wideAddress(1n, low);
  const tokenB = wideAddress(2n, low);
  for (const [x, y] of [[tokenB, tokenA], [tokenA, tokenLow]]) {
    const created = await sandbox.tryCall(factory, "createPair(address,address)", [x, y]);
    assert.ok(created.ok, `createPair reverted: ${created.reason}`);
  }
  assert.deepEqual(await sandbox.call(factory, "allPairsLength()"), [2n]);

  const [pairAB] = await sandbox.call(factory, "getPair(address,address)", [tokenA, tokenB]);
  const [pairBA] = await sandbox.call(factory, "getPair(address,address)", [tokenB, tokenA]);
  const [pairLowA] = await sandbox.call(factory, "getPair(address,address)", [tokenLow, tokenA]);
  assert.equal(pairAB, pairBA);
  assert.notEqual(pairAB, pairLowA);

  // F2: salt == keccak256(token0[32] ‖ token1[32]); this EVM's CREATE2 yields 20-byte addresses.
  const salt = keccak256(tokenA + tokenB.slice(2));
  const factoryBytes = hexToBytes(word(factory)).slice(12);
  const expected = generateAddress2(factoryBytes, hexToBytes(salt), hexToBytes(pairInitCode));
  assert.equal(word(pairAB), word(bytesToHex(expected)));

  // The pair stores both tokens at full width, sorted on all 256 bits.
  const pair = word(pairAB);
  assert.deepEqual(await sandbox.call(pair, "token0()"), [BigInt(tokenA)]);
  assert.deepEqual(await sandbox.call(pair, "token1()"), [BigInt(tokenB)]);

  // Identical full-width addresses are still rejected.
  const same = await sandbox.tryCall(factory, "createPair(address,address)", [tokenA, tokenA]);
  assert.equal(same.reason, "QuantumSwapV2: IDENTICAL_ADDRESSES");
});

test("permit surface is absent and there is no fallback (P1–P5)", async () => {
  const sandbox = await Sandbox.create();
  const { pair } = await deployPair(sandbox);
  const owner = word(sandbox.sender);
  const calls = [
    ["permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", [owner, owner, 1n, MAX_UINT256, 27n, 1n, 1n]],
    ["DOMAIN_SEPARATOR()", []],
    ["PERMIT_TYPEHASH()", []],
    ["nonces(address)", [owner]],
  ];
  for (const [signature, args] of calls) {
    const result = await sandbox.tryCall(pair, signature, args);
    assert.equal(result.ok, false, `${signature} must revert`);
  }
  assert.equal((await sandbox.tryRaw(pair, "0x")).ok, false, "empty calldata must revert");
  assert.equal((await sandbox.tryRaw(pair, selector("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)"))).ok, false);
});

test("oracle survives the uint32 timestamp rollover; K holds after a second rollover (O1–O5a)", async () => {
  const sandbox = await Sandbox.create();
  const { pair, token0, token1 } = await deployPair(sandbox);
  const to = word(sandbox.sender);
  const amount0 = 1n * E18;
  const amount1 = 4n * E18;

  // O1: mint at T = 2^32 - 10.
  sandbox.timestamp = 2n ** 32n - 10n;
  await sandbox.call(token0, "transfer(address,uint256)", [pair, amount0]);
  await sandbox.call(token1, "transfer(address,uint256)", [pair, amount1]);
  await sandbox.call(pair, "mint(address)", [to]);
  assert.deepEqual(await reserves(sandbox, pair), {
    reserve0: amount0,
    reserve1: amount1,
    blockTimestampLast: 2n ** 32n - 10n,
  });

  // O2–O4: sync at T = 2^32 + 5 accrues exactly 15 s at the 1:4 price.
  sandbox.timestamp = 2n ** 32n + 5n;
  await sandbox.call(pair, "sync()");
  const price0 = (amount1 * Q112) / amount0;
  const price1 = (amount0 * Q112) / amount1;
  assert.equal(price0 * 15n, 311537811512089657711829779753205760n);
  assert.deepEqual(await cumulative(sandbox, pair), { price0: price0 * 15n, price1: price1 * 15n });
  assert.equal((await reserves(sandbox, pair)).blockTimestampLast, 5n);

  // INV-05: reserve0 ‖ reserve1 ‖ blockTimestampLast are packed in slot 6.
  assert.equal(await sandbox.storage(pair, 6), amount0 | (amount1 << 112n) | (5n << 224n));

  // O5, O5a: after a second rollover (2^33), a swap at the exact K boundary
  // succeeds and one more unit of output reverts.
  sandbox.timestamp = 2n ** 33n + 3n;
  const amountIn = 1n * E18;
  const amountOut = getAmountOut(amountIn, amount0, amount1);
  await sandbox.call(token0, "transfer(address,uint256)", [pair, amountIn]);
  const tooMuch = await sandbox.tryCall(pair, "swap(uint256,uint256,address,bytes)", [0n, amountOut + 1n, to, EMPTY_BYTES]);
  assert.equal(tooMuch.reason, "QuantumSwapV2: K");
  await sandbox.call(pair, "swap(uint256,uint256,address,bytes)", [0n, amountOut, to, EMPTY_BYTES]);

  const elapsed = 2n ** 32n - 2n; // (2^33 + 3) - (2^32 + 5)
  assert.deepEqual(await cumulative(sandbox, pair), {
    price0: price0 * (15n + elapsed),
    price1: price1 * (15n + elapsed),
  });
  assert.deepEqual(await reserves(sandbox, pair), {
    reserve0: amount0 + amountIn,
    reserve1: amount1 - amountOut,
    blockTimestampLast: 3n,
  });
});

test("no revert at the uint112 reserve ceiling with the largest single accrual (O6–O7)", async () => {
  const sandbox = await Sandbox.create();
  const { pair, token0, token1 } = await deployPair(sandbox, 2n ** 113n);
  sandbox.timestamp = 1000n;
  await sandbox.call(token0, "transfer(address,uint256)", [pair, UINT112_MAX]);
  await sandbox.call(token1, "transfer(address,uint256)", [pair, 1n]);
  await sandbox.call(pair, "mint(address)", [word(sandbox.sender)]);

  const elapsed = 2n ** 32n - 1n;
  sandbox.timestamp += elapsed;
  await sandbox.call(pair, "sync()");
  assert.deepEqual(await cumulative(sandbox, pair), {
    price0: BigInt.asUintN(256, (Q112 / UINT112_MAX) * elapsed),
    price1: BigInt.asUintN(256, UINT112_MAX * Q112 * elapsed),
  });
});
