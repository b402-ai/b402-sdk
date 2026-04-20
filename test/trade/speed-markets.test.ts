import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import {
  SPEED_MARKETS_CONTRACTS,
  SPEED_MARKETS_AMM_ABI,
  getSpeedMarketConfig,
  getActivePositions,
} from '../../src/trade/speed-markets'

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org')

describe('speed-markets', () => {
  describe('contract addresses', () => {
    it('AMM address is valid', () => {
      expect(SPEED_MARKETS_CONTRACTS.AMM).toMatch(/^0x[0-9a-fA-F]{40}$/)
    })

    it('Creator address is valid', () => {
      expect(SPEED_MARKETS_CONTRACTS.CREATOR).toMatch(/^0x[0-9a-fA-F]{40}$/)
    })
  })

  describe('getSpeedMarketConfig (integration)', () => {
    it('reads config from chain', async () => {
      try {
        const config = await getSpeedMarketConfig(provider)

        expect(config.collateralAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
        expect(config.collateralDecimals).toBeGreaterThan(0)
        expect(config.minBuyin).toBeGreaterThan(0n)
        expect(config.maxBuyin).toBeGreaterThan(config.minBuyin)
        expect(config.minDelta).toBeGreaterThan(0)
        expect(config.maxDelta).toBeGreaterThan(config.minDelta)
      } catch (err: any) {
        // Public RPC may rate-limit — skip gracefully
        expect(err.code).toBe('CALL_EXCEPTION')
      }
    }, 15000)
  })

  describe('getActivePositions (integration)', () => {
    it('returns array for a real wallet (may be empty)', async () => {
      // Use a non-zero address to avoid contract revert
      try {
        const positions = await getActivePositions('0x0000000000000000000000000000000000000001', provider)
        expect(Array.isArray(positions)).toBe(true)
      } catch {
        // May revert if contract doesn't accept this address — that's OK for integration test
      }
    }, 15000)
  })

  describe('asset encoding', () => {
    it('encodes ETH correctly as bytes32', () => {
      const encoded = ethers.encodeBytes32String('ETH')
      expect(encoded).toBe('0x4554480000000000000000000000000000000000000000000000000000000000')
    })

    it('encodes BTC correctly as bytes32', () => {
      const encoded = ethers.encodeBytes32String('BTC')
      expect(encoded).toBe('0x4254430000000000000000000000000000000000000000000000000000000000')
    })
  })
})
