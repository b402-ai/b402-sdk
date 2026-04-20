/**
 * Fee Calculator — Railgun Unshield Fee + B402 Protocol Fees
 *
 * All math uses BigInt exclusively — zero floating point.
 *
 * b402 Railgun fork has 0% unshield fee (upstream Railgun charges 0.25%).
 * B402 charges a tiered protocol fee: base ($0.05) + volume tier (5-10 bps).
 */

import type { FeeBreakdown, FeeTier } from '../types'

/** Railgun unshield fee: 0 basis points (b402 fork — no protocol fees) */
const DEFAULT_UNSHIELD_FEE_BPS = 0n

/** Base fee denominators */
const BPS_DENOMINATOR = 10000n

/** ETH price estimate for 18-decimal fee calculation (~$2700) */
const ETH_PRICE_USD = 2700

/**
 * Calculate the gross unshield amount needed so that after Railgun's fee,
 * the net amount equals `desiredNetAmount`.
 *
 * Formula: gross = ceil(desired * 10000 / (10000 - feeBps))
 *
 * @param desiredNetAmount - Amount you want AFTER the fee (in token's smallest unit)
 * @param feeBps - Fee in basis points (default: 0 on b402 fork)
 * @returns Gross amount to unshield
 */
export function calculateUnshieldAmount(
  desiredNetAmount: bigint,
  feeBps: bigint = DEFAULT_UNSHIELD_FEE_BPS,
): bigint {
  if (feeBps === 0n) return desiredNetAmount
  if (desiredNetAmount === 0n) return 0n

  const netBps = BPS_DENOMINATOR - feeBps

  // Ceiling division: (a * b + (c - 1)) / c
  return (desiredNetAmount * BPS_DENOMINATOR + netBps - 1n) / netBps
}

/**
 * Calculate the net amount after Railgun's unshield fee is deducted.
 *
 * Formula: net = gross * (10000 - feeBps) / 10000
 *
 * @param grossAmount - Amount being unshielded (before fee)
 * @param feeBps - Fee in basis points (default: 0 on b402 fork)
 * @returns Net amount after fee deduction
 */
export function calculateNetAfterUnshieldFee(
  grossAmount: bigint,
  feeBps: bigint = DEFAULT_UNSHIELD_FEE_BPS,
): bigint {
  if (feeBps === 0n) return grossAmount
  return grossAmount * (BPS_DENOMINATOR - feeBps) / BPS_DENOMINATOR
}

/**
 * Determine the fee tier based on the USD value of the amount.
 *
 * Tiers (from base-volume-loop-gasless-v2.ts):
 * - small:  < $1,000  → 5 bps (0.05%)
 * - medium: $1k-$10k  → 8 bps (0.08%)
 * - large:  > $10,000 → 10 bps (0.10%)
 *
 * @param amount - Amount in token's smallest unit
 * @param decimals - Token decimals (6 for USDC, 18 for WETH)
 * @returns Fee tier
 */
export function getFeeTier(amount: bigint, decimals: number): FeeTier {
  const usdValue = decimals === 6
    ? Number(amount) / 1e6
    : Number(amount) * ETH_PRICE_USD / 1e18

  if (usdValue >= 10_000) return 'large'
  if (usdValue >= 1_000) return 'medium'
  return 'small'
}

/** Basis points per tier */
const TIER_BPS: Record<FeeTier, number> = {
  small: 5,   // 0.05%
  medium: 8,  // 0.08%
  large: 10,  // 0.10%
}

/**
 * Calculate the B402 protocol fee for a given amount.
 *
 * Fee = baseFee + volumeFee
 * - baseFee: flat $0.05 (in token's smallest unit)
 * - volumeFee: amount * tierBps / 10000
 *
 * @param amount - Amount in token's smallest unit
 * @param decimals - Token decimals (6 for USDC, 18 for WETH)
 * @returns Fee breakdown with total, base, volume, and tier rate
 */
export function calculateB402Fee(amount: bigint, decimals: number): FeeBreakdown {
  // Base fee: $0.05 in token units
  const baseFee = decimals === 6
    ? 50000n                // $0.05 in 6-decimal token
    : 18518518518n          // ~$0.05 at $2700/ETH in 18-decimal

  const tier = getFeeTier(amount, decimals)
  const bps = TIER_BPS[tier]

  const volumeFee = amount * BigInt(bps) / BPS_DENOMINATOR

  return {
    totalFee: baseFee + volumeFee,
    baseFee,
    volumeFee,
    tierBps: bps,
  }
}
