# Quickstart

Get started with the b402 SDK in under 5 minutes. Execute private DeFi transactions on Base — gasless and untraceable.

## Installation

```bash
npm install @b402ai/sdk
```

## Initialize

```typescript
import { B402 } from '@b402ai/sdk'

const b402 = new B402({
  privateKey: process.env.PRIVATE_KEY,
  zeroXApiKey: process.env.ZERO_X_API_KEY, // optional, for swaps
})
```

That's it. Only `privateKey` is required. The b402 facilitator handles gas sponsorship, wallet deployment, and UserOp submission.

## Check Status

```typescript
const status = await b402.status()

console.log(status.smartWallet)   // 0x6CdF...cc3f
console.log(status.deployed)     // true
console.log(status.balances)     // [{ token: 'USDC', balance: '50.0' }]
console.log(status.positions)    // [{ vault: 'steakhouse', assets: '100.5 USDC', apyEstimate: '4-6%' }]
```

## Private Swap

Swap tokens with an untraceable funding source. Tokens land on your anonymous smart wallet.

```typescript
const result = await b402.swap({
  from: 'USDC',
  to: 'WETH',
  amount: '10',
})

console.log(result.txHash)    // 0xabc...
console.log(result.amountOut) // 0.004 WETH
```

## Private Lend

Earn yield anonymously through Morpho vaults on Base.

```typescript
// Deposit USDC into Steakhouse vault (4-6% APY)
await b402.lend({
  token: 'USDC',
  amount: '100',
  vault: 'steakhouse',
})
```

Available vaults:

| Vault | Name | APY |
|-------|------|-----|
| `steakhouse` | Steakhouse USDC | 4-6% |
| `moonwell` | Moonwell Flagship USDC | 3-5% |
| `gauntlet` | Gauntlet USDC Prime | 4-6% |
| `steakhouse-hy` | Steakhouse High Yield USDC | 6-8% |

## Redeem

Withdraw from a vault.

```typescript
// Redeem all shares
const result = await b402.redeem({ vault: 'steakhouse' })
console.log(result.assetsReceived) // '100.23' USDC
```

## Shield Tokens

Move tokens from your EOA into the Railgun privacy pool. After shielding, nobody can trace where tokens came from.

```typescript
await b402.shield({ token: 'USDC', amount: '100' })
// Tokens are now in the privacy pool — untraceable
```

## Rebalance

Automatically move capital to the highest-yield vault.

```typescript
const result = await b402.rebalance()
// { action: 'rebalanced', currentVault: 'steakhouse', bestVault: 'steakhouse-hy' }
```

## Progress Tracking

Track operation progress with callbacks:

```typescript
const b402 = new B402({
  privateKey: '0x...',
  onProgress: (event) => {
    if (event.type === 'step') {
      console.log(`[${event.step}/${event.totalSteps}] ${event.title}`)
    } else if (event.type === 'done') {
      console.log(`Done: ${event.message}`)
    }
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

## How It Works

Every operation follows the same pattern:

```
Private Key → Incognito Wallet → Smart Wallet → Facilitator → Base
```

1. **Anonymous wallet** — Your `privateKey` derives an incognito EOA that's cryptographically unlinkable to your real wallet
2. **Gasless** — The b402 facilitator sponsors all gas via paymaster. Your wallet needs $0 ETH.
3. **Atomic execution** — Approve + DeFi action happen in a single ERC-4337 UserOp — no front-running, no partial execution
4. **Smart wallet** — ERC-7579 Nexus wallet deployed automatically on first use

## Available Tokens

```typescript
B402.tokens
// [
//   { symbol: 'USDC', address: '0x833589...', decimals: 6 },
//   { symbol: 'WETH', address: '0x420000...', decimals: 18 },
//   { symbol: 'DAI',  address: '0x50c572...', decimals: 18 },
// ]
```

## Network

The SDK operates on **Base Mainnet** (chain ID 8453). All operations use real tokens and real money.

| Contract | Address |
|----------|---------|
| Railgun Relay | `0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85` |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| Nexus Factory | `0x0000006648ED9B2B842552BE63Af870bC74af837` |
