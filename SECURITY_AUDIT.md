# Security Audit: Findings Index

This document records an internal security review of **v2-core**, the QuantumSwap V2 core
contracts (factory, pair and LP token). It covers the code this fork changed from Uniswap V2 for
QuantumCoin (Solidity 0.7.6, 32-byte addresses, no `ecrecover`/permit), the toolchain that builds
and tests it, and how the deployed contracts are used by the periphery router, the `quantumcoin`
JavaScript SDK, and the QuantumSwap web app.

The method follows the dual-axis approach of the
[circl security audit](https://github.com/quantumcoinproject/circl/blob/main/SECURITY_AUDIT.md).
Each finding has a **severity** (how bad the defect is in the code itself) and a separate
**reachability** (whether anyone can trigger it in practice).

## Contents

- [Summary](#summary)
- [Scope and method](#scope-and-method)
- [Methodology](#methodology)
- [**Findings**](#findings)
  - [QSV2-01: Devnet bootstrap fails open on hash verification, and checks the wrong files](#qsv2-01)
  - [QSV2-02: No executed regression gate for the fork's load-bearing properties](#qsv2-02)
- [**Remediation**](#remediation)
- [Fork-delta verification (no defect found)](#fork-delta-verification-no-defect-found)
- [Deployed contract verification (QuantumCoin mainnet)](#deployed-contract-verification-quantumcoin-mainnet)
- [External caller-side invariants](#external-caller-side-invariants)
- [Observations in consumers (outside this repository)](#observations-in-consumers-outside-this-repository)
- [Revisions assessed](#revisions-assessed)
- [Reproduction](#reproduction)
- [Status](#status)
- [Standards referenced](#standards-referenced)

## Summary

**No defect was found in contract logic.** The factory, pair and LP-token logic matches
upstream Uniswap V2 line for line. Every QuantumCoin-specific change was checked by executing
it, not just by reading it. The deployed mainnet factory and all 16 pairs are byte-identical to
this source built with the production settings.

**Update (2026-11-13).** Three results from the v2-periphery review (`SECURITY_AUDIT.md` in the
v2-periphery repository) are folded in here:
- The deployed router is byte-identical to its source, which closes this review's open
  "router: not compared" item ([deployed verification](#deployed-contract-verification-quantumcoin-mainnet)).
- QSV2-01 is wider than first reported. The hash check also compares against the wrong files, so
  `scripts/devnet.js` cannot complete a verified install on any platform. This was re-executed
  against this repository's copy of the script ([QSV2-01](#qsv2-01)).
- On QuantumCoin, a transaction's `block.timestamp` is the parent header time plus the block
  period, not the containing block's header time. INV-07 now records this
  ([invariants](#external-caller-side-invariants)).

**Two findings, both off-chain, both remediated on 2026-11-13** ([Remediation](#remediation)):

| ID | Title | Severity | Reachability | CWE | Status |
|:---|:---|:---|:---|:---|:---|
| [QSV2-01](#qsv2-01) | Devnet bootstrap fails open on hash verification and executes the unverified archive; the check also compares against the wrong files, so no platform can complete a verified install | Medium | Exploitable (conditional) | [CWE-636], [CWE-494] | Remediated |
| [QSV2-02](#qsv2-02) | No executed regression gate for the fork's load-bearing properties | Low | Not Reachable (assurance) | none applies | Remediated |

Neither finding permits loss, theft or freezing of liquidity-provider or trader funds.

Issues found in the SDK and the web app belong to those projects. They are recorded
[separately](#observations-in-consumers-outside-this-repository) so they can be filed with their
owners.

## Scope and method

**Reviewed.**
- `contracts/`: factory, pair, LP ERC-20, libraries and interfaces.
- `scripts/`: compile, production build and devnet bootstrap.
- `test/` and `.github/workflows/`.
- Every difference from upstream Uniswap V2 at `8b82b04`.

**Fork deltas.** The changes from upstream are:
- `pragma =0.7.6` and `override` specifiers, with events moved into the interfaces.
- `permit`, `DOMAIN_SEPARATOR`, `PERMIT_TYPEHASH` and `nonces` removed.
- The flash-swap callback renamed `uniswapV2Call` → `quantumSwapV2Call`.
- `INIT_CODE_HASH()` added to the factory.
- Interface getters changed from `pure` to `view`.

`_update`, `_mintFee`, `mint`, `burn`, `swap`, `skim`, `sync` and `createPair` are otherwise
unchanged. The 32-byte address width and the arithmetic semantics come from the compiler fork
(`@quantumcoin/solc`), not from the source, so they were verified against the compiler output.

**Consumers.** Reachability was assessed against:

- `v2-periphery`: `QuantumSwapV2Router02` and `QuantumSwapV2Library`.
- `quantumcoin` (quantumcoin.js) 8.0.2 and `quantum-coin-js-sdk` 2.1.1: the SDK used by this
  repository's tests and by integrators.
- The QuantumSwap web app at `app.quantumswap.com`, through its shipped bundle, and its route API
  at `api.quantumswap.com`.
- QuantumCoin mainnet (chain id 123123), through the public RPC.

**Verification standard.** Every finding and every "no defect" result below was confirmed by
executing code:
- production-settings bytecode run in an EVM;
- the SDK probed offline;
- this repository's own scripts run with every path redirected to a scratch directory;
- read-only `eth_call` / `eth_getCode` / `eth_getLogs` against mainnet.

Anything that could not be reproduced is not listed.

**Not performed.**
- The QuantumCoin devnet was not launched, and this repository's test suite was not run on one.
  `scripts/devnet.js` cannot install its pinned release on any platform ([QSV2-01](#qsv2-01)), and
  launching a devnet starts a validator. Node-side behaviour was checked on mainnet instead.
- This review did not compare the deployed router bytecode with source, because
  `@quantumcoin/solidity-lib` was not available at the time. The v2-periphery review has since
  done so: identical.
- The rendered web UI was not inspected. The browser extension was not connected; the app was
  analysed from its shipped JavaScript.
- The indexer behind `api.quantumswap.com` was not reviewed.

## Methodology

### Severity: the defect in the code itself

Judged independently of whether anything can reach it. The levels follow the recognition table in
[SECURITY.md](SECURITY.md), with circl's criterion for defects that silently void a control.

| Level | Criterion |
|---|---|
| **Critical** | Direct loss or permanent freezing of user funds, or a break of the constant-product or LP-accounting invariant, at a practical cost. |
| **High** | Temporary freezing of funds, or theft that needs unlikely user action. |
| **Medium** | Incorrect behaviour that harms users without direct loss of funds, **or** silently voids a security control the system depends on. |
| **Low** | No path to fund loss under any examined configuration: robustness, availability, assurance, defence in depth. |
| **Informational** | Documentation, conformance or structural observations with no security effect. |

### Reachability: exploitability through the consumers

| Level | Criterion | VEX status |
|---|---|---|
| **Exploitable** | An exploit path exists through a supported consumer or workflow. Conditions, if any, are stated. | `affected` |
| **Requires Caller-Side Invariant Violation** | Triggerable only if a consumer breaks an invariant in the [index](#external-caller-side-invariants). | `not_affected`, `inline_mitigations_already_exist`, while the invariant holds |
| **Not Reachable** | No supported path triggers it. The preventing property is named. | `not_affected` with a justification code |

The two-axis structure is standard practice in risk assessment ([SP 800-30r1], [OWASP Risk Rating
Methodology][owasp-rr], [CVSS v4.0][cvss4]). The reachability axis corresponds to VEX
([CSAF 2.0][csaf], [OpenVEX][openvex]). The severity levels are a house scale; they carry no
external authority.

### Governing rules

1. **Severity is never adjusted for reachability.** The two axes are independent; the pair of
   them is the triage state.
2. **Formal statements outrank labels.** Where a label and the stated mechanism seem to conflict,
   the mechanism governs.
3. **CWE is classification, not severity.** Where no CWE fits, the finding is left unclassified.

## Findings

<a id="qsv2-01"></a>
### QSV2-01: Devnet bootstrap fails open on hash verification and executes the unverified archive, and checks the wrong files

- **CWE Classification:** [CWE-636] Not Failing Securely ('Failing Open'); consequence [CWE-494] Download of Code Without Integrity Check
- **Location:**
  - `scripts/devnet.js:95-111` `verifyHash(archiveBuffer)`
  - `:132-139` cache reuse in `ensureInstalled()`
  - `:160-188` `launchNode()`
  - run by `npm test` and `npm run test:integration`
- **Axis 1: Technical Severity:** Medium. It silently voids the only integrity control in front of code execution.
- **Axis 2: Consumer Reachability:** Exploitable, conditionally (VEX `affected`). Two conditions must both hold:
  - (a) the attacker can create the cache file `os.tmpdir()/<release>-<asset>` before the first run. On Linux this is the world-writable `/tmp`. On macOS `$TMPDIR` is per-user, so another local user cannot.
  - (b) fetching the hash fails: the host is offline, rate-limited or gets a 5xx error, or `QC_DEVNET_RELEASE` names a release with no `releasehash-*` file.

  There is no on-chain impact.

**Technical Summary.** `verifyHash` catches every error and re-throws only those whose text
contains `"mismatch"`. Any failure to fetch or parse the hash file logs
`hash verification skipped`, and execution continues. `ensureInstalled` then extracts the archive,
and `launchNode` runs `connectvalidator.sh` from it. A cached archive in `os.tmpdir()` is trusted
for reuse on its filename alone. Even when the check succeeds, the hash comes from the same
GitHub release as the archive, so it detects corruption but not a tampered release.

**The check also compares against the wrong files.** Each release hash file describes the
`qc-release-<platform>-devnet-<release>` archive. The script downloads differently named assets,
which were uploaded separately (01:10–01:12 UTC, against 01:01–01:02 UTC for the `qc-release-…`
archives), have different contents, and are covered by no hash file. Hashes below are for
`test-v2.0.74`; GitHub's own asset digests agree with the hash files.

| Platform | Script downloads | Hash file describes | Result with the hash file reachable (executed) |
|:---|:---|:---|:---|
| Linux | `ubuntu-devnet.tar.gz` (`c7f2e650…`) | `qc-release-ubuntu-devnet-test-v2.0.74.tar.gz` (`2cf60b00…`) | `sha256 mismatch` on the genuine asset |
| Windows | `windows-devnet.zip` (`4a40fe6e…`) | `qc-release-windows-devnet-test-v2.0.74.zip` (`46335272…`) | `sha256 mismatch` on the genuine asset |
| macOS | `mac-devnet.tar.gz` | `qc-release-mac-devnet-test-v2.0.74.tar.gz` (`963edf1c…`) | HTTP 404: no such asset |

So no platform can complete a verified install of the pinned release. On Linux and Windows, the
script installs only when the hash fetch fails, which is the fail-open path. The download is
also written to `os.tmpdir()` before it is checked and is not removed after a mismatch, so every
later run reuses it and fails the same way (`reusing cached download`, then `sha256 mismatch`).

**Attack Vector & Execution Steps.**
1. The attacker plants `/tmp/test-v2.0.74-ubuntu-devnet.tar.gz`, containing `dp` and a malicious
   `connectvalidator.sh`.
2. A developer or CI job runs `npm test`. `ensureInstalled` finds no `dp` in `QC_DEVNET_DIR` and
   reuses the planted file (`:134-136`).
3. The hash fetch fails, so the script prints a warning and continues (`:109`).
4. `tar -xzf` extracts the archive and `chmod 755` is applied. `launchNode` then spawns
   `bash connectvalidator.sh` in the background, and the attacker's code runs as the developer.
   That account holds the devnet keystore, and the same workstation runs
   `scripts/build-production.js`, which writes the mainnet artifacts and Go bindings into
   `quantumswap-deploy`.

**Proof of Concept (PoC) Blueprint.** Executed against the unmodified script, with all paths in a
scratch directory.

```sh
P=$(mktemp -d); mkdir -p $P/payload $P/tmp $P/devnet
printf '#!/bin/sh\n' > $P/payload/dp
printf '#!/bin/sh\necho "PLANTED executed uid=$(id -u)" > %s/MARKER\n' "$P" > $P/payload/connectvalidator.sh
tar -czf $P/tmp/test-v2.0.74-mac-devnet.tar.gz -C $P/payload dp connectvalidator.sh   # ubuntu-devnet.tar.gz on Linux
TMPDIR=$P/tmp QC_DEVNET_DIR=$P/devnet QC_RPC_URL=http://127.0.0.1:18599 \
  NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9 node scripts/devnet.js ensure   # stop it after "launched"
cat $P/MARKER
```

Observed:

```
devnet: reusing cached download …/tmp/test-v2.0.74-mac-devnet.tar.gz
devnet: hash verification skipped (fetch failed)
devnet: extracting to …/devnet
devnet: installed
devnet: launched connectvalidator (pid 46732), log: …/devnet/devnet-node.log
PLANTED connectvalidator.sh executed: uid=501 args=18599
```

Control, with the hash reachable (no proxy):
`Error: sha256 mismatch: expected 963edf1c32bb98253eb957a92106d733917f5101b60164491cdcc93ac5015906, got af313c7a…`.
The payload was not executed.

Wrong-file check, executed against this repository's unmodified `scripts/devnet.js` on
2026-11-13 (byte-identical to the v2-periphery copy). The genuine release assets were cached in a
scratch directory. A preload set `process.platform`, and the RPC check pointed at a live node so
nothing could be launched:

```
linux:  devnet: reusing cached download …/tmp/test-v2.0.74-ubuntu-devnet.tar.gz
        Error: sha256 mismatch: expected 2cf60b00e8728adca311a57169b3b93279fd246211e690405df539d1e1f46e8e, got c7f2e650a477dcdd9ad1d26901c0763ef57d9bb7c0b611d6e6835edf91bce8f1
win32:  devnet: reusing cached download …/tmp/test-v2.0.74-windows-devnet.zip
        Error: sha256 mismatch: expected 463352720C851E6D5DD58051B65F0D739E9C988527F1E0316987BE4678AF1215, got 4a40fe6ed5b0e1b0f4da9a1cdccf1a0bfe165bcb64ba8b937bf1743e17e3b611
```

**Remediation.** Download the archive the hashes describe, pin its hash in the repository, and
fail closed on any error:

```js
// scripts/devnet.js
const PLATFORMS = {
  win32:  { tag: "windows", ext: "zip",    binary: "dp.exe" },
  darwin: { tag: "mac",     ext: "tar.gz", binary: "dp" },
  linux:  { tag: "ubuntu",  ext: "tar.gz", binary: "dp" },
};
const ASSET = `qc-release-${PLATFORM.tag}-devnet-${RELEASE}.${PLATFORM.ext}`;
const PINNED_SHA256 = {
  "test-v2.0.74": {
    mac:     "963edf1c32bb98253eb957a92106d733917f5101b60164491cdcc93ac5015906",
    ubuntu:  "2cf60b00e8728adca311a57169b3b93279fd246211e690405df539d1e1f46e8e",
    windows: "463352720c851e6d5dd58051b65f0d739e9c988527f1e0316987be4678af1215",
  },
};
function verifyHash(buf) {
  const expected = PINNED_SHA256[RELEASE]?.[PLATFORM.tag];
  if (!expected) throw new Error(`no pinned sha256 for ${RELEASE}/${PLATFORM.tag}; refusing to install`);
  const actual = require("node:crypto").createHash("sha256").update(buf).digest("hex");
  if (actual !== expected) throw new Error(`sha256 mismatch: expected ${expected}, got ${actual}`);
}
// Cache inside the private devnet directory (mode 0o700), never os.tmpdir():
const archivePath = path.join(DEVNET_DIR, ".cache", ASSET);
```

Verify the downloaded buffer before writing it anywhere, verify again before reusing any cached
file, and delete a cached file that fails. Apply the change to both copies (here and
`v2-periphery`) at once, or move the script into a shared package so the copies cannot drift.

---

<a id="qsv2-02"></a>
### QSV2-02: No executed regression gate for the fork's load-bearing properties

- **CWE Classification:** none applies (governing rule 3).
- **Location:**
  - `.github/workflows/CI.yml:13,36-37`
  - `test/helpers.js:142-165` `expectRevert(promise, reasonSubstring)`
  - `test/pair.test.js:108,139`
  - commit `f398afa`, which deleted the `wrappingSubtract` assertion
- **Axis 1: Technical Severity:** Low.
- **Axis 2: Consumer Reachability:** Not Reachable (VEX `not_affected` /
  `vulnerable_code_not_in_execute_path`). Test and CI code are never deployed. This is an
  assurance item. The contracts are immutable, and [SECURITY.md](SECURITY.md) says a defect is
  fixed only by redeploying and migrating liquidity, so the pre-deployment test gate is the main
  control.

**Technical Summary.** Three verified gaps compound one another.

1. **CI never reaches the tests.** It runs `yarn lint`, but there is no such script
   (`npm error Missing script: "lint"`). It runs on Node 10/12, while the suite needs Node 18 or
   later (`node:` imports, `node --test`, the `engines` field). There is no `yarn.lock`, and the
   workflow has not changed since 2020-04-20 (`1d9785e`).
2. **Nothing pins the compiler-dependent properties.** Wrap-around arithmetic in `_update` and
   full-width addresses come from the compiler fork. The only test that pinned them was deleted
   in `f398afa`. The devnet cannot mine blocks at chosen timestamps, so the uint32 rollover cannot
   be tested there at all. Commits `cfd7dd7` ("the compiler checks subtraction") and `f398afa`
   ("the compiler wraps natively") made opposite claims, and neither was settled by an executed
   test. This review confirmed that `f398afa` is correct
   (see [Fork-delta verification](#fork-delta-verification-no-defect-found)).
3. **`expectRevert` is too permissive.** It treats any rejection whose message lacks "revert" as
   the expected revert, and it matches the expected reason as a bare substring.

   Results of calling `expectRevert(…, "K")`:

   | Error passed in | Result |
   |:---|:---|
   | `invalid address (argument="address")` (thrown client-side; nothing was sent) | accepted |
   | `out of gas` | accepted |
   | `execution reverted: QuantumSwapV2: LOCKED` (contains a "K") | accepted |
   | `execution reverted: QuantumSwapV2: INSUFFICIENT_INPUT_AMOUNT` | rejected (correct) |

**Attack Vector & Execution Steps.** This is a regression path, not an attacker path.
1. A compiler release inside `^0.7.6`, or a source change, alters wrap-around arithmetic,
   address width or a revert path. 0.7.7 is already published; its output is byte-identical
   today.
2. CI does not run. Locally, the negative K-boundary cases pass on any client-side error, and no
   test covers the rollover.
3. `scripts/build-production.js` builds the artifacts, and they are deployed immutably.

**Proof of Concept (PoC) Blueprint.** The checks in
[Fork-delta verification](#fork-delta-verification-no-defect-found) run offline in an EVM, with
no devnet. As committed tests:

```js
// test/offline/semantics.test.js — node --test; needs @ethereumjs/evm, no devnet
test("uint32 rollover: mint @2^32-10, sync @2^32+5 accrues exactly 15 s", ...);  // O1–O5a
test("addresses are never masked to 160 bits", ...);                             // C5–C8, F3–F4
test("INIT_CODE_HASH() == keccak256(Pair creationCode)", ...);                   // F1–F2
test("permit surface absent; no fallback", ...);                                  // P1–P5
```

**Remediation.**
1. Replace `CI.yml`: Node 20/22, then `npm ci`, `npm run compile`, `node --test test/offline/`,
   and the devnet suite on `ubuntu-latest`.
2. Commit the offline checks. Make `scripts/build-production.js` refuse to run unless they pass
   and `compilerVersion()` equals a pinned value. Pin `"@quantumcoin/solc": "0.7.6"` exactly,
   not with a caret.
3. `expectRevert`: require an on-chain revert (an error matching `/revert/i`, or a failed
   receipt), and compare the full reason (`"QuantumSwapV2: K"`) exactly.

## Remediation

Both findings were fixed on 2026-11-13, on top of `29ab87e`. Each fix was verified by executing
it, to the same standard as the findings.

### QSV2-01

**Change** (`scripts/devnet.js`):
- The script downloads only `qc-release-<platform>-devnet-<release>`, the archive the release hash
  files describe, and checks it against a SHA-256 pinned in the script for all three platforms.
  It never fetches a hash at run time.
- Every failure is fatal: no pin, mismatch, or download error. A release without a pin needs an
  explicit `QC_DEVNET_SHA256`, which may not contradict a pin.
- The archive is verified in memory before it is written. It is cached in `<devnet dir>/.cache`
  (mode 0700), not `os.tmpdir()`, and re-verified before reuse. A cached file that fails is
  deleted. On POSIX, a devnet or cache directory owned by another user is refused, and
  group/other write bits are stripped.
- The hashed archive has no pre-built `data/` directory. The script therefore initializes the chain
  exactly as upstream's `devnet-data-creator-*` workflows build the unhashed `*-devnet` assets:
  `dp --datadir data init genesis.json`, then the validator keystore is copied into
  `data/keystore`. The resulting genesis hash, `f26399..b73d5f`, matches upstream's devnet log.
  This also makes macOS installable, since `mac-devnet.tar.gz` was never published.
- A `.verified-sha256` record is written after a verified install. An existing install without a
  matching record is refused, because every install made by the earlier script on Linux or Windows
  went through the fail-open path.
- If a node already answers on `QC_RPC_URL` with the expected chain id, `ensure` reuses it and
  neither installs nor runs anything. A pin is needed only when the script installs.

**Verified (executed, all paths in scratch directories):**

| Case | Result |
|:---|:---|
| Audit PoC: archive planted in `$TMPDIR`, network blocked | download fails, exit 1; `$TMPDIR` never read; payload not executed |
| Archive planted in the private cache, network blocked | deleted on `sha256 mismatch`, then download fails; payload not executed |
| Unpinned release; override contradicting the pin | refused before any download |
| Existing install with no verification record | refused; payload not executed |
| Genuine macOS archive | verified, extracted, chain initialized, recorded; second run reuses it |
| Genuine Linux and Windows archives (platform spoofed) | verified, where the old script got `sha256 mismatch` |

The copy of `scripts/devnet.js` in `v2-periphery` is not changed by this remediation and needs the
same change.

### QSV2-02

**Change:**
1. `.github/workflows/CI.yml` was replaced. An offline job runs on Node 20 and 22 (`npm ci`,
   `npm run compile`, `npm run test:offline`), then a devnet job runs `npm test` on
   `ubuntu-latest`.
2. `test/offline/` holds the fork-delta checks as committed tests in an in-process EVM. They cover
   C1–C8 (via `SemanticsProbe.sol`), F1–F4, P1–P5, O1–O7 and the slot-6 reserve packing (INV-05).
   They also pin the build to the deployed mainnet bytecode: factory runtime keccak `0x99f0ba7a…`
   (re-checked against `eth_getCode`: identical) and `INIT_CODE_HASH` `0xe9e4e94e…`.
   `scripts/build-production.js` refuses to build unless they pass. `scripts/qc-solc.js` refuses
   to compile with anything but `0.7.6+commit.6da11747.mod.Emscripten.clang`. `package.json` pins
   `@quantumcoin/solc` to `0.7.6` exactly, and the EVM packages exactly.
3. `expectRevert` accepts only a node-reported revert. That means `execution reverted`,
   `CALL_EXCEPTION` or `Error(string)` revert data, or a failed receipt with no reason expected. It
   compares the full reason exactly. Every call site passes the full reason, for example
   `"QuantumSwapV2: K"` and `"ds-math-sub-underflow"`. `test/offline/expect-revert.test.js` pins
   the behaviour, using errors built with quantumcoin.js's own `makeError`.

**Verified (executed):**
- `npm run test:offline`: 13/13 pass.
- Mutations of a scratch copy each fail the gate, both on the bytecode pin and on the targeted
  semantic test. The mutations were: checked timestamp subtraction in `_update`, which fails
  O1–O7; a 0.2% fee, which fails O5a; and an added `fallback`, which fails P1–P5. With the
  mutated contracts, `build-production.js` exits 1 before compiling anything.
- A compiler reporting `0.7.7` is refused by `qc-solc.js`.
- Run against the original `expectRevert` from `29ab87e`, the self-test fails on exactly the
  audit's three permissive cases: client-side errors, a reason that contains the expected text,
  and an unreadable reason.

## Fork-delta verification (no defect found)

The production-settings bytecode (`@quantumcoin/solc` 0.7.6, optimizer runs 999999,
`bytecodeHash: none`) was executed in an EVM. Arithmetic, storage, hashing and `CALL` behave the
same there as on the QuantumCoin EVM. The compiler never masks addresses, so 20-byte EVM
addresses travel as full 32-byte words. **25/25 checks pass.**

| ID | Property | Result | Why it matters |
|:---|:---|:---|:---|
| C1 | `uint32` subtraction wraps (`0 − 1`) | `0xffffffff` | `_update` timestamp delta. Settles `cfd7dd7` vs `f398afa` in favour of `f398afa`. |
| C2 | `uint256 +=` wraps (`MAX + 2`) | `1` | `price{0,1}CumulativeLast` |
| C3, C4 | `abi.encodePacked(address,address)` | 64 bytes of raw, unmasked words | CREATE2 salt in `createPair` |
| C5 | `address(uint(bytes32))` | keeps all 32 bytes | periphery `pairFor` |
| C6, C7 | address `==` and `<` | use all 256 bits | `createPair` identity check and token sorting |
| C8 | ABI decoding of `address` | any 256-bit word accepted, no masking | No padding exists to validate (see INV-01). |
| F1 | `INIT_CODE_HASH()` == keccak256(Pair creation code) | `0xe9e4e94e6b4834ef10a33a8aebea9f79595894ba19c1c706b7a80cbba5f34b69` | The periphery reads the hash from the factory, so the two cannot drift apart. |
| F2 | CREATE2 salt == keccak256(token0[32] ‖ token1[32]) | match | |
| F3, F4 | Tokens equal in their low 20 bytes but different in the high 12 | distinct pairs, no `IDENTICAL_ADDRESSES` | no 160-bit truncation |
| P1–P5 | `permit`, `DOMAIN_SEPARATOR`, `PERMIT_TYPEHASH`, `nonces`, empty calldata | all revert | No silent-fallback "phantom permit" (the WETH/Multichain bug class). |
| O1–O4 | `mint` at T = 2³²−10, then `sync` at T = 2³²+5 | elapsed time 15 s; `price0CumulativeLast` exact (`311537811512089657711829779753205760`); `blockTimestampLast` = 5 | The oracle survives the uint32 rollover on 2106-02-07 06:28:16 UTC. |
| O5, O5a | Swap after a second rollover (2³³) at the exact K boundary | succeeds; `out + 1` reverts with `QuantumSwapV2: K` | |
| O6, O7 | Pair at the uint112 ceiling; the largest single accrual (elapsed 2³²−1 s, price ≈ 2²⁰⁴) | no revert | |
| — | `@quantumcoin/solc` 0.7.7 (what `^0.7.6` resolves to today) vs 0.7.6 | factory, pair and probe bytecode identical | no compiler drift today |

**Pair storage layout** (from the compiler's `storageLayout` output):
- 0 `totalSupply`, 1 `balanceOf`, 2 `allowance`
- 3 `factory`, 4 `token0`, 5 `token1`
- 6 `reserve0` ‖ `reserve1` ‖ `blockTimestampLast`
- 7 `price0CumulativeLast`, 8 `price1CumulativeLast`, 9 `kLast`, 10 `unlocked`

The reserves moved from upstream slot 8 to slot 6 because the permit state was removed. Packing
is otherwise unchanged; addresses never shared a slot upstream either.

## Deployed contract verification (QuantumCoin mainnet)

Read-only checks against `https://public.rpc.quantumcoinapi.com` (chain id 123123) at block
5036827 (2026-11-10T18:18:12Z), for the deployment listed in [SECURITY.md](SECURITY.md).

| Check | Result |
|:---|:---|
| Factory `0x95085766…a99754` runtime vs. this source (0.7.6, production settings) | **identical** |
| `INIT_CODE_HASH()` | `0xe9e4e94e…5f34b69`; matches |
| `allPairsLength()` | 16 |
| All 16 pairs: runtime vs. this source | **16/16 identical** |
| All 16 pairs: address == keccak256(0xff ‖ factory ‖ salt ‖ INIT_CODE_HASH), all 32 bytes kept | **16/16**. Node-side CREATE2 keeps the full width. |
| All 16 pairs: `getPair(token1, token0)` == pair | 16/16 |
| WQ/HSN pair storage slot 6, low 112 bits == `reserve0` | match |
| WQ/HSN `blockTimestampLast` | `1788119598` (2026-08-30T19:53:18Z), i.e. seconds |
| `permit(…)` on a live pair | reverts |
| `feeTo()` / `feeToSetter()` | both `0x0`. The protocol fee is permanently off, and `setFeeTo`/`setFeeToSetter` can never be called successfully. |
| Router `0xc3666584…5d861e` `factory()` / `WETH()` | this factory / WQ `0x45bd01be…c44d92` |
| Router exposes `removeLiquidityWithPermit` | no |
| Router runtime vs. source | **identical** (18,385 bytes; `factory` and `WETH` immutables spliced at their 49 reference sites). Compared by the v2-periphery review at block 5039588 (2026-11-11T06:41:30Z). |

**Router allowance scope.** All ten `transferFrom` call sites in
`v2-periphery/contracts/QuantumSwapV2Router02.sol` pull from `msg.sender`. An allowance granted
to the router can therefore only be spent by its owner's own transactions. The v2-periphery review
has since confirmed that the deployed router is byte-identical to that source, so the conclusion
holds for the deployed router.

## External caller-side invariants

These are properties the core contracts rely on but cannot check themselves. Each "Status"
records what was verified and where.

| Invariant ID | Component/Contract | Required External Behavior / Guardrail | Consequence if Broken |
| :--- | :--- | :--- | :--- |
| INV-01 | Pair `burn(to)`, `swap(…,to,…)`, `skim(to)`; Router `to` | Clients must reject any recipient that is not exactly 32 bytes, and must never left-pad one. The contract cannot check: any 256-bit word is a valid address (C8). **Status:** holds in the web app, which requires `^0x[0-9a-fA-F]{64}$` and strips control and bidi characters. **Partially broken** in quantumcoin@8.0.2 ([C-02](#c-02)). | Output is sent to an address whose top 12 bytes are zero. No QuantumCoin key derives one (≈2⁻⁹⁶), so the funds are permanently lost. |
| INV-02 | Pair `Sync(uint112,uint112)` | Indexers and UIs must decode logs against the exact ABI types. **Status:** broken in quantumcoin@8.0.2 ([C-01](#c-01)). The web app takes reserves from its route API and from router quotes; the indexer itself was not reviewed. | Event-driven reserve tracking fails or goes quiet, and prices are quoted from stale reserves. |
| INV-03 | Pair `mint` / `burn` / `swap` | Delivering the input and making the low-level call must happen in one transaction (Router or contract). With permit gone, withdrawing LP is `approve` followed by `Router.removeLiquidity`. It must never be "send LP to the pair" followed by `burn` in a later transaction. **Status:** holds in the web app: every write it makes goes to the router or to a token `approve`, and the bundle never calls the pair directly. | Anyone can call `burn(attacker)`, `skim` or `swap` and take the stranded LP tokens or tokens. |
| INV-04 | Pair address derivation | Pair = keccak256(0xff ‖ factory[32] ‖ keccak256(token0[32] ‖ token1[32]) ‖ INIT_CODE_HASH), all 32 bytes kept, with `INIT_CODE_HASH` read from the factory and never copied from Uniswap's `0x96e8ac42…`. **Status:** verified on mainnet 16/16. The periphery reads the hash from the factory; the web app uses `getPair`. | Trades route to an empty address, and tokens sent there outside an atomic router call cannot be recovered. |
| INV-05 | Pair storage (anything reading raw `eth_getStorageAt`) | Use this fork's layout: reserves at slot 6, `price0CumulativeLast` at 7, `price1CumulativeLast` at 8, `kLast` at 9. Upstream tooling reads reserves from slot 8. **Status:** layout confirmed on mainnet. | Tools ported from Ethereum read `price1CumulativeLast` as the reserves, which means wrong prices and bad arbitrage or liquidation decisions. |
| INV-06 | Toolchain (`@quantumcoin/solc`) | The compiler must keep 0.7.x unchecked arithmetic and full-width addresses (C1–C8). **Status:** holds for 0.7.6 and 0.7.7, and the mainnet bytecode matches the 0.7.6 build. However, `^0.7.6` admits future releases, and the build does not assert the version ([QSV2-02](#qsv2-02)). | Under checked subtraction, every pair's `_update` reverts once the uint32 timestamp wraps (2106-02-07 06:28:16 UTC), freezing swap, mint, burn and sync with no admin path to recover. |
| INV-07 | Pair `_update` (QuantumCoin node) | `block.timestamp` is in seconds and never decreases. The wrap-around math works with any unit, but periphery and consumer TWAP windows assume seconds. On QuantumCoin, a transaction runs with `block.timestamp` = parent header time + the block period (6 s on mainnet), **not** the containing block's header time; the two agree only when the block is on schedule. Off-chain code must therefore never compare `blockTimestampLast` with header timestamps. **Status:** seconds and increasing, verified on mainnet. The clock offset was measured by the v2-periphery review: 3 of the 14 funded pairs' current `blockTimestampLast` lag the header of the block holding their last `Sync` by 48–84 s, each exactly parent + 6 s, and 770 of 3,000 recent blocks (5052450–5055450) were late, with a maximum interval of 348 s. This repository's cumulative-price test reads only on-chain timestamps and is unaffected. The v2-periphery sliding-window oracle test was not (v2-periphery review, QSV2P-02 item 4). | TWAP windows are off by the unit factor, and oracle consumers mis-price. Off-chain code that mixes the two clocks computes wrong elapsed times, and router deadlines are honoured up to the block's delay past their header time. |
| INV-08 | Factory `createPair` (listed tokens) | Inherited from upstream: tokens should be plain ERC-20s, with no fee-on-transfer, rebasing or transfer hooks. Pairs can be created for any address, including non-contracts (F3/F4). **Status:** the default-listed HSN and Y2Q tokens (byte-identical code) burn 0.1% on every transfer; this was observed in all 11 HSN swaps. The web app routes them through the `…SupportingFeeOnTransferTokens` router functions. Pair accounting measures balances, so K holds. | Reserves and balances drift, K accounting skews, and token hooks can re-enter other contracts. |

The commonly cited invariant "the RPC must reject invalidly padded 32-byte addresses" does not
apply. A 32-byte address has no padding bits (C8), so nothing can be invalidly padded. The real
hazard is the reverse, short inputs being widened by a client, which INV-01 covers.

## Observations in consumers (outside this repository)

These defects belong to the SDK and the web app, not to v2-core. Severity uses the scale above.
Each item was reproduced. File them with their owners.

### quantumcoin.js 8.0.2

<a id="c-01"></a>
**C-01: `Sync(uint112,uint112)` cannot be decoded (Low).**
- `Interface.parseLog` matches topic0
  `0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1` correctly.
- It then calls `decodeEventLog` against an ABI normalized to `uint256`, which expects topic
  `0xcf2aa508…149848a`.
- It throws `DecodeEventLog: first topic does not match event signature for 'Sync'`.
- `Swap`, `Mint` and `Burn` decode correctly, and `getReserves()` output decodes correctly.
- This repository already works around it in `test/helpers.js:33-69`.

<a id="c-02"></a>
**C-02: Encoding by fragment left-pads short addresses (Medium).**
- `encodeFunctionData("burn", ["0x" + "ab".repeat(20)])` is rejected (`invalid address`). This
  is the name path, which `Contract` method calls use.
- `encodeFunctionData(iface.getFunction("burn"), [same])` returns
  `0x89afcb44000000000000000000000000abab…ab`. A 1-byte `0x01` likewise becomes address `0x00…01`.
- The same unvalidated encoder handles every function with tuple or nested-array arguments
  (`needsJsAbi`).
- Loading this repository's `test/helpers.js` sends **every** encode, including name-based ones,
  down this path. This was verified before and after loading it. The helper is test-only and is
  not published (`package.json` `files`).

### QuantumSwap web app (`app.quantumswap.com`, bundle `index-B2v-1s0P.js`) and route API

**C-03: No price-impact indicator (Medium).**
- The bundle contains no price-impact computation or warning.
- The 0.5% default slippage bounds movement relative to the quote, not the quote's distance from
  spot.
- Live router quotes, HSN → cat → Y2Q: 8.2% impact at 10 HSN, 45.5% at 100 HSN, 89.2% at
  1000 HSN.
- HSN → Q: 0.31% at 100 HSN, 2.37% at 100M HSN, 17.7% at 1B HSN.

**C-04: The quote ignores token transfer fees (Low).**
- The minimum output is `quote × (1 − slippage)`, where the quote comes from
  `router.getAmountsOut`, which does not know about transfer fees.
- For HSN (0.1% burn), users receive 0.08–0.20% less than shown. That is within the 0.5% default,
  so these swaps succeed.
- A token whose fee exceeds the slippage setting reverts (fails closed).

**C-05: The route API mislabels fee-on-transfer tokens (Low).**
- `api.quantumswap.com/swap/v1/quantumswap-beta2/token/<HSN|Y2Q>` returns
  `feeOnTransfer: false, feeBpsObserved: null`.
- On-chain, the burn appears on every HSN swap. It is emitted as a separate `Transfer` from the
  sender to `0x0`, so a detector that compares only the transfer into the pair with
  `Swap.amountIn` would miss it.
- The app's built-in list overrides the flag for HSN and Y2Q. Fee tokens imported through search
  are mislabeled, but exact-output swaps are simulated first and fall back to exact-input
  (fails closed).

**C-06: The offline fallback picks an empty pair (Low).**
- When the route API returns nothing, `La()` accepts the direct pair as soon as `getPair` returns
  non-zero.
- HSN/Y2Q `0xa8ad6907…c91b121d8` exists but was never funded (reserves 0, LP supply 0). The
  router reverts on it with `INSUFFICIENT_LIQUIDITY`.
- The user gets "no route" even though HSN → cat → Y2Q is liquid (fails closed).

**C-07: Unlimited router approval (Informational).** The app approves `MaxUint256` to the
router. This is standard Uniswap V2 practice and bounded by the router's
`transferFrom(msg.sender, …)` pattern (see [above](#deployed-contract-verification-quantumcoin-mainnet)).

### Explorer and listings (`quantumscan.com/dex/quantumswap-beta2`)

**C-08: Display and listing noise (Informational).**
- The DEX summary shows "Liquidity (Q) 0", while the WQ/HSN pair alone holds 106,000,025 WQ.
- The token listed as "Uniswap V2 (UNI-V2)" (`0x7bbbcb6a…961bb29`) is a plain ERC-20 with zero
  supply (1893 bytes, no pair interface), not a pair.
- Some symbols collide or impersonate other assets: a `QDAY/QDAY` pair made of two different
  tokens, and `WBTC`/`WETH` tokens that are not the Ethereum assets.

## Revisions assessed

Every "Not Reachable" verdict and every invariant status applies to these exact revisions, and
must be re-checked when any of them changes.

| Component | Revision | Notes |
|:---|:---|:---|
| `v2-core` (this repo) | `29ab87e6e5d332f9665f7e6163503f9d328136a9` | clean tree apart from this document |
| `v2-periphery` | `779aedc` | deployed router byte-identical to this source (v2-periphery review) |
| `@quantumcoin/solc` | 0.7.6 (`sha512-voV0/84e…bH/VA==`, matches `package-lock.json`) and 0.7.7 | identical output |
| `quantumcoin` / `quantum-coin-js-sdk` | 8.0.2 / 2.1.1 | as pinned in `package-lock.json` |
| Web app bundle | `assets/index-B2v-1s0P.js` (138,781 bytes), fetched 2026-11-10 | |
| Route API | `quantumswap-beta2`, `indexedBlock` 5036851–5039491, `lagBlocks` 0 | |
| QuantumCoin mainnet | blocks 5036827–5039491, 2026-11-10 | chain id 123123 |
| QuantumCoin mainnet (block clock, via the v2-periphery review) | blocks 5052450–5055457, 2026-11-13T16:46Z – 2026-11-14T06:24Z | INV-07 clock offset |
| Devnet release | `test-v2.0.74` | no platform could complete a verified install ([QSV2-01](#qsv2-01)); after remediation, all three `qc-release-…-devnet` archives verify against the pinned hashes |

## Reproduction

The harness scripts used for this review are not committed with this document. Each item below
states what to execute.

**Fork-delta checks (C, F, P, O).**
1. Install the pinned compiler and an EVM, with install scripts disabled:
   `npm i --ignore-scripts @quantumcoin/solc@0.7.6 @ethereumjs/evm@3.1.1 @ethereumjs/util@9.1.0 @ethereumjs/common@4.4.0`
2. Compile `contracts/QuantumSwapV2Factory.sol` and `contracts/test/ERC20.sol` with the settings
   in `scripts/qc-solc.js`, adding `storageLayout` to `outputSelection`.
3. Deploy them in the EVM, then drive the block timestamp across 2³² and 2³³ as described in the
   table above.

**Compiler drift.** Repeat step 2 with `@quantumcoin/solc@0.7.7` and compare the `bytecode`
fields.

**QSV2-01.**
- Fail-open: run the PoC block above from the repository root. For the control, remove the two
  proxy variables.
- Wrong files: in a scratch directory, preload
  `Object.defineProperty(process, "platform", { value: process.env.FAKE_PLATFORM })` and run
  `FAKE_PLATFORM=linux TMPDIR=<scratch>/tmp/ QC_DEVNET_DIR=<scratch>/devnet QC_RPC_URL=<a live RPC> node -r <preload> scripts/devnet.js ensure`.
  For Windows, use `FAKE_PLATFORM=win32` and also set `TEMP=<scratch>/tmp`. Pointing the RPC check
  at a live node stops the script from launching anything if verification ever passed.
- Compare each release's `releasehash-<platform>-devnet-<release>.txt` with GitHub's asset digests
  (`GET /repos/quantumcoinproject/quantum-coin-go/releases/tags/<release>`).

**INV-07 clock.** For each pair, compare `getReserves().blockTimestampLast` with the header
timestamps of the block holding the pair's last `Sync` log and of that block's parent.

**QSV2-02.**
- `npm run lint` shows the missing script.
- `expectRevert`: load `test/helpers.js` and pass it the rejected promises from the table.

**Mainnet.** Runtime comparison and key getters:

```sh
RPC=https://public.rpc.quantumcoinapi.com
F=0x95085766e20fcbf0106dc7037020ca069e22080dbef2615551bab65d59a99754
q() { curl -s -X POST $RPC -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; echo; }
q eth_call "[{\"to\":\"$F\",\"data\":\"0x257671f5\"},\"latest\"]"   # INIT_CODE_HASH()
q eth_call "[{\"to\":\"$F\",\"data\":\"0x094b7415\"},\"latest\"]"   # feeToSetter()
q eth_call "[{\"to\":\"$F\",\"data\":\"0x574f2ba3\"},\"latest\"]"   # allPairsLength()
q eth_getCode "[\"$F\",\"latest\"]"   # compare with evm.deployedBytecode of QuantumSwapV2Factory
```

**SDK (C-01, C-02).** `Initialize(new Config(123123, …))` loads embedded WASM only, with no
network access. Build `new qc.Interface(pairAbi)`, then:
- call `parseLog` on a `Sync` log;
- call `encodeFunctionData` with a 20-byte address, once by name and once by fragment.

## Status

| | |
|:---|:---|
| Open findings | 0. QSV2-01 (Medium) and QSV2-02 (Low) were remediated on 2026-11-13 ([Remediation](#remediation)). The `v2-periphery` copy of `scripts/devnet.js` still needs the QSV2-01 change. |
| Defects in contract logic | 0 |
| Findings enabling loss, theft or freezing of funds | 0 |
| Requiring emergency action | 0 |
| Deployed bytecode matches audited source | factory: yes; pairs: 16/16; router: yes (v2-periphery review) |
| Invariants verified on mainnet | INV-04, INV-05, INV-07 |
| Invariants broken in a consumer | INV-01 (SDK, partial), INV-02 (SDK); INV-07's clock rule in the v2-periphery oracle test |
| Consumer observations to file upstream | C-01, C-02 (quantumcoin.js); C-03 to C-06 (web app and API) |
| To raise with the QuantumCoin project | the INV-07 clock behaviour; devnet release assets with no matching hash file (QSV2-01) |

Last verified by execution against `v2-core@29ab87e` on 2026-11-10. Updated on 2026-11-13 with the
v2-periphery review's results: the router bytecode comparison, the QSV2-01 wrong-file check
(re-executed against this repository's script), and the INV-07 clock measurements.

## Standards referenced

- [CWE] — MITRE Common Weakness Enumeration, used for classification only.
- [SP 800-30r1] — *Guide for Conducting Risk Assessments*, Rev. 1: separate likelihood and impact scales.
- [OWASP Risk Rating Methodology][owasp-rr] — likelihood × impact with explicit factors.
- [CVSS v4.0][cvss4] — separates the Exploitability and Impact metric groups.
- [OASIS CSAF 2.0][csaf] and [OpenVEX][openvex] — VEX, the standardized form of the reachability axis.
- [EIP-1014] — `CREATE2`; QuantumCoin keeps all 32 bytes of the hash.
- [EIP-2612] — `permit`, removed in this fork.
- [Uniswap V2 Core][uni-v2] — upstream source (`8b82b04`); oracle wrap-around and the `MINIMUM_LIQUIDITY` design inherited here.

[CWE]: https://cwe.mitre.org/
[CWE-494]: https://cwe.mitre.org/data/definitions/494.html
[CWE-636]: https://cwe.mitre.org/data/definitions/636.html
[SP 800-30r1]: https://doi.org/10.6028/NIST.SP.800-30r1
[owasp-rr]: https://owasp.org/www-community/OWASP_Risk_Rating_Methodology
[cvss4]: https://www.first.org/cvss/v4.0/specification-document
[csaf]: https://docs.oasis-open.org/csaf/csaf/v2.0/csaf-v2.0.html
[openvex]: https://github.com/openvex/spec
[EIP-1014]: https://eips.ethereum.org/EIPS/eip-1014
[EIP-2612]: https://eips.ethereum.org/EIPS/eip-2612
[uni-v2]: https://github.com/Uniswap/v2-core
