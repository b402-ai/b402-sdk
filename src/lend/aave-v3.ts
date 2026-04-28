/**
 * Aave V3 Lending — chain-aware
 *
 * Pool addresses + aToken registry sourced from bgd-labs/aave-address-book.
 * Native USDC only on Arb (USDC.e is being deprecated).
 *
 * Call shape (matches Morpho adapter to keep `executeCrossContractCall` clean):
 *
 *   supply:
 *     USDC.approve(Pool, amount)
 *     Pool.supply(USDC, amount, recipient, 0)        ← receipt: aUSDC at recipient
 *
 *   withdraw:
 *     Pool.withdraw(USDC, type(uint256).max, recipient)   ← burns msg.sender's aUSDC
 *
 * Known caveat (documented for callers):
 *   aToken interest accrued *while shielded* leaks to the RailgunVault, not to
 *   the user's UTXO (the UTXO value is fixed at shield time). Sub-bps for
 *   short holds; v2 harvester to come.
 */

import { ethers } from 'ethers'

export interface AaveMarket {
  /** ERC20 underlying (e.g. native USDC) */
  underlying: string
  /** aToken (rebasing receipt token) */
  aToken: string
  /** Aave V3 Pool entrypoint on this chain */
  pool: string
  /** Friendly market display name */
  name: string
  /** Underlying decimals (for amount parsing) */
  decimals: number
  /** Underlying token symbol */
  symbol: string
}

const BASE_MARKETS: Record<string, AaveMarket> = {
  usdc: {
    underlying: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // native USDC
    aToken: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB',
    pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    name: 'Aave V3 USDC (Base)',
    decimals: 6,
    symbol: 'USDC',
  },
}

const ARB_MARKETS: Record<string, AaveMarket> = {
  usdc: {
    underlying: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // native USDC
    aToken: '0x724dc807b04555b71ed48a6896b6F41593b8C637',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    name: 'Aave V3 USDC (Arbitrum)',
    decimals: 6,
    symbol: 'USDC',
  },
}

export const AAVE_V3_BY_CHAIN: Record<number, Record<string, AaveMarket>> = {
  8453: BASE_MARKETS,
  42161: ARB_MARKETS,
}

export const AAVE_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external',
  'function withdraw(address asset, uint256 amount, address to) external returns (uint256)',
  'function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
] as const

const ERC20_APPROVE_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
]

const POOL_INTERFACE = new ethers.Interface(AAVE_POOL_ABI)
const ERC20_INTERFACE = new ethers.Interface(ERC20_APPROVE_ABI)

const MAX_UINT256 = (1n << 256n) - 1n

/**
 * Resolve a market name on a chain. Aave's market keys are token symbols
 * (lowercase), e.g. `usdc`. Throws on unknown chain or market.
 */
export function resolveAaveMarket(name: string, chainId: number): AaveMarket {
  const markets = AAVE_V3_BY_CHAIN[chainId]
  if (!markets) {
    throw new Error(
      `Aave V3 is not configured for chainId ${chainId}. Supported: ${Object.keys(AAVE_V3_BY_CHAIN).join(', ')}`,
    )
  }
  const key = name.toLowerCase()
  if (markets[key]) return markets[key]
  // Allow lookup by underlying or aToken address as a fallback.
  for (const m of Object.values(markets)) {
    if (m.underlying.toLowerCase() === key) return m
    if (m.aToken.toLowerCase() === key) return m
  }
  throw new Error(
    `Unknown Aave V3 market "${name}" on chainId ${chainId}. Available: ${Object.keys(markets).join(', ')}`,
  )
}

export interface Call {
  to: string
  data: string
  value: string
}

/**
 * Build the source-side calls for an Aave V3 supply.
 * Produces [approve, supply] — RelayAdapt becomes the aToken holder.
 */
export function buildAaveSupplyCalls(params: {
  market: AaveMarket
  amount: bigint
  recipient: string
}): Call[] {
  const { market, amount, recipient } = params
  return [
    {
      to: market.underlying,
      data: ERC20_INTERFACE.encodeFunctionData('approve', [market.pool, amount]),
      value: '0',
    },
    {
      to: market.pool,
      data: POOL_INTERFACE.encodeFunctionData('supply', [
        market.underlying,
        amount,
        recipient,
        0, // referralCode
      ]),
      value: '0',
    },
  ]
}

/**
 * Build the source-side calls for an Aave V3 withdraw.
 * Single call: Pool.withdraw with type(uint256).max sentinel —
 * Aave burns ALL aToken balance held by msg.sender (= RelayAdapt) and
 * sends underlying to `recipient`. No approval needed.
 */
export function buildAaveWithdrawCalls(params: {
  market: AaveMarket
  recipient: string
}): Call[] {
  const { market, recipient } = params
  return [
    {
      to: market.pool,
      data: POOL_INTERFACE.encodeFunctionData('withdraw', [
        market.underlying,
        MAX_UINT256,
        recipient,
      ]),
      value: '0',
    },
  ]
}
