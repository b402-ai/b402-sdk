import { describe, it, expect } from 'vitest'
import { B402 } from '../src/b402'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

describe('B402 - multi-chain support', () => {
  describe('chainId config', () => {
    it('defaults to Base (8453) when chainId not provided', () => {
      const b402 = new B402({ privateKey: TEST_KEY })
      expect(b402.chainId).toBe(8453)
    })

    it('uses provided chainId from config', () => {
      const b402 = new B402({ privateKey: TEST_KEY, chainId: 42161 })
      expect(b402.chainId).toBe(42161)
    })

    it('throws when chainId is unsupported', () => {
      expect(() => new B402({ privateKey: TEST_KEY, chainId: 999 })).toThrow()
    })
  })

  describe('Arbitrum chain (42161)', () => {
    it('exposes Arbitrum Railgun relay address (B402 fork, 0% fees)', () => {
      const b402 = new B402({ privateKey: TEST_KEY, chainId: 42161 })
      expect(b402.contracts.RAILGUN_RELAY.toLowerCase()).toBe(
        '0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601'.toLowerCase()
      )
    })

    it('exposes Arbitrum Paymaster address', () => {
      const b402 = new B402({ privateKey: TEST_KEY, chainId: 42161 })
      expect(b402.contracts.PAYMASTER?.toLowerCase()).toBe(
        '0xF1915aE69343e79106423fc898f25083a26B9050'.toLowerCase()
      )
    })

    it('uses Arbitrum default RPC when no rpcUrl set', () => {
      const b402 = new B402({ privateKey: TEST_KEY, chainId: 42161 })
      expect(b402.rpcUrl).toContain('arbitrum')
    })

    it('resolves USDC token to Arbitrum address (6 decimals)', () => {
      const b402 = new B402({ privateKey: TEST_KEY, chainId: 42161 })
      const token = b402.resolveToken('USDC')
      expect(token.address.toLowerCase()).toBe(
        '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'.toLowerCase()
      )
      expect(token.decimals).toBe(6)
    })

    it('returns Arbitrum Railgun network name for SDK init', () => {
      const b402 = new B402({ privateKey: TEST_KEY, chainId: 42161 })
      expect(b402.railgunNetworkName).toBe('Arbitrum')
    })
  })

  describe('Base chain (8453) - backward compat', () => {
    it('still works the same with default config', () => {
      const b402 = new B402({ privateKey: TEST_KEY })
      expect(b402.contracts.RAILGUN_RELAY.toLowerCase()).toBe(
        '0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85'.toLowerCase()
      )
      expect(b402.railgunNetworkName).toBe('Base_Mainnet')
    })

    it('explicit chainId 8453 works', () => {
      const b402 = new B402({ privateKey: TEST_KEY, chainId: 8453 })
      expect(b402.chainId).toBe(8453)
      expect(b402.railgunNetworkName).toBe('Base_Mainnet')
    })
  })

  describe('BSC chain (56)', () => {
    it('exposes BSC Railgun relay (B402 fork, 0% fees)', () => {
      const b402 = new B402({ privateKey: TEST_KEY, chainId: 56 })
      expect(b402.contracts.RAILGUN_RELAY.toLowerCase()).toBe(
        '0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601'.toLowerCase()
      )
      expect(b402.railgunNetworkName).toBe('BNBChain')
    })
  })
})
