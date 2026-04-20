/**
 * Synthetix Perps V3 — Perpetual futures on Base (Andromeda)
 *
 * Flow: USDC → wrap to sUSDC → deposit margin → commit order → settle
 *
 * Architecture:
 *   PerpsMarketProxy handles accounts, margin, and orders
 *   SpotMarketProxy wraps USDC into sUSDC (1:1, zero fee)
 *   PythERC7412Wrapper provides oracle prices for settlement
 *   TrustedMulticallForwarder batches oracle update + settle
 *
 * Contracts (Base mainnet):
 *   PerpsMarketProxy:           0x0A2AF931eFFd34b81ebcc57E3d3c9B1E1dE1C9Ce
 *   SpotMarketProxy:            0x18141523403e2595D31b22604AcB8Fc06a4CaA61
 *   CoreProxy:                  0x32C222A9A159782aFD7529c87FA34b96CA72C696
 *   sUSDC:                      0xC74eA762cF06c9151cE074E6a569a5945b6302E7
 *   USDC:                       0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *   TrustedMulticallForwarder:  0xE2C5658cC5C448B48141168f3e475dF8f65A1e3e
 *   PythERC7412Wrapper:         0x9Cb0B428632fc7dC56FDf453aEd890BA55B1953a
 */

import { ethers } from 'ethers'

// ── Contract addresses ──────────────────────────────────────────────

export const SYNTHETIX_CONTRACTS = {
  PERPS_MARKET_PROXY: '0x0A2AF931eFFd34b81ebcc57E3d3c9B1E1dE1C9Ce',
  SPOT_MARKET_PROXY: '0x18141523403e2595D31b22604AcB8Fc06a4CaA61',
  CORE_PROXY: '0x32C222A9A159782aFD7529c87FA34b96CA72C696',
  SUSDC: '0xC74eA762cF06c9151cE074E6a569a5945b6302E7',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  MULTICALL_FORWARDER: '0xE2C5658cC5C448B48141168f3e475dF8f65A1e3e',
  PYTH_ERC7412_WRAPPER: '0x9Cb0B428632fc7dC56FDf453aEd890BA55B1953a',
} as const

// ── ABIs (minimal) ──────────────────────────────────────────────────

export const PERPS_MARKET_ABI = [
  // Account
  'function createAccount() returns (uint128 accountId)',
  'function createAccount(uint128 requestedAccountId)',
  'function getAccountOwner(uint128 accountId) view returns (address)',

  // Collateral
  'function modifyCollateral(uint128 accountId, uint128 collateralId, int256 amountDelta)',
  'function getCollateralAmount(uint128 accountId, uint128 collateralId) view returns (uint256)',
  'function totalCollateralValue(uint128 accountId) view returns (uint256)',
  'function getAvailableMargin(uint128 accountId) view returns (int256)',
  'function getWithdrawableMargin(uint128 accountId) view returns (int256)',

  // Orders
  `function commitOrder(tuple(
    uint128 marketId,
    uint128 accountId,
    int128 sizeDelta,
    uint128 settlementStrategyId,
    uint256 acceptablePrice,
    bytes32 trackingCode,
    address referrer
  ) commitment) returns (tuple(uint256 commitmentTime, tuple(uint128 marketId, uint128 accountId, int128 sizeDelta, uint128 settlementStrategyId, uint256 acceptablePrice, bytes32 trackingCode, address referrer) request) retOrder, uint256 fees)`,
  'function settleOrder(uint128 accountId)',
  'function cancelOrder(uint128 accountId)',

  // Positions
  'function getOpenPosition(uint128 accountId, uint128 marketId) view returns (int256 totalPnl, int256 accruedFunding, int128 positionSize, uint256 owedInterest)',
  'function getAccountOpenPositions(uint128 accountId) view returns (uint256[])',

  // Market data
  'function computeOrderFees(uint128 marketId, int128 sizeDelta) view returns (uint256 orderFees, uint256 fillPrice)',
  'function requiredMarginForOrder(uint128 accountId, uint128 marketId, int128 sizeDelta) view returns (uint256)',
  'function indexPrice(uint128 marketId) view returns (uint256)',

  // Liquidation
  'function canLiquidate(uint128 accountId) view returns (bool)',
]

export const SPOT_MARKET_ABI = [
  'function wrap(uint128 marketId, uint256 wrapAmount, uint256 minAmountReceived) returns (uint256 amountToMint, tuple(uint256 fixedFees, uint256 utilizationFees, int256 skewFees, int256 wrapperFees) fees)',
  'function unwrap(uint128 marketId, uint256 unwrapAmount, uint256 minAmountReceived) returns (uint256 returnCollateralAmount, tuple(uint256 fixedFees, uint256 utilizationFees, int256 skewFees, int256 wrapperFees) fees)',
]

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]

// sUSDC spot market ID (for wrapping)
const SUSDC_MARKET_ID = 1

// ── Market IDs ──────────────────────────────────────────────────────

