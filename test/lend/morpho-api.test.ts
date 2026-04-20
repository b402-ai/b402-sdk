import { describe, it, expect } from 'vitest'
import { fetchAllVaultMetrics, fetchVaultMetrics, formatTVL, formatAPY } from '../../src/lend/morpho-api'

describe('morpho-api', () => {
  describe('formatTVL', () => {
    it('formats billions', () => expect(formatTVL(1_500_000_000)).toBe('$1.5B'))
    it('formats millions', () => expect(formatTVL(285_500_000)).toBe('$285.5M'))
    it('formats thousands', () => expect(formatTVL(190_000)).toBe('$190K'))
    it('formats small amounts', () => expect(formatTVL(500)).toBe('$500'))
  })

  describe('formatAPY', () => {
    it('formats decimal as percentage', () => expect(formatAPY(0.0357)).toBe('3.57%'))
    it('formats zero', () => expect(formatAPY(0)).toBe('0.00%'))
  })

  describe('fetchAllVaultMetrics (integration)', () => {
    it('returns data for all 4 vaults', async () => {
      const data = await fetchAllVaultMetrics(8453)
      if (!data) return // skip if API unreachable

      expect(Object.keys(data)).toContain('steakhouse')
      expect(Object.keys(data)).toContain('moonwell')
      expect(Object.keys(data)).toContain('gauntlet')
      expect(Object.keys(data)).toContain('steakhouse-hy')

      for (const metrics of Object.values(data)) {
        expect(metrics.apy).toBeGreaterThan(0)
        expect(metrics.totalAssetsUsd).toBeGreaterThan(0)
        expect(typeof metrics.fee).toBe('number')
      }
    })

    it('returns cached result on second call', async () => {
      const first = await fetchAllVaultMetrics(8453)
      const second = await fetchAllVaultMetrics(8453)
      // Same reference if cached
      expect(second).toBe(first)
    })
  })

  describe('fetchVaultMetrics (integration)', () => {
    it('returns metrics for steakhouse vault', async () => {
      const data = await fetchVaultMetrics('0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183', 8453)
      if (!data) return // skip if API unreachable

      expect(data.apy).toBeGreaterThan(0)
      expect(data.netApy).toBeGreaterThan(0)
      expect(data.totalAssetsUsd).toBeGreaterThan(0)
    })
  })
})
