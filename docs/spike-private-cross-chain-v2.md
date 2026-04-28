# Spike: privateCrossChain v2 — atomic dest-chain shielding

**Status:** design only, no code
**Author:** mayur + claude
**Pairs with:** PR #4 (multi-chain Arb), Issue #5 (Aave V3)
**Target:** PR after #4 + #5 land. ~150-200 LOC.

## Today (v1 — what shipped in 0.6.0)

```
shielded UTXO (chain A)
   │
   ├─ Railgun ZK proof + RelayAdapt
   │
   ▼
[RelayAdapt.relay] ──approve──> LiFi Diamond ──bridge──> ??? on chain B
                                                          │
                                                          ▼
                                            params.destinationAddress (public)
```

**Source-side privacy: ✓** — public observer on chain A sees only `RelayAdapt → Diamond → bridge`. The user wallet is inside the ZK proof.
**Destination-side privacy: ✗** — funds land at a user-supplied public address on chain B. Anyone watching chain B sees the bridge deliver to that address. The privacy guarantee ends at the bridge.

This is fine for "private exit to a fresh wallet on chain B" (the wallet has no on-chain history), but it does **not** stack with `b402.privateLend` on chain B — to lend privately on the destination chain, the user has to manually shield again, which costs gas and creates a new fingerprint.

## v2 goal — atomic shield-on-arrival

```
shielded UTXO (chain A)
   │
   ├─ Railgun ZK proof + RelayAdapt
   ▼
[RelayAdapt.relay] ──approve──> LiFi Diamond ─┬─bridge──> Executor (chain B)
                                              │              │
                                              │              ▼
                                              │   [contractCalls payload runs]
                                              │              │
                                              │              ├─ approve ─> RelayAdapt (chain B)
                                              │              ▼
                                              │   [RelayAdapt.shield(toToken, toAmount)]
                                              ▼              │
                                                             ▼
                                                    shielded UTXO (chain B)
```

End result: a shielded UTXO on chain A becomes a shielded UTXO on chain B. Public observers on either chain see only RelayAdapt activity. No public address ever holds the bridged funds.

## How LiFi enables this

`POST /v1/quote/contractCalls` accepts:

```jsonc
{
  "fromChain": 42161,
  "toChain": 8453,
  "fromToken": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "toToken":   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "fromAddress": "<sourceRelayAdapt>",
  "toAddress":   "<destRelayAdapt>",   // bridge delivers here on chain B
  "contractCalls": [                    // executed on chain B after bridge
    {
      "fromTokenAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "fromAmount": "994500",           // = quote.toAmountMin
      "toContractAddress": "<destRailgunRelayAdapt>",
      "toContractCallData": "0x<encoded RelayAdapt.shield(...)>",
      "toContractGasLimit": "500000"
    }
  ]
}
```

The destination-chain `Executor` calls our pre-signed `shield()` with the bridged tokens. If `shield()` reverts (e.g. amount mismatch), the bridged funds sit at the dest RelayAdapt and can be swept via a follow-up signed call (or a `refundAddress` on the LiFi step).

## What we have to build

### 1. Per-chain Railgun shield call construction

`src/privacy/lib/shield-builder.ts` (new) — `buildShieldCalldata(chainId, token, amountMin, viewingPublicKey)`. Produces the calldata for `RailgunSmartWalletProxy.shield([{ ... }])` on the target chain, signed with the user's viewing key so they can decrypt the resulting UTXO.

Constraints:
- Amount is dynamic (= bridge output, post-slippage) — must use the variable-amount shield path, not the fixed-value version. Railgun supports this via `value=0` + `balanceOf()` snapshot at shield time.
- Receiver is the user's incognito wallet on chain B — same address as chain A (deterministic CREATE2 via Nexus).

### 2. Cross-chain quote with dest-side calldata

`LiFiProvider.getCrossChainQuote(params, contractCalls)` — extends the existing `getBridgeQuote` to use `/v1/quote/contractCalls` instead of `/v1/quote`. Returns the same `BridgeQuote` shape; the destination-side calldata is baked into `quote.transactionRequest.data` (LiFi handles wrapping into the Executor pattern).

