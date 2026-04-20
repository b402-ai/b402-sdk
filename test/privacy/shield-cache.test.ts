import { describe, it, expect, beforeEach } from 'vitest'
import {
  setCachedShield,
  getCachedShield,
  getCachedShields,
  clearShieldCache,
  setTestMode,
  type CachedShield,
} from '../../src/privacy/lib/shield-cache'

// Prevent tests from touching the real ~/.b402/shield-cache.json
setTestMode(true)

const makeShield = (overrides: Partial<CachedShield> = {}): CachedShield => ({
  txHash: '0xabc',
  tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '1000000',
  indexed: true,
  timestamp: Date.now(),
  ...overrides,
})

describe('shield-cache', () => {
  beforeEach(() => clearShieldCache())

  it('round-trips a shield entry', () => {
    const shield = makeShield()
    setCachedShield('wallet1', shield)
    expect(getCachedShield('wallet1')).toEqual(shield)
  })

  it('accumulates multiple shields under the same key', () => {
    setCachedShield('wallet1', makeShield({ txHash: '0x1', position: '1', treeNumber: '0' }))
    setCachedShield('wallet1', makeShield({ txHash: '0x2', position: '2', treeNumber: '0' }))
    const shields = getCachedShields('wallet1')
    expect(shields).toHaveLength(2)
    expect(shields[0].txHash).toBe('0x1')
    expect(shields[1].txHash).toBe('0x2')
  })

  it('deduplicates by position+treeNumber', () => {
    setCachedShield('wallet1', makeShield({ txHash: '0x1', position: '5', treeNumber: '0' }))
    setCachedShield('wallet1', makeShield({ txHash: '0x2', position: '5', treeNumber: '0' }))
    const shields = getCachedShields('wallet1')
    expect(shields).toHaveLength(1)
  })

  it('returns empty array for unknown key', () => {
    expect(getCachedShields('nonexistent')).toEqual([])
  })

  it('clearShieldCache removes all entries', () => {
    setCachedShield('a', makeShield())
    setCachedShield('b', makeShield())
    clearShieldCache()
    expect(getCachedShields('a')).toEqual([])
    expect(getCachedShields('b')).toEqual([])
  })
})