export const PERPS_MARKETS: Record<string, number> = {
  ETH: 100,
  BTC: 200,
  SOL: 400,
  DOGE: 800,
  AVAX: 900,
  OP: 1000,
  PEPE: 1200,
  ARB: 1600,
  LINK: 1900,
  SUI: 2400,
  AAVE: 3300,
  SNX: 300,
  WIF: 500,
  BONK: 1400,
}

// ── Types ───────────────────────────────────────────────────────────

export type PerpSide = 'long' | 'short'

export interface PerpOrder {
  /** Market symbol (ETH, BTC, SOL, etc.) */
  market: string
  /** Long or short */
  side: PerpSide
  /** Size in base asset (e.g. '0.1' = 0.1 ETH) */
  size: string
  /** USDC margin to deposit */
  margin: string
  /** Max acceptable slippage in basis points (default: 100 = 1%) */
  slippageBps?: number
}

export interface PerpPosition {
  marketId: number
  market: string
  size: string
  pnl: string
  funding: string
  margin: string
}

export interface PerpAccountInfo {
  accountId: string
  margin: string
  availableMargin: string
  positions: PerpPosition[]
}

// ── Helpers ─────────────────────────────────────────────────────────

function resolveMarketId(market: string): number {
  const key = market.toUpperCase()
  const id = PERPS_MARKETS[key]
  if (!id) throw new Error(`Unsupported market: ${market}. Available: ${Object.keys(PERPS_MARKETS).join(', ')}`)
  return id
}

/**
 * Convert USDC amount (6 decimals) to sUSDC amount (18 decimals).
 * sUSDC wraps 1:1 but uses 18 decimal precision.
 */
function usdcToSusdc(usdcAmount: bigint): bigint {
  return usdcAmount * 10n ** 12n  // 6 -> 18 decimals
}

// ── Core Functions ──────────────────────────────────────────────────

/**
 * Build calls to create a Synthetix perps account.
 * Returns the createAccount call for the PerpsMarketProxy.
 */
export function buildCreateAccountCall(): { to: string; data: string; value: string } {
  const iface = new ethers.Interface(PERPS_MARKET_ABI)
  return {
    to: SYNTHETIX_CONTRACTS.PERPS_MARKET_PROXY,
    data: iface.encodeFunctionData('createAccount()'),
    value: '0',
  }
}

/**
 * Build calls to wrap USDC → sUSDC and deposit as perps margin.
 *
 * Steps:
 *   1. Approve USDC to SpotMarketProxy
 *   2. Wrap USDC → sUSDC (1:1, zero fee)
 *   3. Approve sUSDC to PerpsMarketProxy
 *   4. modifyCollateral (deposit sUSDC as margin)
 */
export function buildDepositMarginCalls(
  usdcAmount: bigint,
  accountId: bigint,
): Array<{ to: string; data: string; value: string }> {
  const erc20 = new ethers.Interface(ERC20_ABI)
  const spot = new ethers.Interface(SPOT_MARKET_ABI)
  const perps = new ethers.Interface(PERPS_MARKET_ABI)

  const susdcAmount = usdcToSusdc(usdcAmount)

  return [
    // 1. Approve USDC to SpotMarketProxy for wrapping
    {
      to: SYNTHETIX_CONTRACTS.USDC,
      data: erc20.encodeFunctionData('approve', [SYNTHETIX_CONTRACTS.SPOT_MARKET_PROXY, usdcAmount]),
      value: '0',
    },
    // 2. Wrap USDC → sUSDC
    {
      to: SYNTHETIX_CONTRACTS.SPOT_MARKET_PROXY,
      data: spot.encodeFunctionData('wrap', [SUSDC_MARKET_ID, usdcAmount, susdcAmount]),
      value: '0',
    },
    // 3. Approve sUSDC to PerpsMarketProxy
    {
      to: SYNTHETIX_CONTRACTS.SUSDC,
      data: erc20.encodeFunctionData('approve', [SYNTHETIX_CONTRACTS.PERPS_MARKET_PROXY, susdcAmount]),
      value: '0',
    },
    // 4. Deposit sUSDC as margin (collateralId = 1 for sUSDC)
    {
      to: SYNTHETIX_CONTRACTS.PERPS_MARKET_PROXY,
      data: perps.encodeFunctionData('modifyCollateral', [accountId, SUSDC_MARKET_ID, susdcAmount]),
      value: '0',
    },
  ]
}

/**
 * Build the commitOrder call for opening/modifying a perp position.
 *
 * @param order - Order parameters
 * @param accountId - Synthetix perps account ID
 * @param indexPrice - Current index price (18 decimals) for slippage calc
 */
