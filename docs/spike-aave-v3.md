# Spike: Private Aave V3 Lending in b402-sdk

Adds private supply/withdraw against Aave V3 on Base + Arbitrum, alongside the existing Morpho ERC-4626 path. Aave V3 Arb USDC market currently holds ~$1B+ TVL versus ~$30M for Morpho — material for any downstream private-DeFi rebalancer.

## 1. API shape — pick (b), generalize `privateLend`

Three options were evaluated:

- **(a) New `privateAaveSupply` / `privateAaveWithdraw`** — duplicates orchestration code, leaks protocol naming into the public surface. Rejected.
- **(b) Generalize `privateLend({ protocol: 'morpho' | 'aave' })`** — single method, registry-driven. **Pick this.** Defaults `protocol: 'morpho'` to preserve the existing call sites verbatim.
- **(c) Low-level `privatePoolAction(calldata[], shieldTokens[])`** — too footgunny for SDK consumers; keep as an internal we already have (`executeCrossContractCall`) and wrap it.

Call site stays nearly identical; the only new thing is `protocol` plus `market`/`asset` semantics. `vault` becomes `market` for Aave (vault doesn't fit a single-asset Pool).

```ts
// existing call still works:
await b402.privateLend({ token: 'USDC', amount: '0.5', vault: 'steakhouse' })

// new:
await b402.privateLend({
  token: 'USDC', amount: '0.5',
  protocol: 'aave', market: 'usdc',   // resolves to Aave V3 Pool + aUSDC
})
await b402.privateRedeem({ protocol: 'aave', market: 'usdc' })
```

Internally, a `LendAdapter` interface (`buildSupplyCalls`, `buildWithdrawCalls`, `receiptToken`, `previewWithdraw`) lets us add Compound, Fluid, etc., without touching `executeCrossContractCall`.

## 2. Aave V3 contract addresses

Sourced from `bgd-labs/aave-address-book` (the canonical Aave registry, updated by Aave devs):
- Base: <https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Base.sol>
- Arb: <https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Arbitrum.sol>

| Chain | Pool | aUSDC | Underlying USDC |
|---|---|---|---|
| Base (8453) | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Arb (42161) | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0x724dc807b04555b71ed48a6896b6F41593b8C637` (native USDCn) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |

Use **native USDC on Arb only** — never USDC.e (its aToken is being deprecated and routes through the legacy market).

## 3. Rebasing aToken — the load-bearing question

**Confirmed from Railgun engine source** (`node_modules/@railgun-community/engine/.../relay-adapt-helper.js:21` and the deployed RelayAdapt contract): when a shield request has `value=0`, the contract executes `token.balanceOf(address(this))` at shield-call time and shields that snapshot.

What that means for an Aave aToken:

1. RelayAdapt calls `Pool.supply(USDC, x, RelayAdapt, 0)`. Pool mints `~x` aUSDC to RelayAdapt (1:1 modulo liquidityIndex rounding).
2. The shield call snapshots `aUSDC.balanceOf(RelayAdapt)` — this captures aToken at that block, including any micro-rebase that already happened in-block.
3. Railgun then `transferFrom(RelayAdapt -> RailgunVault, snapshotAmount)`. Now the **RailgunVault** holds the aToken.
4. Future interest accrues on `aUSDC.balanceOf(RailgunVault)`. The vault's balance grows; **the user's UTXO `value` field is fixed**.

**The interest is not lost** — it accrues to the vault holding the aToken — but it is **not credited to any specific UTXO**. Two consequences:

- **Withdraw must use `type(uint256).max`** (Aave's documented "withdraw entire aToken balance" sentinel — see <https://aave.com/docs/developers/smart-contracts/pool>). Combined with `value=0` shield-back of underlying USDC, the user reclaims principal + accrued interest in one shot, regardless of how the UTXO `value` was recorded.
- **However, after unshield, RelayAdapt only holds the UTXO's recorded `value` of aToken.** Any rebase delta accrued *to the vault between shield and the user's later unshield* stays stranded in the vault — it does not flow back via this UTXO.

So: **interest accrues to the pool, not to the user's UTXO.** This is a real economic leak, not a wash. Two viable mitigations:

- **(MVP)** Document it. For typical hold times (hours-days) on USDC at ~5% APY, the leak is sub-bps and acceptable. Make it visible: print "Note: rebase interest while shielded accrues to the pool."
- **(v2)** Add a periodic `harvest()` routine that, prover-side, mints a "rebase delta" UTXO to the user proportionally to their share of total aToken supply in the pool. This is non-trivial — requires an off-chain accountant and is essentially what Yearn's privacy fork does. Out of scope for this PR.

**Recommendation: ship MVP with documented leak. It's still strictly better than no Aave access.**

## 4. Supply call shape (confirmed correct)

```
[
  USDC.approve(Pool, amount),
  Pool.supply(USDC, amount, RelayAdapt, 0),
  RelayAdapt.shield([{ token: aUSDC, value: 0 }])   // sweeps full aUSDC balance
]
```

Gotchas:
- **Pool.supply does NOT explicitly revert on `amount==0`** per the docs, but `ValidationLogic.validateSupply` does revert with `INVALID_AMOUNT` (Aave V3 source — `protocol-v3/.../ValidationLogic.sol`). Guard at SDK layer.
- **Allowance must be exact-or-greater** — standard ERC-20. Reset to `0` first is *not* required for USDC on Base/Arb (the original USDT footgun doesn't apply).
- **Reserve frozen / paused / supply cap** reverts with `RESERVE_FROZEN` / `RESERVE_PAUSED` / `SUPPLY_CAP_EXCEEDED`. Pre-flight via `Pool.getReserveData(asset)` to surface a clean error before paying for the ZK proof.
- **eMode is per-account**. RelayAdapt is the supplier of record; we never call `setUserEMode`, so the account stays in the default category. No interaction. Safe.

## 5. Withdraw call shape

```
[
  Pool.withdraw(USDC, MAX_UINT256, RelayAdapt),    // sweeps all aUSDC -> USDC
  RelayAdapt.shield([{ token: USDC, value: 0 }])
]
```

Confirmed:
- **No aToken approve** — Aave burns aToken from `msg.sender` (= RelayAdapt) directly. This is the killer feature here vs ERC-4626's `redeem(shares, receiver, owner)` pattern.
- **`MAX_UINT256` sentinel is documented** ("Use type(uint).max to withdraw the entire aToken balance" — Aave Pool docs). Captures any same-block rebase delta on RelayAdapt.

Gotchas:
- **Liquidity** — withdraw can revert `NOT_ENOUGH_AVAILABLE_USER_BALANCE` if utilization spikes. Surface a clean error.
- **Health factor** — irrelevant here (we never borrow), but the SDK should still hard-reject any future borrow ops on the same RelayAdapt.
- **Unshield input** — we unshield the aToken UTXO (decimals match underlying = 6 for aUSDC). `previewWithdraw` is just `aUSDC.balanceOf(utxo.value-equivalent)` since aToken is 1:1 quoted in underlying.

## 6. Smallest PR

Files to **add**:
- `src/lend/aave-v3.ts` — `AAVE_V3_BY_CHAIN`, `AAVE_POOL_INTERFACE`, `resolveAaveMarket()`. ~60 LOC.
- `src/lend/adapter.ts` — `LendAdapter` interface + `MorphoAdapter` + `AaveV3Adapter`. ~120 LOC.
- `test/lend-aave.test.ts` — registry + adapter unit tests. ~60 LOC.

Files to **modify**:
- `src/b402.ts` — `privateLend` / `privateRedeem` route through adapter; add `protocol` / `market` to params. ~40 LOC delta.
- `src/lend/morpho-vaults.ts` — re-export under adapter shim. ~5 LOC.
- `skills/b402-sdk/SKILL.md`, `CLAUDE.md` — document new param. ~10 LOC.

**Total: ~300 LOC, one PR.** No changes to `relay-adapt.ts`, `executeCrossContractCall`, or proof pipeline.

## 7. Gotchas that could blow up

1. **Rebase interest leak** (§3) — economic, not safety. Document loudly.
2. **Arb RelayAdapt zero-balance shield revert** — our Arb fork reverts on zero-balance shields (per `b402.ts:2896-2899` comment). For Aave, the input USDC is fully consumed by `Pool.supply`, so the auto-add input-token shield must stay disabled on Arb. Already handled — but write a regression test.
3. **Aave Pool upgradeability** — the Pool is an InitializableImmutableAdminUpgradeabilityProxy. Function selectors are stable, but ABI drift is possible across versions. Pin the ABI in `aave-v3.ts` rather than re-fetching at runtime.
4. **aToken `transferFrom` + delegation** — aTokens override `transferFrom` to update scaled balances. RelayAdapt's standard `safeTransferFrom` to the Railgun vault works (Aave aTokens are ERC-20-compliant for transfer). No `delegateBySig` needed — that's only for governance tokens.
5. **Supply cap on Base aUSDC** — currently ~$50M cap. Over-cap supplies revert. Pre-flight `getReserveData` and reject early.
6. **eMode** — non-issue (we never set it; supplies in the default category). Listed for completeness.
7. **isolation mode** — USDC is *not* an isolation asset on Base/Arb. Borrow side would need to handle isolation; supply side does not.
8. **GHO / siloed reserves** — USDC is neither; safe.

## Primary sources

- Aave V3 Pool docs: <https://aave.com/docs/developers/smart-contracts/pool>
- Aave Address Book: <https://github.com/bgd-labs/aave-address-book>
- Aave V3 source `ValidationLogic.validateSupply`: <https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/protocol/libraries/logic/ValidationLogic.sol>
- Railgun RelayAdapt `shield()` (sweep-on-zero): <https://github.com/Railgun-Privacy/contract/blob/main/contracts/adapt/Relay.sol>
- Railgun engine `RelayAdaptHelper.createRelayShieldRequestsERC20s`: `node_modules/@railgun-community/engine/dist/contracts/relay-adapt/relay-adapt-helper.js:18-27`
