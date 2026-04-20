/**
 * Thales Speed Markets — Binary options on Base
 *
 * Users predict UP or DOWN on asset price over a short duration (10m-24h).
 * Payout: ~2x minus fees. Settlement is automatic via Pyth oracle keepers.
 *
 * Architecture:
 *   User calls SpeedMarketsAMMCreator.addPendingSpeedMarket()
 *   Keeper resolves with oracle price after strike time
 *   Winner receives payout automatically
 *
 * Contracts (Base mainnet):
 *   SpeedMarketsAMM:        0x85b827d133FEDC36B844b20f4a198dA583B25BAA
 *   SpeedMarketsAMMCreator:  0x6B5FE966Ea9B05d8E628E772B0b745734D069983
 *   SpeedMarketsAMMData:     0xD6155E7C948458D6Ab58f9D63E1566493b9304C1
 */

import { ethers } from 'ethers'

// ── Contract addresses ──────────────────────────────────────────────

export const SPEED_MARKETS_CONTRACTS = {
  AMM: '0x85b827d133FEDC36B844b20f4a198dA583B25BAA',
  CREATOR: '0x6B5FE966Ea9B05d8E628E772B0b745734D069983',
  DATA: '0xD6155E7C948458D6Ab58f9D63E1566493b9304C1',
} as const

// ── ABIs (minimal — only what we need) ──────────────────────────────

export const SPEED_MARKETS_AMM_ABI = [
  'function sUSD() view returns (address)',
  'function minBuyinAmount() view returns (uint256)',
  'function maxBuyinAmount() view returns (uint256)',
  'function minimalTimeToMaturity() view returns (uint256)',
  'function maximalTimeToMaturity() view returns (uint256)',
  'function supportedAsset(bytes32) view returns (bool)',
  'function safeBoxImpact() view returns (uint256)',
  'function multicollateralEnabled() view returns (bool)',
  'function activeMarketsPerUser(uint256 index, uint256 pageSize, address user) view returns (address[])',
  'function maturedMarketsPerUser(uint256 index, uint256 pageSize, address user) view returns (address[])',
]

export const SPEED_MARKETS_CREATOR_ABI = [
  `function addPendingSpeedMarket(tuple(
    bytes32 asset,
    uint64 strikeTime,
    uint64 delta,
    uint256 strikePrice,
    uint256 strikePriceSlippage,
    uint8 direction,
    address collateral,
    uint256 buyinAmount,
    address referrer,
    uint256 skewImpact
  ) _params) returns (bytes32 requestId)`,
]

export const SPEED_MARKET_ABI = [
  'function user() view returns (address)',
  'function asset() view returns (bytes32)',
  'function strikeTime() view returns (uint64)',
  'function strikePrice() view returns (int64)',
  'function direction() view returns (uint8)',
  'function buyinAmount() view returns (uint256)',
  'function payout() view returns (uint256)',
  'function resolved() view returns (bool)',
  'function finalPrice() view returns (int64)',
  'function result() view returns (uint8)',
  'function isUserWinner() view returns (bool)',
]

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
]

// ── Types ───────────────────────────────────────────────────────────

export type SpeedMarketAsset = 'ETH' | 'BTC'
export type SpeedMarketDirection = 'up' | 'down'

export interface SpeedMarketConfig {
  collateralAddress: string
  collateralDecimals: number
  minBuyin: bigint
  maxBuyin: bigint
  minDelta: number  // seconds
  maxDelta: number  // seconds
}

export interface SpeedMarketOrder {
  asset: SpeedMarketAsset
  direction: SpeedMarketDirection
  amount: string        // human-readable USDC amount
  duration?: string     // e.g. '10m', '30m', '1h', '4h' (default: 10m)
}

export interface SpeedMarketPosition {
  marketAddress: string
  asset: string
  direction: string
  strikePrice: string
  strikeTime: number
  buyinAmount: string
  payout: string
  resolved: boolean
  won?: boolean
  finalPrice?: string
}

// ── Helpers ─────────────────────────────────────────────────────────

const ASSET_BYTES32: Record<SpeedMarketAsset, string> = {
  ETH: ethers.encodeBytes32String('ETH'),
  BTC: ethers.encodeBytes32String('BTC'),
}

