# @b402ai/sdk

Private on-chain execution for agents. **Base, BSC, Arbitrum.**

One private key. Anonymous smart wallet. Gasless transactions. ZK-proven privacy.
Railgun fork with **0% protocol fees**.

## Install

```bash
npm install @b402ai/sdk
```

## Quick Start

```typescript
import { B402 } from '@b402ai/sdk'

// Default: Base
const b402 = new B402({ privateKey: process.env.WORKER_PRIVATE_KEY })

// Or pick a chain
const arb = new B402({ privateKey: process.env.WORKER_PRIVATE_KEY, chainId: 42161 })

// Shield — move USDC into privacy pool (breaks on-chain link)
await b402.shield({ token: 'USDC', amount: '100' })

// Private swap — fully private, funded from pool
await b402.privateSwap({ from: 'USDC', to: 'WETH', amount: '10' })

// Earn yield — deposit into Morpho vault
await b402.lend({ token: 'USDC', amount: '50', vault: 'steakhouse' })

// Check everything
const status = await b402.status()
```

The only required config is `privateKey`. The SDK derives an anonymous smart wallet, and the b402 facilitator sponsors all gas.

## How It Works

```
Your Key → Incognito EOA → Anonymous Smart Wallet → DeFi
              (derived)        (gasless, untraceable)
```

**Shield** deposits tokens into the Railgun privacy pool. **Unshield** generates a client-side ZK proof and moves tokens to your anonymous smart wallet — no on-chain link between source and destination. From there, lend, swap, and transact — all gasless through the facilitator.

**Private operations** (privateSwap, privateLend, etc.) go a step further: they unshield directly into a RelayAdapt contract, execute DeFi calls, and shield the output — all in one atomic transaction. On-chain observers see the RelayAdapt contract, never your wallet.

## Configuration

```typescript
const b402 = new B402({
  privateKey: '0x...',              // Required. Derives anonymous wallet.
  chainId: 8453,                    // Optional. 8453 Base (default) | 56 BSC | 42161 Arbitrum
  zeroXApiKey: '...',               // Optional. Required for swap() only (Base only).
  rpcUrl: 'https://...',            // Optional. Default: chain-specific public RPC.
  facilitatorUrl: 'https://...',    // Optional. Default: production facilitator.
  backendApiUrl: 'https://...',     // Optional. Override UTXO/merkle indexer endpoint.
  onProgress: (event) => { ... },   // Optional. Step-by-step progress updates.
})
```

### Backend API URL — resolution order

The SDK reads merkle proofs and UTXO data from a b402-hosted indexer. If the
primary endpoint is unhealthy (stale merkle tree, region outage), override it:

1. `config.backendApiUrl` — constructor option, highest priority
2. `process.env.B402_BACKEND_API_URL` — global env override
3. `process.env.BASE_BACKEND_API_URL` / `BSC_BACKEND_API_URL` / `ARB_BACKEND_API_URL` — per-chain env
4. Chain-specific production default (us-central1 for Base + Arbitrum, europe-west1 for BSC)

```typescript
// Point at a different region / self-hosted replica
const b402 = new B402({
  privateKey,
  chainId: 8453,
  backendApiUrl: 'https://my-indexer.example.com',
})
```

## API

### Privacy Pool

#### `b402.shield({ token, amount })` — Enter privacy pool

Moves tokens from the smart wallet into the Railgun privacy pool. After shielding, the funding source is untraceable.

```typescript
const { txHash, indexed } = await b402.shield({ token: 'USDC', amount: '100' })
```

#### `b402.shieldFromEOA({ token, amount })` — Shield from master EOA

Gasless shield directly from your master EOA using EIP-3009 `transferWithAuthorization`. Useful for bootstrapping.

```typescript
await b402.shieldFromEOA({ token: 'USDC', amount: '100' })
```

#### `b402.unshield({ token, amount })` — Exit privacy pool

Generates a ZK proof (Groth16) client-side and withdraws to the anonymous smart wallet. Supports partial unshields with automatic change note management.

```typescript
const { txHash, proofTimeSeconds } = await b402.unshield({ token: 'USDC', amount: '50' })
// Pass amount: 'all' to drain all UTXOs
```

#### `b402.consolidate({ token? })` — Merge UTXOs

Merges fragmented UTXOs into one. Auto-runs before private operations when needed.

### Yield (Morpho Vaults)

#### `b402.lend({ token, amount, vault? })` — Deposit into vault

```typescript
await b402.lend({ token: 'USDC', amount: '100', vault: 'steakhouse' })
```

| Vault | Name | APY |
|-------|------|-----|
| `steakhouse` | Steakhouse USDC | 3-4% |
| `moonwell` | Moonwell Flagship USDC | 3-4% |
| `gauntlet` | Gauntlet USDC Prime | 3-4% |
| `steakhouse-hy` | Steakhouse High Yield | 3-4% |

#### `b402.redeem({ vault?, shares? })` — Withdraw from vault

```typescript
const { assetsReceived } = await b402.redeem({ vault: 'steakhouse' })
```

#### `b402.rebalance(minApyDiff?)` — Move to highest-yield source

Compares all yield sources (Morpho vaults + Aerodrome LP) and moves capital if APY difference exceeds threshold.

### Swaps

#### `b402.swap({ from, to, amount })` — Token swap via 0x

Requires `zeroXApiKey` in config.

```typescript
await b402.swap({ from: 'USDC', to: 'WETH', amount: '10' })
```

### Aerodrome LP

#### `b402.addLiquidity({ pool?, amount })` — Add LP

