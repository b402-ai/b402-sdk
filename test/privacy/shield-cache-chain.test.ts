import { describe, it, expect, beforeEach } from 'vitest'
import {
  getCachedShields,
  setCachedShield,
  clearShieldCache,
  setTestMode,
} from '../../src/privacy/lib/shield-cache'

const WALLET = '0xb039e1f8fe4b1e0a2247674081aab6c76dbdcad4'

describe('shield-cache chain scoping', () => {
  beforeEach(() => {
    setTestMode(true)
    clearShieldCache()
  })

  it('filters cached shields by chainId', () => {
    setCachedShield(WALLET, {
      txHash: '0xbase1', tokenAddress: '0xUSDC_BASE', amount: '100',
      indexed: true, timestamp: 1, chainId: 8453,
      treeNumber: 0, position: 1,
    })
    setCachedShield(WALLET, {
      txHash: '0xarb1', tokenAddress: '0xUSDC_ARB', amount: '200',
      indexed: true, timestamp: 2, chainId: 42161,
      treeNumber: 0, position: 2,
    })
    setCachedShield(WALLET, {
      txHash: '0xbase2', tokenAddress: '0xWETH_BASE', amount: '300',
      indexed: true, timestamp: 3, chainId: 8453,
      treeNumber: 0, position: 3,
    })

    const arb = getCachedShields(WALLET, 42161)
    expect(arb.map((s) => s.txHash)).toEqual(['0xarb1'])

    const base = getCachedShields(WALLET, 8453)
    expect(base.map((s) => s.txHash)).toEqual(['0xbase1', '0xbase2'])

    const all = getCachedShields(WALLET)
    expect(all.map((s) => s.txHash).sort()).toEqual(['0xarb1', '0xbase1', '0xbase2'])
  })

  it('legacy entries (no chainId) are dropped when a chainId filter is applied', () => {
    setCachedShield(WALLET, {
      txHash: '0xlegacy', tokenAddress: '0xUSDC_BASE', amount: '100',
      indexed: true, timestamp: 1,
      treeNumber: 0, position: 1,
    })
    setCachedShield(WALLET, {
      txHash: '0xnew', tokenAddress: '0xUSDC_ARB', amount: '200',
      indexed: true, timestamp: 2, chainId: 42161,
      treeNumber: 0, position: 2,
    })

    expect(getCachedShields(WALLET, 42161).map((s) => s.txHash)).toEqual(['0xnew'])
    expect(getCachedShields(WALLET, 8453)).toEqual([])
    // Without filter, both surface — used by maintenance code that's chain-agnostic.
    expect(getCachedShields(WALLET).length).toBe(2)
  })

  it('returns empty for wallets with no entries', () => {
    expect(getCachedShields('0xunknown', 42161)).toEqual([])
  })
})
