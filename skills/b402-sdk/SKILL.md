---
name: b402-sdk
version: 0.1.0
description: >
  Private DeFi execution SDK for AI agents on Base. Shield and unshield tokens via Railgun
  privacy pool, swap tokens, lend into Morpho vaults, earn yield, rebalance, and execute
  arbitrary transactions — gasless and untraceable.
  Use when the user wants to shield tokens privately, unshield from privacy pool, trade crypto
  privately, earn yield anonymously, deposit into DeFi vaults without revealing identity,
  check private wallet balances, rebalance yield positions, send arbitrary transactions
  gaslessly, or execute any DeFi operation on Base with privacy.
author: b402
homepage: https://b402.ai
tags: [defi, privacy, base, railgun, morpho, swap, lend, yield, gasless, agents, erc-4337]
metadata:
  emoji: "🔒"
  category: defi
  chain: base
  sdk_package: "@b402ai/sdk"
---

# @b402ai/sdk — Private DeFi for Agents

**One import. One verb. Gasless. Untraceable.**

```typescript
import { B402 } from '@b402ai/sdk'
const b402 = new B402({ privateKey: '0x...' })

// Agent-native: one verb, tagged by action. Maps 1:1 to LLM tool-call shape.
await b402.execute({ action: 'privateSwap', from: 'USDC', to: 'WETH', amount: '10' })
```

## Quick Start

### 1. Install

```bash
npm install @b402ai/sdk
```

### 2. Initialize

```typescript
import { B402 } from '@b402ai/sdk'

const b402 = new B402({
  privateKey: process.env.PRIVATE_KEY,
})
```

Only `privateKey` is required. The b402 facilitator handles gas, wallet deployment, and transaction submission.

### 3. Check Status

```typescript
const status = await b402.status()
// {
//   ownerEOA: '0x0001Dc...',
//   smartWallet: '0x6CdF29...',
//   deployed: true,
//   chain: 'base',
//   balances: [{ token: 'USDC', balance: '50.0' }],
//   positions: [{ vault: 'steakhouse', assets: '100.5 USDC', apyEstimate: '4-6%' }]
// }
```

## Commands

### Execute (Unified Dispatcher)

One verb for agents. The `action` field tags a discriminated union — TypeScript narrows `params` to exactly that action's shape, and the return type to that action's result. Maps 1:1 to the `{name, arguments}` shape LLMs emit as tool calls.

```typescript
// Pick an action; the rest of the object is typed to that action's params.
await b402.execute({ action: 'privateSwap',       from: 'USDC', to: 'WETH', amount: '10' })
await b402.execute({ action: 'privateLend',       token: 'USDC', amount: '100', vault: 'steakhouse' })
await b402.execute({ action: 'privateRedeem',     vault: 'steakhouse' })
await b402.execute({ action: 'privateCrossChain', toChain: 'arbitrum', fromToken: 'USDC', toToken: 'USDC', amount: '50', destinationAddress: '0x...' })
await b402.execute({ action: 'shield',            token: 'USDC', amount: '10' })
await b402.execute({ action: 'unshield',          token: 'USDC', amount: '5' })
```

`execute()` routes to the typed methods below. They are equivalent — use either surface.

Exported types for typing tool-call handlers:

```typescript
import type { ExecuteParams, ExecuteResultMap, ExecuteResult } from '@b402ai/sdk'
```

### Shield (Enter Privacy Pool)

Move tokens from EOA into the Railgun privacy pool. This is the onboarding step — breaks the on-chain link between your real wallet and smart wallet.

```typescript
const result = await b402.shield({ token: 'USDC', amount: '100' })
// { txHash: '0x...', indexed: true }
```

| Param | Required | Description |
|-------|----------|-------------|
| `token` | Yes | Token to shield (USDC, WETH, DAI) |
| `amount` | Yes | Amount to shield |

Note: Shield sends from master EOA — requires tokens + ETH for gas. Indexing takes 1-3 min.

### Unshield (Exit Privacy Pool)

Withdraw tokens from the Railgun privacy pool to your anonymous smart wallet. Generates a ZK proof (Groth16) client-side.

```typescript
const result = await b402.unshield({ token: 'USDC', amount: '50' })
// { txHash: '0x...', proofTimeSeconds: 8 }
```

| Param | Required | Description |
|-------|----------|-------------|
| `token` | Yes | Token to unshield |
| `amount` | Yes | Amount to unshield |