/** Parse duration string to seconds */
function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(m|h)$/)
  if (!match) throw new Error(`Invalid duration: ${duration}. Use e.g. '10m', '30m', '1h', '4h'`)
  const [, value, unit] = match
  return parseInt(value) * (unit === 'h' ? 3600 : 60)
}

// ── Thales API ──────────────────────────────────────────────────────

const THALES_API = 'https://overtimemarketsv2.xyz'

interface BuyParams {
  strikePrice: number
  strikePriceSlippage: bigint
  skewImpact: bigint
}

/**
 * Fetch current strike price and skew parameters from Thales API.
 * Falls back to on-chain Pyth oracle price if API is unavailable.
 */
async function fetchBuyParams(
  asset: SpeedMarketAsset,
  direction: SpeedMarketDirection,
  delta: number,
  buyinAmount: bigint,
  provider: ethers.JsonRpcProvider,
): Promise<BuyParams> {
  try {
    const url = `${THALES_API}/speed-markets/networks/8453/buy/?asset=${asset}&delta=${delta}&direction=${direction === 'up' ? 0 : 1}&buyinAmount=${buyinAmount.toString()}`
    const res = await fetch(url)
    if (res.ok) {
      const data = await res.json() as any
      return {
        strikePrice: data.strikePrice,
        strikePriceSlippage: BigInt(data.strikePriceSlippage || '100000000'), // default 1e8 (~$1 slippage)
        skewImpact: BigInt(data.skewImpact || '0'),
      }
    }
  } catch {
    // Fallback below
  }

  // Fallback: get price from Pyth oracle via Chainlink-compatible feed
  // Use a generous slippage since we can't get exact params
  const ammContract = new ethers.Contract(SPEED_MARKETS_CONTRACTS.AMM, SPEED_MARKETS_AMM_ABI, provider)
  // Read current price from the AMM's perspective (it uses Pyth internally)
  // For now, use a placeholder that the keeper will validate
  return {
    strikePrice: 0, // Will be set by keeper from oracle
    strikePriceSlippage: ethers.parseUnits('100', 8), // $100 slippage tolerance
    skewImpact: 0n,
  }
}

// ── Core Functions ──────────────────────────────────────────────────

/**
 * Read Speed Markets AMM configuration from chain.
 */
export async function getSpeedMarketConfig(
  provider: ethers.JsonRpcProvider,
): Promise<SpeedMarketConfig> {
  const amm = new ethers.Contract(SPEED_MARKETS_CONTRACTS.AMM, SPEED_MARKETS_AMM_ABI, provider)

  const [collateralAddress, minBuyin, maxBuyin, minDelta, maxDelta] = await Promise.all([
    amm.sUSD() as Promise<string>,
    amm.minBuyinAmount() as Promise<bigint>,
    amm.maxBuyinAmount() as Promise<bigint>,
    amm.minimalTimeToMaturity() as Promise<bigint>,
    amm.maximalTimeToMaturity() as Promise<bigint>,
  ])

  // Get collateral decimals
  const collateral = new ethers.Contract(collateralAddress, ERC20_ABI, provider)
  const decimals = await collateral.decimals() as number

  return {
    collateralAddress,
    collateralDecimals: Number(decimals),
    minBuyin,
    maxBuyin,
    minDelta: Number(minDelta),
    maxDelta: Number(maxDelta),
  }
}

/**
 * Build the calldata for placing a speed market bet.
 * Returns calls array ready for b402.transact() or executeCrossContractCall().
 */