export function buildCommitOrderCall(
  order: PerpOrder,
  accountId: bigint,
  indexPrice: bigint,
): { to: string; data: string; value: string } {
  const perps = new ethers.Interface(PERPS_MARKET_ABI)
  const marketId = resolveMarketId(order.market)

  // Size in 18 decimals, negative for short
  const sizeDelta = ethers.parseEther(order.size)
  const signedSize = order.side === 'short' ? -sizeDelta : sizeDelta

  // Acceptable price with slippage
  const slippageBps = BigInt(order.slippageBps ?? 100) // 1% default
  const acceptablePrice = order.side === 'long'
    ? indexPrice * (10000n + slippageBps) / 10000n  // max price for longs
    : indexPrice * (10000n - slippageBps) / 10000n  // min price for shorts

  const commitment = {
    marketId,
    accountId,
    sizeDelta: signedSize,
    settlementStrategyId: 0, // Pyth-based
    acceptablePrice,
    trackingCode: ethers.ZeroHash,
    referrer: ethers.ZeroAddress,
  }

  return {
    to: SYNTHETIX_CONTRACTS.PERPS_MARKET_PROXY,
    data: perps.encodeFunctionData('commitOrder', [commitment]),
    value: '0',
  }
}

/**
 * Build the withdraw margin calls: withdraw sUSDC → unwrap to USDC.
 */
export function buildWithdrawMarginCalls(
  susdcAmount: bigint,
  accountId: bigint,
): Array<{ to: string; data: string; value: string }> {
  const perps = new ethers.Interface(PERPS_MARKET_ABI)
  const spot = new ethers.Interface(SPOT_MARKET_ABI)

  // Convert 18-decimal sUSDC back to 6-decimal USDC for unwrap minAmount
  const usdcAmount = susdcAmount / 10n ** 12n

  return [
    // 1. Withdraw sUSDC from margin
    {
      to: SYNTHETIX_CONTRACTS.PERPS_MARKET_PROXY,
      data: perps.encodeFunctionData('modifyCollateral', [accountId, SUSDC_MARKET_ID, -susdcAmount]),
      value: '0',
    },
    // 2. Approve sUSDC to SpotMarketProxy for unwrapping
    {
      to: SYNTHETIX_CONTRACTS.SUSDC,
      data: new ethers.Interface(ERC20_ABI).encodeFunctionData('approve', [SYNTHETIX_CONTRACTS.SPOT_MARKET_PROXY, susdcAmount]),
      value: '0',
    },
    // 3. Unwrap sUSDC → USDC
    {
      to: SYNTHETIX_CONTRACTS.SPOT_MARKET_PROXY,
      data: spot.encodeFunctionData('unwrap', [SUSDC_MARKET_ID, susdcAmount, usdcAmount]),
      value: '0',
    },
  ]
}

/**
 * Read perps account info from chain.
 */
export async function getAccountInfo(
  accountId: bigint,
  provider: ethers.JsonRpcProvider,
): Promise<PerpAccountInfo> {
  const perps = new ethers.Contract(SYNTHETIX_CONTRACTS.PERPS_MARKET_PROXY, PERPS_MARKET_ABI, provider)

  const [totalMargin, availableMargin, openMarketIds] = await Promise.all([
    perps.totalCollateralValue(accountId) as Promise<bigint>,
    perps.getAvailableMargin(accountId) as Promise<bigint>,
    perps.getAccountOpenPositions(accountId) as Promise<bigint[]>,
  ])

  const positions: PerpPosition[] = []
  for (const mid of openMarketIds) {
    const marketId = Number(mid)
    const marketName = Object.entries(PERPS_MARKETS).find(([, id]) => id === marketId)?.[0] ?? `ID:${marketId}`

    const [pnl, funding, size] = await perps.getOpenPosition(accountId, marketId) as [bigint, bigint, bigint, bigint]

    if (size !== 0n) {
      positions.push({
        marketId,
        market: marketName,
        size: ethers.formatEther(size),
        pnl: ethers.formatEther(pnl),
        funding: ethers.formatEther(funding),
        margin: ethers.formatEther(totalMargin),
      })
    }
  }

  return {
    accountId: accountId.toString(),
    margin: ethers.formatEther(totalMargin),
    availableMargin: ethers.formatEther(availableMargin),
    positions,
  }
}

/**
 * Get the current index price for a market (18 decimals).
 */
export async function getIndexPrice(
  market: string,
  provider: ethers.JsonRpcProvider,
): Promise<bigint> {
  const perps = new ethers.Contract(SYNTHETIX_CONTRACTS.PERPS_MARKET_PROXY, PERPS_MARKET_ABI, provider)
  const marketId = resolveMarketId(market)
  return perps.indexPrice(marketId) as Promise<bigint>
}

/**
 * Get order fees and fill price for a potential order.
 */
export async function computeOrderFees(
  market: string,
  size: string,
  side: PerpSide,
  provider: ethers.JsonRpcProvider,
): Promise<{ fees: string; fillPrice: string }> {
  const perps = new ethers.Contract(SYNTHETIX_CONTRACTS.PERPS_MARKET_PROXY, PERPS_MARKET_ABI, provider)
  const marketId = resolveMarketId(market)
  const sizeDelta = ethers.parseEther(size)
  const signedSize = side === 'short' ? -sizeDelta : sizeDelta

  const [orderFees, fillPrice] = await perps.computeOrderFees(marketId, signedSize) as [bigint, bigint]
  return {
    fees: ethers.formatEther(orderFees),
    fillPrice: ethers.formatEther(fillPrice),
  }
}