### Transact (Arbitrary Calls)

Execute any batch of calls through your smart wallet via facilitator. Gasless.

```typescript
const result = await b402.transact([
  { to: '0xTokenAddr', value: '0', data: '0xapproveCalldata' },
  { to: '0xProtocol',  value: '0', data: '0xactionCalldata' },
])
// { txHash: '0x...' }
```

| Param | Required | Description |
|-------|----------|-------------|
| `calls` | Yes | Array of { to, value, data } |

### Private Swap

Swap tokens via 0x aggregator. Funding source is untraceable.

```typescript
const result = await b402.swap({
  from: 'USDC',
  to: 'WETH',
  amount: '10',
  slippageBps: 100, // 1% default
})
// { txHash: '0x...', amountIn: '10', amountOut: '0.004', tokenIn: 'USDC', tokenOut: 'WETH' }
```

| Param | Required | Description |
|-------|----------|-------------|
| `from` | Yes | Sell token (USDC, WETH, DAI) |
| `to` | Yes | Buy token |
| `amount` | Yes | Amount to sell (human-readable) |
| `slippageBps` | No | Slippage tolerance in bps (default: 100) |

### Private Lend (Morpho)

Deposit tokens into a Morpho ERC-4626 vault to earn yield anonymously.

```typescript
const result = await b402.lend({
  token: 'USDC',
  amount: '100',
  vault: 'steakhouse',
})
// { txHash: '0x...', amount: '100', vault: 'steakhouse' }
```

| Param | Required | Description |
|-------|----------|-------------|
| `token` | Yes | Token to deposit (USDC) |
| `amount` | Yes | Amount to deposit |
| `vault` | No | Vault name (default: steakhouse) |

### Redeem (Withdraw)

Withdraw from a Morpho vault. Omit `shares` to redeem all.

```typescript
const result = await b402.redeem({ vault: 'steakhouse' })
// { txHash: '0x...', assetsReceived: '100.23', vault: 'steakhouse' }
```

| Param | Required | Description |
|-------|----------|-------------|
| `vault` | No | Vault name (default: steakhouse) |
| `shares` | No | Shares to redeem (default: all) |

### Private Swap (Pool-Level)

Swap tokens directly from the privacy pool via RelayAdapt + Aerodrome DEX. On-chain observer sees "RelayAdapt called Aerodrome" — zero link to any user.

```typescript
const result = await b402.privateSwap({
  from: 'USDC',
  to: 'WETH',
  amount: '0.5',
  slippageBps: 50, // 0.5% default
})
// { txHash: '0x...', amountIn: '0.5', amountOut: '0.0002', tokenIn: 'USDC', tokenOut: 'WETH' }
```

| Param | Required | Description |
|-------|----------|-------------|
| `from` | Yes | Sell token (USDC, WETH, DAI) |
| `to` | Yes | Buy token |
| `amount` | Yes | Amount to sell (human-readable) |
| `slippageBps` | No | Slippage tolerance in bps (default: 50) |

### Private Lend (Pool-Level)

Deposit tokens from the privacy pool directly into a Morpho vault via RelayAdapt. Share tokens are shielded back into the pool.

```typescript
const result = await b402.privateLend({
  token: 'USDC',
  amount: '0.5',
  vault: 'steakhouse',
})
// { txHash: '0x...', amount: '0.5', vault: 'Steakhouse USDC' }
```

| Param | Required | Description |
|-------|----------|-------------|
| `token` | No | Token to deposit (default: USDC) |
| `amount` | Yes | Amount to deposit |
| `vault` | No | Vault name (default: steakhouse) |

### Private Redeem (Pool-Level)

Redeem vault shares from the privacy pool back to USDC in the pool via RelayAdapt.

```typescript
const result = await b402.privateRedeem({ vault: 'steakhouse' })
// { txHash: '0x...', assetsReceived: '0.51', vault: 'Steakhouse USDC' }
```

| Param | Required | Description |
|-------|----------|-------------|
| `vault` | No | Vault name (default: steakhouse) |
| `shares` | No | Shares to redeem (default: all) |

### Private Cross-Chain (Pool-Level)

Privately transfer, bridge, or bridge+swap from the privacy pool to another chain via LI.FI. One atomic call through RelayAdapt on the source chain — no observer can link the Base shielded source to the destination wallet. LI.FI picks the best route across ~30 bridges and ~20 DEXes (Across, Stargate, CCTP, Eco, NearIntents, Relay, etc.).