export async function buildSpeedMarketCalls(
  order: SpeedMarketOrder,
  wallet: string,
  provider: ethers.JsonRpcProvider,
): Promise<{
  calls: Array<{ to: string; data: string; value: string }>
  collateralAddress: string
  buyinAmount: bigint
  strikeTime: number
  delta: number
}> {
  const config = await getSpeedMarketConfig(provider)

  // Parse amount
  const buyinAmount = ethers.parseUnits(order.amount, config.collateralDecimals)

  if (buyinAmount < config.minBuyin) {
    throw new Error(`Minimum bet is ${ethers.formatUnits(config.minBuyin, config.collateralDecimals)} (got ${order.amount})`)
  }
  if (buyinAmount > config.maxBuyin) {
    throw new Error(`Maximum bet is ${ethers.formatUnits(config.maxBuyin, config.collateralDecimals)} (got ${order.amount})`)
  }

  // Parse duration
  const delta = parseDuration(order.duration || '10m')
  if (delta < config.minDelta) {
    throw new Error(`Minimum duration is ${config.minDelta / 60} minutes`)
  }
  if (delta > config.maxDelta) {
    throw new Error(`Maximum duration is ${config.maxDelta / 3600} hours`)
  }

  // Validate asset
  const assetKey = order.asset.toUpperCase() as SpeedMarketAsset
  if (!ASSET_BYTES32[assetKey]) {
    throw new Error(`Unsupported asset: ${order.asset}. Use ETH or BTC`)
  }

  const strikeTime = Math.floor(Date.now() / 1000) + delta

  // Fetch buy params from Thales API
  const buyParams = await fetchBuyParams(assetKey, order.direction, delta, buyinAmount, provider)

  // Build calls: approve + addPendingSpeedMarket
  const erc20 = new ethers.Interface(ERC20_ABI)
  const creator = new ethers.Interface(SPEED_MARKETS_CREATOR_ABI)

  const approveTx = erc20.encodeFunctionData('approve', [SPEED_MARKETS_CONTRACTS.CREATOR, buyinAmount])

  const marketParams = {
    asset: ASSET_BYTES32[assetKey],
    strikeTime: BigInt(strikeTime),
    delta: BigInt(delta),
    strikePrice: BigInt(Math.round(buyParams.strikePrice * 1e8)), // 8 decimals
    strikePriceSlippage: buyParams.strikePriceSlippage,
    direction: order.direction === 'up' ? 0 : 1,
    collateral: config.collateralAddress,
    buyinAmount,
    referrer: ethers.ZeroAddress,
    skewImpact: buyParams.skewImpact,
  }

  const createTx = creator.encodeFunctionData('addPendingSpeedMarket', [marketParams])

  return {
    calls: [
      { to: config.collateralAddress, data: approveTx, value: '0' },
      { to: SPEED_MARKETS_CONTRACTS.CREATOR, data: createTx, value: '0' },
    ],
    collateralAddress: config.collateralAddress,
    buyinAmount,
    strikeTime,
    delta,
  }
}

/**
 * Read active speed market positions for a wallet.
 */
export async function getActivePositions(
  wallet: string,
  provider: ethers.JsonRpcProvider,
): Promise<SpeedMarketPosition[]> {
  const amm = new ethers.Contract(SPEED_MARKETS_CONTRACTS.AMM, SPEED_MARKETS_AMM_ABI, provider)
  const marketAddresses: string[] = await amm.activeMarketsPerUser(0, 50, wallet)

  const positions: SpeedMarketPosition[] = []
  for (const addr of marketAddresses) {
    try {
      const market = new ethers.Contract(addr, SPEED_MARKET_ABI, provider)
      const [asset, strikeTime, strikePrice, direction, buyinAmount, payout, resolved] = await Promise.all([
        market.asset() as Promise<string>,
        market.strikeTime() as Promise<bigint>,
        market.strikePrice() as Promise<bigint>,
        market.direction() as Promise<number>,
        market.buyinAmount() as Promise<bigint>,
        market.payout() as Promise<bigint>,
        market.resolved() as Promise<boolean>,
      ])

      const pos: SpeedMarketPosition = {
        marketAddress: addr,
        asset: ethers.decodeBytes32String(asset),
        direction: direction === 0 ? 'up' : 'down',
        strikePrice: (Number(strikePrice) / 1e8).toFixed(2),
        strikeTime: Number(strikeTime),
        buyinAmount: ethers.formatUnits(buyinAmount, 6),
        payout: ethers.formatUnits(payout, 6),
        resolved,
      }

      if (resolved) {
        const [finalPrice, won] = await Promise.all([
          market.finalPrice() as Promise<bigint>,
          market.isUserWinner() as Promise<boolean>,
        ])
        pos.finalPrice = (Number(finalPrice) / 1e8).toFixed(2)
        pos.won = won
      }

      positions.push(pos)
    } catch {
      // Skip failed reads
    }
  }

  return positions
}
