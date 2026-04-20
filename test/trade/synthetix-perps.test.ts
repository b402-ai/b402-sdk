import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import {
  SYNTHETIX_CONTRACTS,
  PERPS_MARKETS,
  PERPS_MARKET_ABI,
  SPOT_MARKET_ABI,
  buildCreateAccountCall,
  buildDepositMarginCalls,
  buildCommitOrderCall,
  buildWithdrawMarginCalls,
  getIndexPrice,
  computeOrderFees,
} from '../../src/trade/synthetix-perps'

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org')

describe('synthetix-perps', () => {
  describe('contract addresses', () => {
    it('PerpsMarketProxy is valid', () => {
      expect(SYNTHETIX_CONTRACTS.PERPS_MARKET_PROXY).toMatch(/^0x[0-9a-fA-F]{40}$/)
    })

    it('SpotMarketProxy is valid', () => {
      expect(SYNTHETIX_CONTRACTS.SPOT_MARKET_PROXY).toMatch(/^0x[0-9a-fA-F]{40}$/)
    })

    it('USDC is the correct Base USDC', () => {
      expect(SYNTHETIX_CONTRACTS.USDC.toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
    })
  })

  describe('market IDs', () => {
    it('has ETH market', () => {
      expect(PERPS_MARKETS.ETH).toBe(100)
    })

    it('has BTC market', () => {
      expect(PERPS_MARKETS.BTC).toBe(200)
    })

    it('has SOL market', () => {
      expect(PERPS_MARKETS.SOL).toBe(400)
    })
  })

  describe('buildCreateAccountCall', () => {
    it('returns valid call structure', () => {
      const call = buildCreateAccountCall()
      expect(call.to).toBe(SYNTHETIX_CONTRACTS.PERPS_MARKET_PROXY)
      expect(call.data).toMatch(/^0x/)
      expect(call.value).toBe('0')
    })
  })

  describe('buildDepositMarginCalls', () => {
    it('returns 4 calls (approve, wrap, approve, deposit)', () => {
      const calls = buildDepositMarginCalls(100_000_000n, 1n) // 100 USDC
      expect(calls).toHaveLength(4)

      // First call: approve USDC to SpotMarketProxy
      expect(calls[0].to).toBe(SYNTHETIX_CONTRACTS.USDC)

      // Second call: wrap via SpotMarketProxy
      expect(calls[1].to).toBe(SYNTHETIX_CONTRACTS.SPOT_MARKET_PROXY)

      // Third call: approve sUSDC to PerpsMarketProxy
      expect(calls[2].to).toBe(SYNTHETIX_CONTRACTS.SUSDC)

      // Fourth call: modifyCollateral on PerpsMarketProxy
      expect(calls[3].to).toBe(SYNTHETIX_CONTRACTS.PERPS_MARKET_PROXY)
    })
  })

  describe('buildCommitOrderCall', () => {
    it('builds valid order commitment', () => {
      const indexPrice = ethers.parseEther('3000') // $3000 ETH
      const call = buildCommitOrderCall(
        { market: 'ETH', side: 'long', size: '0.1', margin: '300', slippageBps: 100 },
        1n,
        indexPrice,
      )

      expect(call.to).toBe(SYNTHETIX_CONTRACTS.PERPS_MARKET_PROXY)
      expect(call.data).toMatch(/^0x/)
      expect(call.value).toBe('0')
    })
  })

  describe('buildWithdrawMarginCalls', () => {
    it('returns 3 calls (withdraw, approve, unwrap)', () => {
      const susdcAmount = ethers.parseEther('100') // 100 sUSDC (18 dec)
      const calls = buildWithdrawMarginCalls(susdcAmount, 1n)
      expect(calls).toHaveLength(3)
    })
  })

  describe('getIndexPrice (integration)', () => {
    it('returns ETH price > 0 (may revert if oracle stale — ERC-7412)', async () => {
      try {
        const price = await getIndexPrice('ETH', provider)
        expect(price).toBeGreaterThan(0n)
        const priceUsd = Number(ethers.formatEther(price))
        expect(priceUsd).toBeGreaterThan(100)
        expect(priceUsd).toBeLessThan(100000)
      } catch (err: any) {
        // ERC-7412: oracle data stale, needs Pyth update — expected behavior
        expect(err.code).toBe('CALL_EXCEPTION')
      }
    }, 15000)

    it('returns BTC price > 0 (may revert if oracle stale)', async () => {
      try {
        const price = await getIndexPrice('BTC', provider)
        const priceUsd = Number(ethers.formatEther(price))
        expect(priceUsd).toBeGreaterThan(1000)
      } catch (err: any) {
        expect(err.code).toBe('CALL_EXCEPTION')
      }
    }, 15000)
  })

  describe('computeOrderFees (integration)', () => {
    it('returns fees for ETH long (may revert if oracle stale)', async () => {
      try {
        const { fees, fillPrice } = await computeOrderFees('ETH', '0.1', 'long', provider)
        expect(parseFloat(fees)).toBeGreaterThanOrEqual(0)
        expect(parseFloat(fillPrice)).toBeGreaterThan(0)
      } catch (err: any) {
        // ERC-7412: oracle needs fresh Pyth data
        expect(err.code).toBe('CALL_EXCEPTION')
      }
    }, 15000)
  })
})
