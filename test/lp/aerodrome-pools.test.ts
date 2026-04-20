import { describe, it, expect } from 'vitest'
import { resolvePool, AERODROME_POOLS, applySlippage, AERO_TOKEN } from '../../src/lp/aerodrome-pools'

describe('aerodrome-pools', () => {
  it('resolvePool returns config by name', () => {
    const pool = resolvePool('weth-usdc')
    expect(pool.name).toBe('WETH/USDC Volatile')
    expect(pool.poolAddress).toBe('0xcDAC0d6c6C59727a65F871236188350531885C43')
    expect(pool.gaugeAddress).toBe('0x519BBD1Dd8C6A94C46080E24f316c14Ee758C025')
    expect(pool.stable).toBe(false)
    expect(pool.lpDecimals).toBe(18)
  })

  it('resolvePool returns config by address', () => {
    const pool = resolvePool('0xcDAC0d6c6C59727a65F871236188350531885C43')
    expect(pool.name).toBe('WETH/USDC Volatile')
  })

  it('resolvePool throws on unknown pool', () => {
    expect(() => resolvePool('invalid')).toThrow('Unknown pool')
  })

  it('all pools have valid addresses', () => {
    for (const [key, pool] of Object.entries(AERODROME_POOLS)) {
      expect(pool.poolAddress).toMatch(/^0x[a-fA-F0-9]{40}$/)
      expect(pool.gaugeAddress).toMatch(/^0x[a-fA-F0-9]{40}$/)
      expect(pool.tokenA.address).toMatch(/^0x[a-fA-F0-9]{40}$/)
      expect(pool.tokenB.address).toMatch(/^0x[a-fA-F0-9]{40}$/)
    }
  })

  it('AERO token has correct address', () => {
    expect(AERO_TOKEN.address).toBe('0x940181a94A35A4569E4529A3CDfB74e38FD98631')
    expect(AERO_TOKEN.decimals).toBe(18)
  })

  it('applySlippage calculates correctly', () => {
    expect(applySlippage(10000n, 300)).toBe(9700n) // 3% slippage
    expect(applySlippage(10000n, 50)).toBe(9950n)  // 0.5% slippage
    expect(applySlippage(10000n, 0)).toBe(10000n)  // no slippage
  })
})