Single-token input (USDC) — SDK splits and swaps half automatically. LP tokens are staked in gauge to earn AERO.

```typescript
await b402.addLiquidity({ pool: 'weth-usdc', amount: '50' })
```

#### `b402.removeLiquidity({ pool? })` — Remove LP + claim rewards

```typescript
const { amountWETH, amountUSDC } = await b402.removeLiquidity({ pool: 'weth-usdc' })
```

#### `b402.claimRewards({ pool? })` — Claim AERO only

### Private Operations (via RelayAdapt)

All private operations execute atomically through Railgun's RelayAdapt contract. On-chain observers see the contract, never your wallet.

#### `b402.privateSwap({ from, to, amount })` — Private token swap

```typescript
await b402.privateSwap({ from: 'USDC', to: 'WETH', amount: '0.5' })
```

#### `b402.privateLend({ token?, amount, vault? })` — Private vault deposit

```typescript
await b402.privateLend({ token: 'USDC', amount: '0.5', vault: 'steakhouse' })
```

#### `b402.privateRedeem({ vault? })` — Private vault withdrawal

### Perpetuals

#### `b402.synfuturesTrade({ instrument, side, notional, margin })` — Open perp (SynFutures V3)

```typescript
await b402.synfuturesTrade({ instrument: 'BTC', side: 'long', notional: '20', margin: '10' })
```

#### `b402.synfuturesClose({ instrument })` — Close perp position

#### `b402.privateSynfuturesTrade(...)` — Open perp from privacy pool

### Speed Markets (Thales)

#### `b402.speedMarket({ asset, direction, amount, duration? })` — Binary option

```typescript
await b402.speedMarket({ asset: 'ETH', direction: 'up', amount: '10', duration: '10m' })
```

#### `b402.privateSpeedMarket(...)` — Binary option from privacy pool

### General

#### `b402.transact(calls)` — Arbitrary smart contract calls

Execute any calldata through the anonymous smart wallet. Gasless.

```typescript
await b402.transact([{ to: '0x...', value: '0', data: '0x...' }])
```

#### `b402.status()` — Wallet state

```typescript
const s = await b402.status()
// s.smartWallet       — anonymous wallet address
// s.balances          — [{ token: 'USDC', balance: '50.0' }]
// s.shieldedBalances  — [{ token: 'USDC', balance: '25.0' }]
// s.positions         — [{ vault: 'steakhouse', assets: '100.5 USDC', apyEstimate: '3.5%' }]
// s.lpPositions       — [{ pool: 'weth-usdc', usdValue: '500', apyEstimate: '7.6%' }]
```

### Static Helpers

```typescript
B402.vaults          // available yield vaults
B402.tokens          // supported tokens (USDC, WETH, DAI, AERO)
B402.pools           // Aerodrome LP pools
B402.perpMarkets     // SynFutures instruments
B402.speedMarketAssets // ['ETH', 'BTC']
```

## Supported Tokens

### Base (chainId 8453)
| Token | Address |
|-------|---------|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| WETH | `0x4200000000000000000000000000000000000006` |
| DAI | `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb` |
| AERO | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` |

### Arbitrum (chainId 42161)
| Token | Address |
|-------|---------|
| USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| USDT | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` |
| WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| ARB  | `0x912CE59144191C1204E64559FE8253a0e49E6548` |

### BSC (chainId 56)
Privacy layer (USDC, USDT, BUSD). See `B402.tokens` at runtime for the live list.

## For Agents

Every method takes plain strings and returns plain objects. No ABI encoding, no gas estimation, no nonce management.

```typescript
const b402 = new B402({ privateKey: agentKey })
await b402.shield({ token: 'USDC', amount: '1000' })
await b402.privateLend({ token: 'USDC', amount: '1000', vault: 'steakhouse' })
```

For tool-calling agents, each method maps directly to a tool:

```json
{
  "name": "b402_shield",
  "description": "Move tokens into Railgun privacy pool",
  "parameters": {
    "token": { "type": "string", "enum": ["USDC", "WETH", "DAI", "AERO"] },
    "amount": { "type": "string" }
  }
}
```

## Error Handling

All methods throw on failure:

```typescript
try {
  await b402.lend({ token: 'USDC', amount: '100' })
} catch (err) {
  console.error(err.message)
}
```

| Error | Cause |
|-------|-------|
| `privateKey or signer is required` | Missing private key or signer |
| `zeroXApiKey required for swaps` | Called swap() without API key |
| `Unknown token: X` | Token not supported |
| `No shares in vault` | Called redeem() on empty vault |
| `No shielded balance` | Called unshield/private op without shielding first |
| `Facilitator verify failed` | Invalid UserOp or facilitator issue |

## Networks

| Chain | ID | Railgun Fork (0% fees) | Supported Operations |
|-------|-----|------------------------|---------------------|
| **Base** | 8453 | `0x26111e2379...` | Privacy (shield, unshield, transact, privateSwap/Lend/Redeem) + full DeFi (swap, Morpho, Aerodrome LP, perps) |
| **Arbitrum** | 42161 | `0x9dB0eDC77C...` | Privacy layer (shield, unshield, transact) |
| **BSC** | 56 | `0x9dB0eDC77C...` | Privacy layer (shield, unshield, transact) |

- Select at runtime with `new B402({ chainId })`. Default is Base.
- Privacy primitives work on every supported chain.
- DeFi methods (swap/lend/LP/perps) throw if called on non-Base — use `privateSwap` etc. only on Base.
- All chains gasless via the b402 facilitator. All operations use real tokens.

## License

MIT
