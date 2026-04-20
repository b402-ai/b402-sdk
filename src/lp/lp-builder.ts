/**
 * LP Builder — Builds call arrays for Aerodrome liquidity operations
 *
 * addLiquidity: approve → swap half → approve WETH → addLiquidity → approve LP → gauge.deposit
 * removeLiquidity: getReward → withdraw → approve LP → removeLiquidity
 * claimRewards: getReward
 */

import { ethers } from 'ethers'
import type { Call } from '../wallet/batch-calldata'
import {
  ROUTER_LP_ABI,
  GAUGE_ABI,
  ERC20_INTERFACE,
  POOL_ABI,
  type AerodromePool,
  AERODROME_FACTORY,
} from './aerodrome-pools'
import { BASE_CONTRACTS } from '../types'

// ── Add Liquidity ──

export interface AddLiquidityCallsParams {
  pool: AerodromePool
  /** Full USDC amount (will be split: half swapped to WETH, half kept) */
  usdcAmount: bigint
  /** Pre-built swap calldata (from AerodromeProvider) */
  swapCalldata: { to: string; data: string; value: string }
  /** Expected WETH output from the swap */
  expectedWethOut: bigint
  /** USDC remaining for liquidity (usdcAmount - swapAmount) */
  usdcForLiquidity: bigint
  /** Min WETH for addLiquidity (after slippage) */
  amountAMin: bigint
  /** Min USDC for addLiquidity (after slippage) */
  amountBMin: bigint
  /** Address that receives LP tokens */
  recipient: string
  /** TX deadline (unix seconds) */
  deadline: bigint
}

/**
 * Build the 6-call batch for adding liquidity from single-token (USDC) input.
 *
 * 1. approve USDC → Router (for swap)
 * 2. swap half USDC → WETH
 * 3. approve WETH → Router (for addLiquidity)
 * 4. addLiquidity(WETH, USDC) → LP tokens
 * 5. approve LP → Gauge
 * 6. gauge.deposit(LP amount)
 *
 * Note: We approve max uint256 for LP → Gauge since we don't know exact LP output.
 */
export function buildAddLiquidityCalls(params: AddLiquidityCallsParams): Call[] {
  const {
    pool, usdcAmount, swapCalldata, expectedWethOut,
    usdcForLiquidity, amountAMin, amountBMin, recipient, deadline,
  } = params

  const router = BASE_CONTRACTS.AERODROME_ROUTER
  const maxUint = ethers.MaxUint256

  return [
    // 1. Approve full USDC to router (covers swap + addLiquidity)
    {
      to: pool.tokenB.address,
      value: '0',
      data: ERC20_INTERFACE.encodeFunctionData('approve', [router, usdcAmount]),
    },
    // 2. Swap half USDC → WETH
    {
      to: swapCalldata.to,
      value: swapCalldata.value,
      data: swapCalldata.data,
    },
    // 3. Approve WETH to router (for addLiquidity)
    {
      to: pool.tokenA.address,
      value: '0',
      data: ERC20_INTERFACE.encodeFunctionData('approve', [router, expectedWethOut]),
    },
    // 4. Add liquidity
    {
      to: router,
      value: '0',
      data: ROUTER_LP_ABI.encodeFunctionData('addLiquidity', [
        pool.tokenA.address, // tokenA = WETH
        pool.tokenB.address, // tokenB = USDC
        pool.stable,
        expectedWethOut,     // amountADesired
        usdcForLiquidity,    // amountBDesired
        amountAMin,
        amountBMin,
        recipient,
        deadline,
      ]),
    },
    // 5. Approve LP token to gauge (max — exact LP amount unknown at build time)
    {
      to: pool.poolAddress,
      value: '0',
      data: POOL_ABI.encodeFunctionData('approve', [pool.gaugeAddress, maxUint]),
    },
    // 6. Stake LP in gauge
    {
      to: pool.gaugeAddress,
      value: '0',
      data: GAUGE_ABI.encodeFunctionData('deposit', [maxUint]),
    },
  ]
}

// ── Remove Liquidity ──

export interface RemoveLiquidityCallsParams {
  pool: AerodromePool
  /** Staked LP amount in gauge */
  stakedAmount: bigint
  /** Unstaked LP amount on wallet */
  unstakedAmount: bigint
  /** Min WETH output (after slippage) */
  amountAMin: bigint
  /** Min USDC output (after slippage) */
  amountBMin: bigint
  /** Wallet address */
  wallet: string
  deadline: bigint
}

/**
 * Build the call batch for removing liquidity.
 *
 * 1. gauge.getReward(wallet) — claim AERO
 * 2. gauge.withdraw(stakedAmount) — unstake LP
 * 3. approve LP → Router
 * 4. removeLiquidity → WETH + USDC
 */
export function buildRemoveLiquidityCalls(params: RemoveLiquidityCallsParams): Call[] {
  const { pool, stakedAmount, unstakedAmount, amountAMin, amountBMin, wallet, deadline } = params
  const totalLP = stakedAmount + unstakedAmount
  const router = BASE_CONTRACTS.AERODROME_ROUTER
  const calls: Call[] = []

  // 1. Claim AERO rewards (if staked)
  if (stakedAmount > 0n) {
    calls.push({
      to: pool.gaugeAddress,
      value: '0',
      data: GAUGE_ABI.encodeFunctionData('getReward', [wallet]),
    })

    // 2. Unstake LP from gauge
    calls.push({
      to: pool.gaugeAddress,
      value: '0',
      data: GAUGE_ABI.encodeFunctionData('withdraw', [stakedAmount]),
    })
  }

  // 3. Approve LP to router
  calls.push({
    to: pool.poolAddress,
    value: '0',
    data: POOL_ABI.encodeFunctionData('approve', [router, totalLP]),
  })

  // 4. Remove liquidity
  calls.push({
    to: router,
    value: '0',
    data: ROUTER_LP_ABI.encodeFunctionData('removeLiquidity', [
      pool.tokenA.address,
      pool.tokenB.address,
      pool.stable,
      totalLP,
      amountAMin,
      amountBMin,
      wallet,
      deadline,
    ]),
  })

  return calls
}

// ── Claim Rewards ──

export function buildClaimRewardsCalls(gaugeAddress: string, wallet: string): Call[] {
  return [
    {
      to: gaugeAddress,
      value: '0',
      data: GAUGE_ABI.encodeFunctionData('getReward', [wallet]),
    },
  ]
}
