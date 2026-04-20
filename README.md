# @b402ai/sdk

Private on-chain execution for agents. **Base, Arbitrum, BSC.**

One private key. Anonymous smart wallet. Gasless transactions. ZK-proven privacy.
Railgun fork with **0% protocol fees**.

## Install

```bash
npm install @b402ai/sdk
```

## Quick Start

```typescript
import { B402 } from '@b402ai/sdk'

const b402 = new B402({ privateKey: process.env.WORKER_PRIVATE_KEY! })

// Shield — move USDC into privacy pool (gasless, breaks on-chain link)
await b402.shieldFromEOA({ token: 'USDC', amount: '10' })

// Private swap — atomic via RelayAdapt, zero trace
await b402.privateSwap({ from: 'USDC', to: 'WETH', amount: '5' })

// Private cross-chain — LI.FI routing, destination unlinkable from source
await b402.privateCrossChain({
  toChain: 'arbitrum',
  fromToken: 'USDC',
  toToken: 'USDC',
  amount: '5',
  destinationAddress: '0x...',
})

// Private lend — deposit into Morpho vault from pool
await b402.privateLend({ amount: '10', vault: 'steakhouse' })

// Check status
const s = await b402.status()
```

No API keys needed. The SDK derives an anonymous smart wallet, and the b402 facilitator sponsors all gas.

## How It Works

```
Your Key → Incognito EOA → Anonymous Smart Wallet → DeFi
              (derived)        (gasless, untraceable)
```

**Shield** deposits tokens into the Railgun privacy pool. **Private operations** (privateSwap, privateLend, privateCrossChain) unshield into a RelayAdapt contract, execute DeFi calls, and shield the output — all in one atomic transaction. On-chain observers see the RelayAdapt contract, never your wallet.

## Configuration

```typescript
const b402 = new B402({
  privateKey: '0x...',              // Required. Derives anonymous wallet.
  chainId: 8453,                    // Optional. 8453 Base (default) | 42161 Arbitrum | 56 BSC
  rpcUrl: 'https://...',            // Optional. Override RPC. Set BASE_RPC_URL env for production.
  facilitatorUrl: 'https://...',    // Optional. Default: production facilitator.
  backendApiUrl: 'https://...',     // Optional. Override UTXO/merkle indexer endpoint.
  onProgress: (event) => { ... },   // Optional. Step-by-step progress updates.
})
```

Default RPC (Alchemy free tier) works for testing. For production, set `BASE_RPC_URL` / `ARB_RPC_URL` / `BSC_RPC_URL` in your environment.

### Backend API URL — resolution order

1. `config.backendApiUrl` — constructor option, highest priority
2. `process.env.B402_BACKEND_API_URL` — global env override
3. `process.env.BASE_BACKEND_API_URL` / `ARB_BACKEND_API_URL` — per-chain env
4. Chain-specific production default

## API

### Private DeFi (via RelayAdapt)

All private operations execute atomically through Railgun's RelayAdapt contract. On-chain observers see the contract, never your wallet.

#### `b402.privateSwap({ from, to, amount })` — Private token swap

Routes via Odos aggregator (all Base DEXes). No API key needed.

```typescript
const result = await b402.privateSwap({ from: 'USDC', to: 'WETH', amount: '0.5' })
// { txHash, amountIn, amountOut, tokenIn, tokenOut }
```

#### `b402.privateLend({ amount, vault? })` — Private vault deposit

Deposits into Morpho vault from privacy pool. Vault shares shielded back into pool.

```typescript
await b402.privateLend({ amount: '100', vault: 'steakhouse' })
```

#### `b402.privateRedeem({ vault? })` — Private vault withdrawal

```typescript
const { assetsReceived } = await b402.privateRedeem({ vault: 'steakhouse' })
```

#### `b402.privateCrossChain({ toChain, fromToken, toToken, amount, destinationAddress })` — Private cross-chain

Routes via LI.FI (~30 bridges, ~20 DEXes). Source unlinkable from destination.

