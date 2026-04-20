# b402 SDK

`@b402ai/sdk` — gasless, untraceable DeFi execution on Base.

## SDK Usage

```typescript
import { B402 } from './src/b402'
import 'dotenv/config'
const b402 = new B402({ privateKey: process.env.WORKER_PRIVATE_KEY })
```

`.env` has `WORKER_PRIVATE_KEY` and `BASE_RPC_URL` configured. No facilitator setup needed.

## Operations

- `b402.shield({ token: 'USDC', amount: '0.5' })` — move tokens into privacy pool
- `b402.unshield({ token: 'USDC', amount: '0.3' })` — ZK proof withdrawal to anonymous wallet
- `b402.lend({ token: 'USDC', amount: '0.2', vault: 'steakhouse' })` — deposit into Morpho vault
- `b402.redeem({ vault: 'steakhouse' })` — withdraw from vault
- `b402.status()` — check balances and positions
- `b402.swap({ from: 'USDC', to: 'WETH', amount: '5' })` — swap via 0x (needs `zeroXApiKey`)
- `b402.consolidate({ token: 'USDC' })` — merge fragmented UTXOs into one (auto-runs before private ops if needed)
- `b402.rebalance()` — move to highest-yield vault
- `b402.privateSwap({ from: 'USDC', to: 'WETH', amount: '0.5' })` — swap FROM privacy pool via RelayAdapt (fully private)
- `b402.privateLend({ token: 'USDC', amount: '0.5', vault: 'steakhouse' })` — deposit FROM privacy pool to Morpho (fully private)
- `b402.privateRedeem({ vault: 'steakhouse' })` — withdraw FROM Morpho back to privacy pool (fully private)
- `b402.addLiquidity({ pool: 'weth-usdc', amount: '50' })` — add liquidity to Aerodrome LP (~7.6% APY)
- `b402.removeLiquidity({ pool: 'weth-usdc' })` — remove liquidity + claim AERO rewards
- `b402.claimRewards({ pool: 'weth-usdc' })` — claim AERO rewards without removing LP
- `b402.synfuturesTrade({ instrument: 'BTC', side: 'long', notional: '20', margin: '10' })` — open perp on SynFutures V3
- `b402.synfuturesClose({ instrument: 'BTC' })` — close perp position + withdraw margin
- `b402.privateSynfuturesTrade(...)` — open perp FROM privacy pool (fully private)

## Running

Use `npx tsx examples/agent-demo.ts [operation]`:

```bash
npx tsx examples/agent-demo.ts status
npx tsx examples/agent-demo.ts shield
npx tsx examples/agent-demo.ts unshield
npx tsx examples/agent-demo.ts lend
npx tsx examples/agent-demo.ts redeem
npx tsx examples/agent-demo.ts private-swap
npx tsx examples/agent-demo.ts private-lend
npx tsx examples/agent-demo.ts private-redeem
npx tsx examples/agent-demo.ts add-lp 50
npx tsx examples/agent-demo.ts remove-lp
npx tsx examples/agent-demo.ts claim-rewards
```

## Important: Execution Guidelines

- **Shield takes ~30-60 seconds** (TX + indexing). Use timeout of 180000ms. Do NOT background it.
- **Unshield takes ~10-15 seconds** (ZK proof + TX). Use timeout of 120000ms.
- **Lend/redeem/transact** are fast (~5-10 seconds).
- **Private swap/lend/redeem take ~15-30 seconds** (ZK proof + TX). Use timeout of 180000ms.
- **Always show BaseScan links** for transactions: `https://basescan.org/tx/{txHash}`
- All operations are gasless.

## Full API Reference

See `skills/b402-sdk/SKILL.md` for complete documentation.

## Build & Test

- `npm run build` — compile TypeScript
- `npm test` — run vitest

## Key Facts

- Tokens: USDC, WETH, DAI, AERO
- Vaults: steakhouse, moonwell, gauntlet, steakhouse-hy
- LP Pools: weth-usdc (Aerodrome WETH/USDC volatile, ~7.6% APY)
- Perps: BTC, ETH, SOL (SynFutures V3 — live with real OI)
- Chains: Base mainnet (8453, full DeFi), BSC mainnet (56, privacy layer)
- Env vars: WORKER_PRIVATE_KEY, BASE_RPC_URL, B402_CHAIN (default: base)