```typescript
// Scenario A — same-token cross-chain transfer (pure bridge)
await b402.privateCrossChain({
  toChain: 'arbitrum',
  fromToken: 'USDC',
  toToken: 'USDC',
  amount: '1',
  destinationAddress: '0xRecipientOnArb...',
})
// { txHash, tool: 'Eco', expectedAmountOut: '0.9975', minAmountOut, estimatedDurationSec: 15, ... }

// Scenario B — bridge + swap in one atomic call
await b402.privateCrossChain({
  toChain: 'arbitrum',
  fromToken: 'USDC',
  toToken: 'ARB',
  amount: '1',
  destinationAddress: '0xRecipientOnArb...',
})
// { txHash, tool: 'NearIntents', expectedAmountOut: '8.6116', ... }
```

| Param | Required | Description |
|-------|----------|-------------|
| `toChain` | Yes | Destination chain ID or alias ('arbitrum') |
| `fromToken` | Yes | Source token symbol (USDC, WETH, DAI) |
| `toToken` | Yes | Destination token symbol (same as fromToken for pure bridge; different for bridge+swap) |
| `amount` | Yes | Human-readable amount in fromToken units (min ~$0.50) |
| `destinationAddress` | Yes | Recipient EOA on destination chain |
| `slippageBps` | No | Max slippage in bps (default 50 = 0.5%) |
| `lifiApiKey` | No | LI.FI API key (higher rate limit) |

Source-chain flow (atomic): `Pool → unshield → approve LI.FI Diamond → Diamond.swap(bridge+swap) → re-shield remainder → Pool`. Destination chain: funds land at `destinationAddress`. LI.FI protocol fee 0.25%.

### Rebalance

Move capital to the highest-yield vault automatically.

```typescript
const result = await b402.rebalance(0.5) // min 0.5% APY difference
// { action: 'rebalanced', currentVault: 'steakhouse', bestVault: 'steakhouse-hy', txHash: '0x...' }
```

### Status

Check wallet state, balances, privacy pool balances, and vault positions.

```typescript
const status = await b402.status()
// status.shieldedBalances — funds in privacy pool (invisible onchain)
// status.balances         — funds on smart wallet (ready to deploy)
// status.positions        — funds in Morpho vaults (earning yield)
```

## Natural Language -> SDK Call

| User says | SDK call |
|-----------|---------|
| "Shield 100 USDC into privacy pool" | `b402.shield({ token: 'USDC', amount: '100' })` |
| "Unshield 50 USDC to my wallet" | `b402.unshield({ token: 'USDC', amount: '50' })` |
| "Swap 10 USDC to WETH privately" | `b402.swap({ from: 'USDC', to: 'WETH', amount: '10' })` |
| "Swap from the pool" / "private swap" | `b402.privateSwap({ from: 'USDC', to: 'WETH', amount: '0.5' })` |
| "Lend 100 USDC in steakhouse" | `b402.lend({ token: 'USDC', amount: '100', vault: 'steakhouse' })` |
| "Lend from the pool" / "private lend" | `b402.privateLend({ amount: '0.5', vault: 'steakhouse' })` |
| "Withdraw from steakhouse vault" | `b402.redeem({ vault: 'steakhouse' })` |
| "Redeem to pool" / "private redeem" | `b402.privateRedeem({ vault: 'steakhouse' })` |
| "Privately send 1 USDC to 0x... on Arbitrum" | `b402.privateCrossChain({ toChain: 'arbitrum', fromToken: 'USDC', toToken: 'USDC', amount: '1', destinationAddress: '0x...' })` |
| "Private cross-chain swap 1 USDC to ARB on Arbitrum" | `b402.privateCrossChain({ toChain: 'arbitrum', fromToken: 'USDC', toToken: 'ARB', amount: '1', destinationAddress: '0x...' })` |
| "Check my private wallet" | `b402.status()` |
| "Rebalance to best yield" | `b402.rebalance()` |
| "Send 10 USDC to 0x..." | `b402.transact([{ to, value, data }])` |
| "What vaults are available?" | `B402.vaults` |
| "What tokens are supported?" | `B402.tokens` |

## Available Vaults

