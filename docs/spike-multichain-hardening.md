# Spike: Multi-Chain Hardening — pre-0.6.0-stable Audit Fixes

**Status:** draft, awaiting review
**Author:** mayur + claude
**Branch base:** `feat/multi-chain-arb`
**Target release:** `@b402ai/sdk@0.6.0` stable, `b402-mcp@0.6.3` stable

## Context

After shipping `@b402ai/sdk@0.6.0-next` and `b402-mcp@0.6.0..0.6.2-next`, an early adopter successfully shielded + lent on Arbitrum. During bring-up we surfaced and fixed: chain-aware facilitator routing, RelayAdapt money-leak on input re-shielding, shield-cache cross-leak between Base and Arb, AA31 paymaster deposit, installer that didn't upgrade existing entries, version pinning that wrote `@latest` instead of own version.

Remaining defects from the post-fix audit are tracked here. **Goal: zero customer-impact bugs before flipping `@latest`.** TDD only — every fix has a failing test first.

## Ground rules for this spike

1. **No publish, no push, no merge** until every item below is green: `npm test` in SDK + MCP, `npm run build` in both, manual sanity on Arb mainnet for the integration items.
2. **Failing test first.** Every code change is paired with a regression test. If the test cannot meaningfully assert the fix (e.g. ERC-4337 internals), the spike notes that explicitly and proposes an alternate proof.
3. **No drive-by refactors.** Each commit corresponds to one item below. Reviewable in isolation, revertable in isolation.
4. **No new features.** Aave V3, multi-chain `private_swap`, multi-chain `cross_chain_privately`, and multi-chain `run_strategy` are deferred to follow-up PRs (issues #5 and below). This spike is purely defensive hardening of what already ships.

---

## Item-by-item plan

Each item: **claim** (what's wrong) → **evidence** (file:line) → **fix** (what to change) → **test plan** (TDD) → **risk** (what could break) → **rollout**.

---

### SEV1-A: Verify UserOp signing is chain-scoped — **VERIFIED PASS**

**Original claim:** UserOp hashes must mix `chainId`. Replay risk if not.

**Verification result (during spike implementation):** **No replay risk on the live SDK.**

The production code path is `b402.ts → fetch(facilitatorUrl + '/api/v1/wallet/incognito/verify')` → facilitator builds the UserOp + signs the paymaster server-side, then `b402.ts → fetch(facilitatorUrl + '/api/v1/wallet/incognito/settle')`. Each chain has its own facilitator deployment (`B402_CHAINS[chainId].facilitatorUrl`), with its own paymaster signer key and its own paymaster contract address. The successful Arb lend (tx `0x71d86c11…`) confirms the server-side path is correctly chain-scoped.

`src/wallet/userop-builder.ts` (`signPaymaster`, `computeUserOpHash`) and the modules that use them (`src/pipeline.ts`, `src/lend/lend-pipeline.ts`, `src/recipes/private-swap.ts`, `src/rebalance/rebalancer.ts`) are **not on the live path**. None are exported from `src/index.ts`; none are called by `B402.{shield,unshield,lend,redeem,privateLend,privateRedeem,privateSwap,…}`; none are imported from tests, examples, or the MCP package. They contain hardcoded Base assumptions (e.g. `BASE_CONTRACTS.PAYMASTER` at `userop-builder.ts:183,198`), but they never execute.

**Decision:** No live-path code change. Add a follow-up cleanup item to delete the dead modules in a separate PR (deferred — out of this spike's scope).

**Rollout:** No tests written, no code changed. Verified by call-graph audit.

---

### SEV1-B: `private-swap` recipe uses `BASE_TOKENS` — **DEFERRED (DEAD CODE)**

**Verification result:** `src/recipes/private-swap.ts` is dead code on the live path (only `connector.ts:12` references it via `import type` for `SwapDependencies` — type-only, no runtime call). Not exported from `src/index.ts`. Live `B402.privateSwap()` (`src/b402.ts:2452`) does not use this recipe class — it builds calls inline and forwards to the facilitator.

**Decision:** Defer. Bundled with the dead-code cleanup item. Not customer-impacting today.

---

### SEV1-C: `wallet-store` overwrites on `--key` import without backup

**Claim:** `packages/mcp/src/lib/wallet-store.ts:64` and `:122` write `wallet.json` unconditionally inside `deriveAndSave()`. If a user runs `npx b402-mcp --claude --key 0xWRONG_KEY`, we silently overwrite their existing wallet with no recovery path. Same class of bug we already saw in `b402-hyper`.

**Evidence:**
- `wallet-store.ts:122` (in `deriveAndSave`):
  ```ts
  ensureDir()
  writeFileSync(WALLET_FILE, JSON.stringify(config, null, 2))
  chmodSync(WALLET_FILE, 0o600)
  ```
- `index.ts:21`: `if (providedKey) { ... wallet = await importWallet(providedKey) }` — overwrite happens with no diff check, no backup, no confirmation.

**Fix:**
1. Before any write inside `deriveAndSave`, if `WALLET_FILE` already exists and the new privateKey differs from the existing one:
   - Refuse, unless `B402_FORCE_WALLET_RESET=1` env var is set.
   - When forced, write a timestamped backup `wallet.json.bak.<unix-ts>` first. Never reuse the same `.bak` filename — repeated overwrites must not destroy history.
2. If existing privateKey == new privateKey: no-op (idempotent re-install is fine).
3. Surface a loud banner in CLI that says exactly which wallet address is being loaded vs imported, before any overwrite.

**Test plan (TDD):**
1. `test/wallet-store/overwrite-safety.test.ts`:
   - Stub `homedir()` to a temp dir per test (use `vitest`'s `tmp` helper or `os.tmpdir()`).
   - `it('createWallet refuses when wallet.json exists with different key')` — write a stub wallet, call `createWallet`, assert throw with helpful message.
   - `it('importWallet is idempotent when key matches existing')` — write a stub wallet with key K, call `importWallet(K)`, assert no backup created, file unchanged.
   - `it('importWallet refuses when key differs and no force')` — write stub with K1, call `importWallet(K2)`, assert throw, original file intact.
   - `it('importWallet writes timestamped backup when forced')` — set env, call `importWallet(K2)`, assert `wallet.json.bak.<digits>` exists and matches original; new file matches K2.
   - `it('repeated forced overwrites preserve all backups')` — write K1, force-import K2, force-import K3, assert two `.bak.*` files exist with distinct contents.

**Risk:** Could break a user who today relies on `--key` to forcibly replace a wallet. Mitigation: env flag is documented in `--help` and CLI shows the exact env var name in the refusal message, so opting in is one-line.

**Rollout:**
- Bump `b402-mcp` to `0.6.3-next.0` after this lands.
- Document in CHANGELOG: "BREAKING: `--key` now refuses to overwrite a different existing wallet without `B402_FORCE_WALLET_RESET=1`."

---

### SEV2-A: McpServer version string drift

**Claim:** `packages/mcp/src/index.ts:129` hardcodes `version: '0.5.0'`, which the host reports to clients. Real package version is `0.6.2`. Not a bug — a customer-facing lie that confuses debugging.

**Evidence:** `packages/mcp/src/index.ts:129` literal `'0.5.0'`; `packages/mcp/package.json:3` says `"version": "0.6.2"`.

**Fix:**
- Read version from package.json at module load:
  ```ts
  import { readFileSync } from 'fs'
  import { fileURLToPath } from 'url'
  import { dirname, join } from 'path'
  const here = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  ```
  - Reuse the same approach already in `installer.ts:16-25` (`getOwnVersion()`). Promote it to a tiny `lib/version.ts` and use from both places.

**Test plan (TDD):**
1. `test/version-sync.test.ts`:
   - Read `packages/mcp/package.json` and the constant returned by `getOwnVersion()`.
   - Assert equal.
   - Assert `getOwnVersion()` returns a real semver string (regex `/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/`).

**Risk:** None. Build outputs `dist/` and we already do the same trick in installer; tested behavior.

**Rollout:** Bundled with SEV2-B Codex pinning (same file area).

---

### SEV2-B: Codex TOML installer hardcodes `@latest`

**Claim:** `packages/mcp/src/lib/installer.ts:163` writes `b402-mcp@latest` for Codex while every other client gets `b402-mcp@<own-version>`. Codex users always roll forward to whatever's on `latest` even if installed via `@next`.

**Evidence:**
```ts
const tomlEntry = `\n[mcp_servers.b402]\ncommand = "npx"\nargs = [ "-y", "b402-mcp@latest" ]\n`
```

**Fix:** swap the literal for `b402-mcp@${getOwnVersion()}`, matching the JSON-client behavior.

**Test plan (TDD):**
1. `test/installer/codex-pinning.test.ts`:
   - Stub `existsSync(codexConfig)` to true with empty file in tmpdir.
   - Run `installToAllClients()`.
   - Read the TOML, assert it contains `b402-mcp@<expected-version>` (mock `getOwnVersion()` or read from package.json).
   - Edge case: existing `[mcp_servers.b402]` block — assert it's left alone (matches current "already configured" behavior).

**Risk:** None. One-line change.

**Rollout:** Same PR as SEV2-A.

---

### SEV2-C: Chain-aware Odos aggregator (scope reduced)

**Claim:** `src/swap/dex-aggregator.ts:47` sends `chainId: 8453` literal to Odos. Called by live `B402.privateSwap()` at `src/b402.ts:2470` (currently gated by `requireBase`, but the hardcode is a footgun for when the gate is lifted). `src/swap/zero-x-provider.ts:21` is dead code (only used by `pipeline.ts`, which is itself dead) — defer with the dead-code cleanup item.

**Evidence:**
- `src/swap/dex-aggregator.ts:47` — `chainId: 8453` in Odos POST body
- `src/b402.ts:2470` — `await import('./swap/dex-aggregator')` is the only live caller

**Fix:**
1. Make `getAggregatorQuote` and `buildAggregatorSwapCalls` take `chainId: number` as required arg (no default).
2. Update the live caller at `b402.ts:2470` to pass `this.chainId`.
3. Skip ZeroXProvider for this spike — covered by future dead-code cleanup PR.

**Test plan (TDD):**
1. `test/swap/aggregator-chain.test.ts`:
   - Mock `fetch` (vitest `vi.spyOn(global, 'fetch')`).
   - Call `getAggregatorQuote(..., chainId=42161, ...)`, assert outgoing JSON body has `chainId: 42161`.
   - Same for `8453`.
2. Type-level: removing the default means all callers must pass — TS compile catches missing call sites.

**Risk:** Low — Odos has only one live caller. TS surfaces missing call sites at compile.

**Rollout:** Standalone commit.

---

### SEV2-D: Vault metrics fetch chain-aware

**Claim:** `src/b402.ts:1805` calls `fetchAllVaultMetrics(8453)` literal. `rebalance()` is gated by `requireBase()` so it doesn't break Arb today, but the `status()` path at line ~1709 already uses `this.chainId` — inconsistent. Also when we lift the rebalance gate, this is a footgun.

**Evidence:**
- `b402.ts:1709` (good): `fetchAllVaultMetrics(this.chainId)`
- `b402.ts:1805` (bad): `fetchAllVaultMetrics(8453)`

**Fix:** Replace `8453` with `this.chainId` at line 1805.

**Test plan (TDD):**
1. `test/lend/vault-metrics-chain.test.ts`:
   - Mock `fetchAllVaultMetrics`.
   - Construct `B402({ chainId: 42161, privateKey })`.
   - Trigger code path that calls metrics (or call internal helper directly if exposed) — assert mock was called with `42161`.
2. If `rebalance()` itself can't easily be exercised because of `requireBase()`: extract the metrics-fetch line into a private method `_fetchVaultMetricsForCurrentChain()` so it's directly testable.

**Risk:** None. One-line.

**Rollout:** Standalone commit.

---

### SEV3: Logger redact regex misses `seedPhrase`

**Claim:** `packages/mcp/src/lib/logger.ts` redact regex covers `private[_-]?key|mnemonic|signature|password|secret|api[_-]?key`. Doesn't cover `seedPhrase|seed_phrase|recoveryPhrase|recovery_phrase`. We don't use these names today, but tool authors might pass them through.

**Fix:** extend regex to:
```ts
/private[_-]?key|mnemonic|seed[_-]?phrase|recovery[_-]?phrase|signature|password|secret|api[_-]?key|^key$/i
```

**Test plan (TDD):**
1. `test/mcp/logger-redact.test.ts`:
   - Call internal `redact()` (export from `logger.ts` for testing) with `{ seedPhrase: 'foo bar baz' }`.
   - Assert returned value has `seedPhrase: '[redacted]'` (or whatever sentinel we use today).
   - Same for nested: `{ user: { recoveryPhrase: '...' } }`.
   - Already-covered keys still redact (regression check).

**Risk:** None.

**Rollout:** Standalone commit.

---

## Out of scope for this spike (deferred)

- Aave V3 lending on Arb (Issue #5)
- `private_swap` / `cross_chain_privately` / `run_strategy` multi-chain (separate PR; needs Aerodrome→Uniswap routing decision on Arb)
- `b402-hyper` wallet-write hardening (separate repo; latest `@b402ai/trader@0.2.3` already refuses to overwrite — recommend yanking 0.1.1–0.1.6 from npm to prevent fresh installs of vulnerable versions)
- Cron job to auto-refill Arb paymaster (separate infra ticket)
- `b402-arb-api` seeder cross-leak (separate repo; already mitigated at SDK cache level)
- "List all wallets / recover" CLI command (UX feature, separate PR)
- **Dead code cleanup**: `src/wallet/userop-builder.ts`, `src/pipeline.ts`, `src/lend/lend-pipeline.ts`, `src/recipes/private-swap.ts`, `src/recipes/base-recipe.ts`, `src/rebalance/rebalancer.ts`, `src/swap/zero-x-provider.ts` are unused on the live path (verified by call-graph audit during SEV1-A verification). They contain hardcoded Base assumptions that confuse future audits but never execute. Delete in a follow-up PR after stable-tag flip.

## Done criteria

- [ ] Every item above has a passing test that would fail without the fix.
- [ ] `npm run build` clean in SDK + MCP.
- [ ] `npm test` clean in SDK + MCP.
- [ ] Manual sanity: end-to-end shield + privateLend + privateRedeem on Arb mainnet from a fresh wallet using built-from-source `b402-mcp`. Tx hashes recorded.
- [ ] Version bumps: `@b402ai/sdk@0.6.0` (drop `-next`), `b402-mcp@0.6.3-next.0` (test on @next first, then promote to 0.6.3 stable).
- [ ] PR opened, reviewed, merged.
- [ ] Only after all the above: `npm publish` with `--tag latest` for both packages.
- [ ] CHANGELOG updated for both packages, breaking-change note for `--key` overwrite refusal.

## Order of operations

1. ~~SEV1-A (verify UserOp chain-scope)~~ — **VERIFIED PASS** by call-graph audit. Live path uses facilitator. No code change.
2. SEV1-C (wallet-store) — highest customer-impact, isolated module.
3. SEV2-A + SEV2-B (version + Codex installer) — trivial, in same MCP file area.
4. SEV3 (logger regex) — trivial, MCP only.
5. SEV2-C (Odos chainId, scope-reduced) — one-line fix + one test.
6. SEV2-D (vault metrics chain-aware) — last, smallest blast radius.
7. Final: build, test, manual mainnet sanity, version bump, PR, publish.
