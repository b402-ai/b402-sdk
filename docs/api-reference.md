# API Reference

## B402

The main SDK class. All operations are instance methods.

### Constructor

```typescript
new B402(config: B402Config)
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `privateKey` | `string` | Yes | Operator private key. Derives anonymous smart wallet. |
| `zeroXApiKey` | `string` | No | 0x API key. Required for `swap()`. |
| `rpcUrl` | `string` | No | Base RPC URL. Default: `https://mainnet.base.org` |
| `facilitatorUrl` | `string` | No | b402 facilitator URL. Default: production. |
| `onProgress` | `function` | No | Progress callback for step updates. |

---

### `b402.swap(params)`

Private token swap via 0x aggregator.

```typescript
const result = await b402.swap({
  from: 'USDC',
  to: 'WETH',
  amount: '10',
  slippageBps: 100, // 1% (optional, default: 100 bps)
})
```

**Returns:** `SwapResult`

| Field | Type | Description |
|-------|------|-------------|
| `txHash` | `string` | On-chain transaction hash |
| `amountIn` | `string` | Amount sold |
| `amountOut` | `string` | Amount received |
| `tokenIn` | `string` | Sell token symbol |
| `tokenOut` | `string` | Buy token symbol |

---

### `b402.lend(params)`

Deposit tokens into a Morpho ERC-4626 vault.

```typescript
const result = await b402.lend({
  token: 'USDC',
  amount: '100',
  vault: 'steakhouse', // optional, default: 'steakhouse'
})
```

**Returns:** `LendResult`

| Field | Type | Description |
|-------|------|-------------|
| `txHash` | `string` | Transaction hash |
| `amount` | `string` | Amount deposited |
| `vault` | `string` | Vault name |

---

### `b402.redeem(params?)`

Withdraw from a Morpho vault.

```typescript
// Redeem all shares
const result = await b402.redeem({ vault: 'steakhouse' })

// Redeem specific shares
const result = await b402.redeem({ vault: 'steakhouse', shares: '50' })
```

**Returns:** `RedeemResult`

| Field | Type | Description |
|-------|------|-------------|
| `txHash` | `string` | Transaction hash |
| `assetsReceived` | `string` | Assets received (USDC) |
| `vault` | `string` | Vault name |

---

### `b402.shield(params)`

Shield tokens from EOA into the Railgun privacy pool.

```typescript
const result = await b402.shield({
  token: 'USDC',
  amount: '100',
})
```

**Returns:** `ShieldResult`

| Field | Type | Description |
|-------|------|-------------|
| `txHash` | `string` | Transaction hash |
| `indexed` | `boolean` | Whether shield was indexed by Railgun |

> Shield indexing takes 1-3 minutes. The SDK polls automatically.

---

### `b402.privateSwap(params)`

Swap tokens directly from the privacy pool via RelayAdapt + Aerodrome. Fully private — on-chain observer sees only "RelayAdapt called Aerodrome".

```typescript
const result = await b402.privateSwap({
  from: 'USDC',
  to: 'WETH',
  amount: '0.5',
  slippageBps: 50, // 0.5% (optional, default: 50 bps)
})
```

**Returns:** `PrivateSwapResult`

| Field | Type | Description |
|-------|------|-------------|
| `txHash` | `string` | Transaction hash |
| `amountIn` | `string` | Amount sold |
| `amountOut` | `string` | Expected amount received |
| `tokenIn` | `string` | Sell token symbol |
| `tokenOut` | `string` | Buy token symbol |

> Requires shielded balance. Shield tokens first with `b402.shield()`.

---

### `b402.privateLend(params)`

Deposit tokens from the privacy pool into a Morpho vault via RelayAdapt. Share tokens are shielded back into the pool.

```typescript
const result = await b402.privateLend({
  token: 'USDC',    // optional, default: USDC
  amount: '0.5',
  vault: 'steakhouse', // optional, default: steakhouse
})
```

**Returns:** `PrivateLendResult`

| Field | Type | Description |
|-------|------|-------------|
| `txHash` | `string` | Transaction hash |
| `amount` | `string` | Amount deposited |
| `vault` | `string` | Vault name |

---

### `b402.privateRedeem(params?)`

Redeem vault shares from the privacy pool back to USDC in the pool via RelayAdapt.

```typescript
const result = await b402.privateRedeem({ vault: 'steakhouse' })
```

**Returns:** `PrivateRedeemResult`

| Field | Type | Description |
|-------|------|-------------|
| `txHash` | `string` | Transaction hash |
| `assetsReceived` | `string` | USDC received |
| `vault` | `string` | Vault name |

> Requires shielded vault share tokens from `b402.privateLend()`.

---

### `b402.rebalance(minApyDiff?)`

Move capital to the highest-yield vault.

```typescript
const result = await b402.rebalance(0.5) // min 0.5% APY difference to trigger
```

**Returns:** `RebalanceResult`

| Field | Type | Description |
|-------|------|-------------|
| `action` | `string` | `'rebalanced'` or `'no-change'` |
| `currentVault` | `string` | Current vault name |
| `bestVault` | `string` | Best vault name |
| `txHash` | `string` | Transaction hash (if rebalanced) |

---

### `b402.status()`

Check wallet state, balances, and vault positions.

```typescript
const status = await b402.status()
```

**Returns:** `StatusResult`

| Field | Type | Description |
|-------|------|-------------|
| `ownerEOA` | `string` | Incognito EOA address |
| `smartWallet` | `string` | Smart wallet address |
| `deployed` | `boolean` | Whether wallet is deployed |
| `chain` | `string` | Chain name |
| `balances` | `Array` | Smart wallet token balances |
| `shieldedBalances` | `Array` | Privacy pool balances (from Railgun UTXOs) |
| `positions` | `Array` | Vault positions with assets and APY |

---

### Static Helpers

```typescript
// List all supported vaults
B402.vaults
// [{ name: 'steakhouse', fullName: 'Steakhouse USDC', address: '0x...', curator: '...' }]

// List all supported tokens
B402.tokens
// [{ symbol: 'USDC', address: '0x...', decimals: 6 }]
```

---

## Constants

```typescript
import { BASE_TOKENS, BASE_CONTRACTS } from '@b402ai/sdk'

BASE_TOKENS.USDC.address  // '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
BASE_CONTRACTS.RAILGUN_RELAY  // '0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85'
```

## Error Handling

All methods throw on failure. Wrap in try/catch:

```typescript
try {
  await b402.swap({ from: 'USDC', to: 'WETH', amount: '10' })
} catch (err) {
  console.error('Swap failed:', err.message)
}
```

Common errors:
- `zeroXApiKey required for swaps` — Pass `zeroXApiKey` in constructor
- `Unknown token: X` — Use supported symbols: USDC, WETH, DAI
- `Unknown vault: X` — Use supported vaults: steakhouse, moonwell, gauntlet, steakhouse-hy
- `No shares in X` — No position in that vault