| Vault | Full Name | APY | Address |
|-------|-----------|-----|---------|
| `steakhouse` | Steakhouse USDC | 4-6% | `0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183` |
| `moonwell` | Moonwell Flagship USDC | 3-5% | `0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca` |
| `gauntlet` | Gauntlet USDC Prime | 4-6% | `0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61` |
| `steakhouse-hy` | Steakhouse High Yield USDC | 6-8% | `0xCBeeF01994E24a60f7DCB8De98e75AD8BD4Ad60d` |

## Supported Tokens

| Token | Address | Decimals |
|-------|---------|----------|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 |
| WETH | `0x4200000000000000000000000000000000000006` | 18 |
| DAI | `0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb` | 18 |

## How It Works

```
EOA → [shield] → Privacy Pool → [unshield] → Smart Wallet → [DeFi]
         ↑                ↑         ↑                          ↑
    One-time setup    Private DeFi   ZK proof breaks      Gasless via
    (needs gas)     via RelayAdapt   the funding link       facilitator

Pool-Level DeFi (via RelayAdapt — fully private):
Privacy Pool → [unshield to RelayAdapt] → [DeFi] → [shield output] → Privacy Pool
     ↑              Zero user link              ↑
  privateSwap()                          privateLend()
  privateLend()                          privateRedeem()
  privateRedeem()
```

1. **Derive identity** — `privateKey` signs a standard message. The keccak256 hash becomes the incognito private key. This produces a deterministic, unlinkable EOA.
2. **Compute wallet** — The incognito EOA deterministically maps to a Nexus ERC-4337 smart wallet via CREATE2.
3. **Build calls** — The SDK builds an array of EVM calls (approve + DeFi action).
4. **Verify** — POST calls to `b402-facilitator-base-posmj54s5q-uc.a.run.app/api/v1/wallet/incognito/verify`. The facilitator builds a UserOp and signs it with the paymaster.
5. **Sign** — The SDK signs the UserOp hash with the incognito wallet.
6. **Settle** — POST the signed UserOp to `/settle`. The facilitator submits to the bundler. The relayer pays gas.

## What's Visible vs Hidden

| Visible On-Chain | Hidden |
|------------------|--------|
| Smart wallet address | Who owns it |
| DeFi action (swap amount, vault deposit) | Funding source |
| Block number, gas used | Operator's real EOA |
| Paymaster sponsorship | Link to other wallets |

## Fees

| Fee | Amount |
|-----|--------|
| Gas | $0.00 (facilitator-sponsored) |
| Swap | DEX fee (varies) |
| Lend / Redeem | 0% |
| Railgun unshield | 0% (b402 fork) |

## Progress Tracking

```typescript
const b402 = new B402({
  privateKey: '0x...',
  onProgress: (event) => {
    if (event.type === 'step') console.log(`[${event.step}/${event.totalSteps}] ${event.title}`)
    else if (event.type === 'done') console.log(`Done: ${event.message}`)
  },
})
```

Output:
```
[1/3] Building UserOp
[2/3] Signing
[3/3] Submitting
Done: TX: 0xabc...
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes | Operator private key (derives incognito wallet) |

## Error Handling

All methods throw on failure. Wrap in try/catch:

```typescript
try {
  await b402.swap({ from: 'USDC', to: 'WETH', amount: '10' })
} catch (err) {
  console.error('Failed:', err.message)
}
```

| Error | Cause | Fix |
|-------|-------|-----|
| `Unknown token: X` | Invalid token symbol | Use USDC, WETH, or DAI |
| `Unknown vault: X` | Invalid vault name | Use steakhouse, moonwell, gauntlet, steakhouse-hy |
| `No shares in X` | No position in vault | Deposit first with `b402.lend()` |
| `Facilitator verify failed` | UserOp rejected | Check wallet has tokens, try again |

## Network

Base Mainnet (chain ID 8453)

| Contract | Address |
|----------|---------|
| Railgun Relay | `0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85` |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| Nexus Factory | `0x0000006648ED9B2B842552BE63Af870bC74af837` |
| RelayAdapt | `0xB0BC6d50098519c2a030661338F82a8792b85404` |
| Aerodrome Router | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` |
| Facilitator | `https://b402-facilitator-base-posmj54s5q-uc.a.run.app` |

## Resources

- [b402 Docs](https://docs.b402.ai)
- [SDK Source](https://github.com/b402-ai/b402-sdk)
- [ClawPay — Private Payments](https://clawpay.dev)
- [b402scan — Transaction Explorer](https://b402scan.com)
