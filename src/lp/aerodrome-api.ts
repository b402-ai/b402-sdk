/**
 * Aerodrome APY Engine — computes yield on-chain from gauge + pool data
 *
 * APY = (gauge.rewardRate × AERO_price × 365 × 86400) / poolTVL + feeAPY
 *
 * Uses the existing Aerodrome router to price AERO in USDC.
 * Caches results for 5 minutes (LP APY moves slowly).
 */

import { ethers } from 'ethers'
import { AERODROME_POOLS, AERODROME_FACTORY, AERO_TOKEN, GAUGE_ABI, POOL_ABI } from './aerodrome-pools'
import { BASE_TOKENS, BASE_CONTRACTS } from '../types'
import { formatAPY, formatTVL } from '../lend/morpho-api'

export { formatAPY, formatTVL }

export interface PoolMetrics {
  /** Total APY as decimal (0.076 = 7.6%) — emissions + estimated fees */
  apy: number
  /** Emission APY as decimal */
  apyEmissions: number
  /** Fee APY as decimal (estimated from recent data) */
  apyFees: number
  /** TVL in USD */
  tvlUsd: number
  /** AERO price in USD */
  aeroPrice: number
}

// ── Cache ──

const CACHE_TTL_MS = 300_000 // 5 minutes

let cachedMetrics: Record<string, PoolMetrics> | null = null
let cacheTimestamp = 0

function getCached(): Record<string, PoolMetrics> | null {
  if (cachedMetrics && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedMetrics
  }
  return null
}

function setCache(data: Record<string, PoolMetrics>): void {
  cachedMetrics = data
  cacheTimestamp = Date.now()
}

/** Clear cache (for testing) */
export function clearPoolMetricsCache(): void {
  cachedMetrics = null
  cacheTimestamp = 0
}

// ── Fallback ──

const FALLBACK_METRICS: Record<string, { range: string; midpoint: number }> = {
  'weth-usdc': { range: '6-10%', midpoint: 7.6 },
}

export function getFallbackAPY(poolKey: string): { range: string; midpoint: number } {
  return FALLBACK_METRICS[poolKey] || { range: '5-10%', midpoint: 7.5 }
}

// ── On-chain APY Computation ──

/**
 * Get AERO price in USD via Aerodrome router getAmountsOut.
 */
async function getAeroPrice(provider: ethers.Provider): Promise<number> {
  const routerIface = new ethers.Interface([
    'function getAmountsOut(uint256 amountIn, tuple(address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
  ])

  const calldata = routerIface.encodeFunctionData('getAmountsOut', [
    ethers.parseUnits('1', 18),
    [{ from: AERO_TOKEN.address, to: BASE_TOKENS.USDC.address, stable: false, factory: AERODROME_FACTORY }],
  ])

  const result = await provider.call({ to: BASE_CONTRACTS.AERODROME_ROUTER, data: calldata })
  const [amounts] = routerIface.decodeFunctionResult('getAmountsOut', result)
  return Number(ethers.formatUnits(amounts[1], 6))
}

/**
 * Get WETH price in USD via Aerodrome router.
 */
async function getWethPrice(provider: ethers.Provider): Promise<number> {
  const routerIface = new ethers.Interface([
    'function getAmountsOut(uint256 amountIn, tuple(address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
  ])

  const calldata = routerIface.encodeFunctionData('getAmountsOut', [
    ethers.parseUnits('1', 18),
    [{ from: BASE_TOKENS.WETH.address, to: BASE_TOKENS.USDC.address, stable: false, factory: AERODROME_FACTORY }],
  ])

  const result = await provider.call({ to: BASE_CONTRACTS.AERODROME_ROUTER, data: calldata })
  const [amounts] = routerIface.decodeFunctionResult('getAmountsOut', result)
  return Number(ethers.formatUnits(amounts[1], 6))
}

/**
 * Fetch metrics for all registered pools using on-chain data.
 * Returns null on failure (callers should use fallback).
 */
export async function fetchAllPoolMetrics(
  provider: ethers.Provider,
): Promise<Record<string, PoolMetrics> | null> {
  const cached = getCached()
  if (cached) return cached

  try {
    const [aeroPrice, wethPrice] = await Promise.all([
      getAeroPrice(provider),
      getWethPrice(provider),
    ])

    const result: Record<string, PoolMetrics> = {}

    for (const [key, pool] of Object.entries(AERODROME_POOLS)) {
      const poolContract = new ethers.Contract(pool.poolAddress, POOL_ABI, provider)
      const gaugeContract = new ethers.Contract(pool.gaugeAddress, GAUGE_ABI, provider)

      const [reserves, rewardRate] = await Promise.all([
        poolContract.getReserves() as Promise<[bigint, bigint, bigint]>,
        gaugeContract.rewardRate() as Promise<bigint>,
      ])

      // Calculate TVL: reserve0 (WETH) * wethPrice + reserve1 (USDC)
      const tvlUsd =
        Number(ethers.formatUnits(reserves[0], pool.tokenA.decimals)) * wethPrice +
        Number(ethers.formatUnits(reserves[1], pool.tokenB.decimals))

      // Emission APY: rewardRate * AERO_price * seconds_per_year / TVL
      const yearlyAeroUsd = Number(ethers.formatUnits(rewardRate, 18)) * 86400 * 365 * aeroPrice
      const apyEmissions = tvlUsd > 0 ? yearlyAeroUsd / tvlUsd : 0

      // Fee APY: estimated ~1% for WETH/USDC (based on historical data)
      const apyFees = 0.01

      result[key] = {
        apy: apyEmissions + apyFees,
        apyEmissions,
        apyFees,
        tvlUsd,
        aeroPrice,
      }
    }

    setCache(result)
    return result
  } catch {
    return null
  }
}

/**
 * Fetch metrics for a single pool by key.
 */
export async function fetchPoolMetrics(
  key: string,
  provider: ethers.Provider,
): Promise<PoolMetrics | null> {
  const all = await fetchAllPoolMetrics(provider)
  return all?.[key] ?? null
}
