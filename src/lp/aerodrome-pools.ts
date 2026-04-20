/**
 * Aerodrome Pool Registry — Classic AMM pools on Base
 *
 * Each pool is a volatile or stable AMM pool on Aerodrome.
 * LP tokens are standard ERC-20 (can be shielded in Railgun).
 * Gauge contracts stake LP tokens to earn AERO emissions.
 *
 * Pool: 0xcDAC0d6c6C59727a65F871236188350531885C43 (WETH/USDC volatile)
 * Gauge: 0x519BBD1Dd8C6A94C46080E24f316c14Ee758C025
 */

import { ethers } from 'ethers'
import { BASE_TOKENS, BASE_CONTRACTS } from '../types'

// ── Token ──

export const AERO_TOKEN = {
  address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' as const,
  symbol: 'AERO' as const,
  decimals: 18,
}

// ── Pool Config ──

export interface AerodromePool {
  poolAddress: string
  gaugeAddress: string
  name: string
  tokenA: { address: string; symbol: string; decimals: number }
  tokenB: { address: string; symbol: string; decimals: number }
  stable: boolean
  lpDecimals: number
}

export const AERODROME_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da'

export const AERODROME_POOLS: Record<string, AerodromePool> = {
  'weth-usdc': {
    poolAddress: '0xcDAC0d6c6C59727a65F871236188350531885C43',
    gaugeAddress: '0x519BBD1Dd8C6A94C46080E24f316c14Ee758C025',
    name: 'WETH/USDC Volatile',
    tokenA: { address: BASE_TOKENS.WETH.address, symbol: 'WETH', decimals: 18 },
    tokenB: { address: BASE_TOKENS.USDC.address, symbol: 'USDC', decimals: 6 },
    stable: false,
    lpDecimals: 18,
  },
}

// ── ABIs ──

export const ROUTER_LP_ABI = new ethers.Interface([
  'function addLiquidity(address tokenA, address tokenB, bool stable, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, bool stable, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
  'function quoteAddLiquidity(address tokenA, address tokenB, bool stable, address factory, uint256 amountADesired, uint256 amountBDesired) view returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function quoteRemoveLiquidity(address tokenA, address tokenB, bool stable, address factory, uint256 liquidity) view returns (uint256 amountA, uint256 amountB)',
])

export const POOL_ABI = new ethers.Interface([
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

export const GAUGE_ABI = new ethers.Interface([
  'function deposit(uint256 amount)',
  'function withdraw(uint256 amount)',
  'function getReward(address account)',
  'function earned(address account) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function rewardRate() view returns (uint256)',
])

export const ERC20_INTERFACE = new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
])

// ── Helpers ──

export function resolvePool(nameOrAddress: string): AerodromePool {
  const key = nameOrAddress.toLowerCase()
  if (AERODROME_POOLS[key]) return AERODROME_POOLS[key]

  for (const pool of Object.values(AERODROME_POOLS)) {
    if (pool.poolAddress.toLowerCase() === key) return pool
  }

  throw new Error(
    `Unknown pool: ${nameOrAddress}. Available: ${Object.keys(AERODROME_POOLS).join(', ')}`,
  )
}

/**
 * Apply slippage to an amount: amount * (10000 - bps) / 10000
 */
export function applySlippage(amount: bigint, slippageBps: number): bigint {
  if (slippageBps === 0) return amount
  return amount * BigInt(10000 - slippageBps) / 10000n
}