### 3. New B402 method: `privateBridge`

```ts
b402.privateBridge({
  fromToken: 'USDC',
  amount: '10',
  toChain: 'base',
  toToken: 'USDC',          // optional — defaults to "same symbol on dest chain"
  // No destinationAddress — funds land in the dest privacy pool
})
```

Returns:
```ts
{
  txHash,                    // src-chain tx hash
  fromChain, toChain,
  fromAmount, toAmount, toAmountMin,
  destShieldExpected: bigint,   // the UTXO that will appear on dest chain
  estimatedDurationSec,
  // Dest-chain commitment hash (for the user to wait on)
  destCommitmentTrackingId: string,
}
```

`privateCrossChain` keeps its existing v1 semantics for back-compat (lands at public destinationAddress). `privateBridge` is the new private end-to-end primitive.

### 4. Status polling

`b402.getCrossChainStatus(txHash)` — wraps LiFi `/v1/status?txHash=...`. Returns `{ status: 'pending' | 'done' | 'failed', destTxHash? }`. Without this, users can't know when their dest-chain shield landed.

### 5. Failure modes & sweep

If dest-side `shield()` reverts (e.g. Railgun is paused on dest chain): bridged tokens sit at the dest RelayAdapt. Users need a `b402.sweepStrandedBridge(txHash)` helper that:
- Reads the LiFi status to find the dest tx
- Pulls the bridged amount from RelayAdapt back to the user's incognito wallet
- Optionally retries the shield

## Failure / abuse modes audited

| Scenario | Today (v1) | v2 |
|---|---|---|
| Bridge slippage > expected | toAmountMin protects user | toAmountMin still protects; dest shield uses actual `balanceOf` so any slippage just means slightly less in the new UTXO |
| Bridge fails on dest chain | LiFi triggers refund to fromAddress = sourceRelayAdapt → autoreshields to source pool ✓ | Same |
| Dest shield reverts | n/a (no shield in v1) | Funds at dest RelayAdapt; sweep helper |
| Quote expires before settle | We eat gas. No retry. | Same. Add `validUntil` preflight in v2 if cheap. |
| LiFi API down | privateCrossChain throws BridgeProviderError ✓ | Same |
| MEV on dest chain swap leg | Public bridges have public dest swaps if `toToken !== fromToken`. v2 swap+shield is one tx → no in-flight MEV window. | Better |

## Out of scope

- **Cross-chain lending** (`bridge → privateLend on dest`). Mechanically possible via stacking contractCalls, but adds protocol-specific calldata (Morpho deposit, etc.). Skip until v3.
- **Privacy-hop routing** (Railgun A → Railgun B → Railgun A again to break linkability further). Not currently supported by LiFi; requires custom relay infrastructure.
- **Solana / non-EVM destinations.** LiFi added these in late 2025 but Railgun is EVM-only.

## Hardening tasks bundled with v2 PR

These are LiFi-config items that don't need a v2 to land but pair naturally:

- **Register `integrator=b402`** at https://portal.li.fi for the partner program.
- **`LIFI_API_KEY` env var** — `LiFiProvider` already accepts it as a constructor arg; thread `process.env.LIFI_API_KEY` through `B402` config so production calls hit the higher rate-limit tier (~12k req/2h on `/quote`).
- **0.5% slippage default** is reasonable; expose `slippageBps` on `privateBridge` params.

## Acceptance criteria

- [ ] `b402.privateBridge` round-trips on Arb→Base mainnet for USDC and ETH.
- [ ] Same for Base→Arb.
- [ ] Cross-chain swap variant works (`Arb USDC → Base WETH`) — single tx, lands in dest privacy pool.
- [ ] Dest commitment is decryptable by the user's viewing key (i.e. shows up in `b402.status({chain: 'base'})`).
- [ ] `getCrossChainStatus(txHash)` resolves correctly through LiFi /status.
- [ ] `sweepStrandedBridge(txHash)` recovers funds when dest shield reverts (test against a deliberately-failing shield call).
- [ ] No regression in existing `privateCrossChain` v1 callers — back-compat tests added.
- [ ] All 219+ tests green.