```typescript
const result = await b402.privateCrossChain({
  toChain: 'arbitrum',
  fromToken: 'USDC',
  toToken: 'ARB',
  amount: '1',
  destinationAddress: '0x...',
})
// { txHash, tool, expectedAmountOut, minAmountOut, estimatedDurationSec }
```

### Privacy Pool

#### `b402.shieldFromEOA({ token, amount })` — Enter pool (gasless)

Gasless shield from your EOA using EIP-3009. Best for bootstrapping — no ETH needed.

```typescript
await b402.shieldFromEOA({ token: 'USDC', amount: '100' })
```

#### `b402.shield({ token, amount })` — Enter pool (from smart wallet)

Moves tokens from the anonymous smart wallet into the Railgun privacy pool.

```typescript
const { txHash, indexed } = await b402.shield({ token: 'USDC', amount: '100' })
```

#### `b402.unshield({ token, amount })` — Exit pool

Generates a ZK proof (Groth16) client-side and withdraws to the anonymous smart wallet.

```typescript
const { txHash } = await b402.unshield({ token: 'USDC', amount: '50' })
```

#### `b402.consolidate({ token? })` — Merge UTXOs

Merges fragmented UTXOs into one. Auto-runs before private operations when needed.

#### `b402.status()` — Full state

```typescript
const s = await b402.status()
// s.smartWallet       — anonymous wallet address
// s.balances          — [{ token: 'USDC', balance: '50.0' }]
// s.shieldedBalances  — [{ token: 'USDC', balance: '25.0' }]
// s.positions         — [{ vault: 'steakhouse', assets: '100.5 USDC', apyEstimate: '3.5%' }]
// s.lpPositions       — [{ pool: 'weth-usdc', usdValue: '500', apyEstimate: '7.6%' }]
```

### Yield (Morpho Vaults)

#### `b402.lend({ token, amount, vault? })` — Direct vault deposit

```typescript
await b402.lend({ token: 'USDC', amount: '100', vault: 'steakhouse' })
```

| Vault | Name | APY |
|-------|------|-----|
| `steakhouse` | Steakhouse USDC | 3-4% |
| `moonwell` | Moonwell Flagship USDC | 3-4% |
| `gauntlet` | Gauntlet USDC Prime | 3-4% |
| `steakhouse-hy` | Steakhouse High Yield | 3-4% |

#### `b402.redeem({ vault?, shares? })` — Direct vault withdrawal

#### `b402.rebalance(minApyDiff?)` — Move to highest-yield source

### Other Operations

#### `b402.transact(calls)` — Arbitrary smart contract calls

Execute any calldata through the anonymous smart wallet. Gasless.

```typescript
await b402.transact([{ to: '0x...', value: '0', data: '0x...' }])
```

### Static Helpers

```typescript
B402.vaults          // available yield vaults
B402.tokens          // supported tokens per chain
B402.pools           // Aerodrome LP pools (Base)
```

## Chains

| Chain | ID | Railgun Fork (0% fees) | Operations |
|-------|-----|------------------------|------------|
| **Base** | 8453 | `0x26111e2379...` | Full DeFi: privateSwap, privateLend, privateCrossChain, LP, perps |
| **Arbitrum** | 42161 | `0x9dB0eDC77C...` | Privacy: shield, unshield, transact |
| **BSC** | 56 | `0x9dB0eDC77C...` | Privacy: shield, unshield, transact |

Select at runtime: `new B402({ chainId: 42161 })`. Default is Base.

## For Agents

Every method takes plain strings and returns plain objects. No ABI encoding, no gas estimation, no nonce management.

For Claude Desktop / Cursor, install the MCP server:

```bash
npx b402-mcp@latest --claude
```

## Error Handling

| Error | Cause |
|-------|-------|
| `privateKey or signer is required` | Missing private key |
| `Unknown token: X` | Token not supported on this chain |
| `No shielded balance` | Called private op without shielding first |
| `Facilitator verify failed` | Invalid UserOp or facilitator issue |
| `Unsupported chain` | Called DeFi method on non-Base chain |

## License

MIT
