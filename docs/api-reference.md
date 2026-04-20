# API Reference

## Constructor

```typescript
const b402 = new B402({
  privateKey: '0x...',              // Required
  chainId: 8453,                    // Optional. 8453 Base | 42161 Arbitrum | 56 BSC
  rpcUrl: 'https://...',            // Optional. Override RPC endpoint
  facilitatorUrl: 'https://...',    // Optional. Override facilitator
  backendApiUrl: 'https://...',     // Optional. Override UTXO indexer
  onProgress: (event) => { ... },   // Optional. Progress callbacks
})
```

## Private DeFi (via RelayAdapt)

Atomic operations through Railgun privacy pool. On-chain: only RelayAdapt visible.

| Method | Description |
|--------|-------------|
| `privateSwap({ from, to, amount })` | Swap tokens inside pool |
| `privateLend({ amount, vault? })` | Deposit to Morpho vault from pool |
| `privateRedeem({ vault? })` | Withdraw from vault to pool |
| `privateCrossChain({ toChain, fromToken, toToken, amount, destinationAddress })` | Cross-chain via LI.FI |

## Pool Management

| Method | Description |
|--------|-------------|
| `shieldFromEOA({ token, amount })` | Enter pool from EOA (gasless, EIP-3009) |
| `shield({ token, amount })` | Enter pool from smart wallet |
| `unshield({ token, amount })` | Exit pool to smart wallet (ZK proof) |
| `consolidate({ token? })` | Merge fragmented UTXOs |
| `status()` | Full wallet + pool + position state |

## Yield

| Method | Description |
|--------|-------------|
| `lend({ token, amount, vault? })` | Direct Morpho deposit |
| `redeem({ vault?, shares? })` | Direct Morpho withdrawal |
| `rebalance(minApyDiff?)` | Move to highest-yield vault |

## General

| Method | Description |
|--------|-------------|
| `transact(calls)` | Arbitrary smart contract calls (gasless) |
| `fundIncognito({ amount })` | Fund smart wallet from EOA |

## Chains

| Chain | ID | Privacy | DeFi |
|-------|-----|---------|------|
| Base | 8453 | Full | Full (swap, lend, LP, perps) |
| Arbitrum | 42161 | Full | Shield/unshield only |
| BSC | 56 | Full | Shield/unshield only |

## Errors

| Error | Cause |
|-------|-------|
| `privateKey or signer is required` | Missing private key |
| `Unknown token: X` | Token not on this chain |
| `No shielded balance` | Private op without shielding first |
| `Facilitator verify failed` | UserOp rejected |
| `Unsupported chain` | DeFi method on non-Base chain |
