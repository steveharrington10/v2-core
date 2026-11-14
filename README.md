# QuantumSwap V2 Core

Core contracts for the QuantumSwap V2 protocol on the QuantumCoin blockchain.

This is a modified fork of [Uniswap V2 core](https://github.com/Uniswap/v2-core) (GPL-3.0-or-later),
adapted for QuantumCoin: Solidity 0.7.6, 32-byte addresses, no `ecrecover`/permit.

# Local Development

The following assumes the use of `node@>=18`. Contracts are compiled with the
[`@quantumcoin/solc`](https://www.npmjs.com/package/@quantumcoin/solc) npm package
(QuantumCoin's Solidity 0.7.6 with 32-byte address support).

## Install Dependencies

`npm ci`

The compiler is pinned to exactly `@quantumcoin/solc@0.7.6`; `scripts/qc-solc.js` refuses to
compile with any other version.

## Compile Contracts

`npm run compile`

Production artifacts are built with `node scripts/build-production.js`, which pins compiler settings
(optimizer runs 999999, no metadata hash), generates Go bindings via `abigen2`
(default `C:\build\abigen2.exe`, override with `ABIGEN_PATH`), and writes a SHA-256 manifest.
It refuses to build unless the offline checks below pass.

## Run Tests

`npm run test:offline`

Runs in an in-process EVM, without a devnet. It checks the properties the contracts take from the
compiler fork (wrap-around arithmetic, full 32-byte addresses), the oracle across the uint32
timestamp rollover, the absence of `permit`, and that the build is byte-identical to the deployed
mainnet factory and pair.

`npm test`

Runs the offline checks, then the full suite against a local QuantumCoin devnet using the
`quantumcoin` SDK. The devnet is installed and started automatically by `scripts/devnet.js`
(Windows, macOS, and Ubuntu). It downloads the release's `qc-release-<platform>-devnet-<release>`
archive, refuses it unless its SHA-256 matches the hash pinned in the script, and initializes the
chain from the archive's `genesis.json`. A devnet installed by an earlier version of the script was
not verified; delete that directory (default `~/quantumcoin-devnet`, or `C:\devnet` on Windows) and
let the script reinstall it. Overrides: `QC_RPC_URL`, `QC_DEVNET_DIR`, `QC_KEYSTORE`,
`QC_KEY_PASSWORD`, and `QC_DEVNET_RELEASE` together with `QC_DEVNET_SHA256` for a release whose
hash is not pinned.

`npm run test:integration` additionally deploys the production artifacts from
`quantumswap-deploy` to the devnet and exercises the full add-liquidity/swap flow.
