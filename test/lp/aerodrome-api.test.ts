import { describe, it, expect, beforeEach } from 'vitest'
import { ethers } from 'ethers'
import * as dotenv from 'dotenv'
import {
  fetchAllPoolMetrics,
  clearPoolMetricsCache,
  getFallbackAPY,
  formatAPY,
  formatTVL,
} from '../../src/lp/aerodrome-api'

dotenv.config()

describe('aerodrome-api', () => {
  describe('formatters', () => {
    it('formatAPY formats decimal to percentage', () => {
      expect(formatAPY(0.076)).toBe('7.60%')
      expect(formatAPY(0.0381)).toBe('3.81%')
    })

    it('formatTVL formats USD values', () => {
      expect(formatTVL(11_350_000)).toBe('$11.3M')
      expect(formatTVL(285_500_000)).toBe('$285.5M')
      expect(formatTVL(190_000)).toBe('$190K')
      expect(formatTVL(1_500_000_000)).toBe('$1.5B')
    })
  })

  describe('fallback', () => {
    it('returns fallback for known pool', () => {
      const fb = getFallbackAPY('weth-usdc')
      expect(fb.midpoint).toBe(7.6)
      expect(fb.range).toBe('6-10%')
    })

    it('returns generic fallback for unknown pool', () => {
      const fb = getFallbackAPY('unknown')
      expect(fb.midpoint).toBe(7.5)
    })
  })

  describe('fetchAllPoolMetrics (integration)', () => {
    beforeEach(() => clearPoolMetricsCache())

    it('returns data for weth-usdc pool', async () => {
      const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
      const provider = new ethers.JsonRpcProvider(rpcUrl)

      const metrics = await fetchAllPoolMetrics(provider)
      if (!metrics) {
        // API/RPC might be unreachable in CI
        console.log('Skipping: RPC unreachable')
        return
      }

      const wethUsdc = metrics['weth-usdc']
      expect(wethUsdc).toBeDefined()
      expect(wethUsdc.apy).toBeGreaterThan(0)
      expect(wethUsdc.apyEmissions).toBeGreaterThan(0)
      expect(wethUsdc.tvlUsd).toBeGreaterThan(1_000_000) // >$1M TVL
      expect(wethUsdc.aeroPrice).toBeGreaterThan(0)

      console.log(`WETH/USDC: ${(wethUsdc.apy * 100).toFixed(1)}% APY, $${(wethUsdc.tvlUsd / 1e6).toFixed(1)}M TVL, AERO=$${wethUsdc.aeroPrice.toFixed(4)}`)
    }, 15000)

    it('returns cached result on second call', async () => {
      const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
      const provider = new ethers.JsonRpcProvider(rpcUrl)

      const first = await fetchAllPoolMetrics(provider)
      if (!first) return

      const second = await fetchAllPoolMetrics(provider)
      expect(second).toBe(first) // exact same reference = cached
    }, 15000)
  })
})
