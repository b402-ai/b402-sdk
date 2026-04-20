# Quickstart

Private DeFi on Base, Arbitrum, BSC. Gasless. Untraceable.

## Install

```bash
npm install @b402ai/sdk
```

## Initialize

```typescript
import { B402 } from '@b402ai/sdk'

const b402 = new B402({
  privateKey: process.env.WORKER_PRIVATE_KEY!,
})
```

Only `privateKey` is required. The facilitator handles gas, wallet deployment, and UserOp submission.

## Shield

Move USDC into the Railgun privacy pool. After shielding, the funding source is untraceable.

```typescript
await b402.shieldFromEOA({ token: 'USDC', amount: '10' })
```

Gasless via EIP-3009. No ETH needed.

## Private Swap

Swap tokens atomically inside the privacy pool via RelayAdapt. On-chain: only RelayAdapt is visible, never your wallet.

```typescript
const result = await b402.privateSwap({ from: 'USDC', to: 'WETH', amount: '5' })
// { txHash, amountIn: '5', amountOut: '0.002', tokenIn: 'USDC', tokenOut: 'WETH' }
```

Routes via Odos aggregator across all Base DEXes. No API key needed.

## Private Cross-Chain

Bridge or swap across chains via LI.FI. Source and destination are unlinkable.

```typescript
const result = await b402.privateCrossChain({
  toChain: 'arbitrum',
  fromToken: 'USDC',
  toToken: 'ARB',
  amount: '1',
  destinationAddress: '0x...',
})
// { txHash, tool: 'NearIntents', expectedAmountOut: '8.61', estimatedDurationSec: 34 }
```

## Private Lend

Deposit into a Morpho vault from the privacy pool. Vault shares shielded back into pool.

```typescript
await b402.privateLend({ amount: '100', vault: 'steakhouse' })
```

| Vault | APY |
|-------|-----|
| steakhouse | 3-4% |
| moonwell | 3-4% |
| gauntlet | 3-4% |
| steakhouse-hy | 3-4% |

## Private Redeem

```typescript
const { assetsReceived } = await b402.privateRedeem({ vault: 'steakhouse' })
```

## Status

```typescript
const s = await b402.status()
// s.smartWallet       — anonymous wallet address
// s.shieldedBalances  — [{ token: 'USDC', balance: '25.0' }]
// s.balances          — [{ token: 'USDC', balance: '50.0' }]
// s.positions         — [{ vault: 'steakhouse', assets: '100.5 USDC' }]
```

## Multi-Chain

```typescript
const arb = new B402({ privateKey, chainId: 42161 })  // Arbitrum
const bsc = new B402({ privateKey, chainId: 56 })      // BSC
```

Privacy primitives (shield, unshield) work on all chains. DeFi operations (privateSwap, privateLend) are Base only.

## How It Works

```
Private Key → Incognito EOA → Anonymous Smart Wallet → RelayAdapt → DeFi
                (derived)        (gasless, ERC-4337)     (atomic, ZK)
```

1. `privateKey` derives an incognito EOA — unlinkable to your real wallet
2. Facilitator sponsors all gas via paymaster
3. Private operations go through RelayAdapt: unshield → DeFi call → reshield, all atomic
4. On-chain observers see RelayAdapt, never your wallet
