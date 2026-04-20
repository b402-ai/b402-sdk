import { describe, it, expect } from 'vitest'
import {
  B402_CHAINS,
  RAILGUN_NETWORK_MAP,
  getChainConfig,
  getRailgunRelay,
  getTokenAddress,
  getRailgunNetworkName,
  getContractsForChain,
} from '../../src/config/chains'
import { BASE_CONTRACTS } from '../../src/types'

describe('chain config - multi-chain support', () => {
  describe('B402_CHAINS', () => {
    it('includes Base (8453)', () => {
      expect(B402_CHAINS[8453]).toBeDefined()
      expect(B402_CHAINS[8453].name).toBe('Base')
    })

    it('includes BSC (56)', () => {
      expect(B402_CHAINS[56]).toBeDefined()
      expect(B402_CHAINS[56].name).toBe('BSC')
    })

    it('includes Arbitrum (42161)', () => {
      expect(B402_CHAINS[42161]).toBeDefined()
      expect(B402_CHAINS[42161].name).toBe('Arbitrum')
    })

    it('Arbitrum has B402 Railgun fork address (0% fees)', () => {
      expect(B402_CHAINS[42161].railgunRelay.toLowerCase()).toBe(
        '0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601'.toLowerCase()
      )
    })

    it('Arbitrum has USDC with 6 decimals', () => {
      const usdc = B402_CHAINS[42161].tokens.USDC
      expect(usdc).toBeDefined()
      expect(usdc.decimals).toBe(6)
      expect(usdc.address.toLowerCase()).toBe(
        '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'.toLowerCase()
      )
    })
  })

  describe('getRailgunRelay', () => {
    it('returns correct address per chain', () => {
      expect(getRailgunRelay(8453).toLowerCase()).toBe(
        '0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85'.toLowerCase()
      )
      expect(getRailgunRelay(42161).toLowerCase()).toBe(
        '0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601'.toLowerCase()
      )
      expect(getRailgunRelay(56).toLowerCase()).toBe(
        '0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601'.toLowerCase()
      )
    })

    it('throws for unsupported chain', () => {
      expect(() => getRailgunRelay(999)).toThrow()
    })
  })

  describe('getTokenAddress', () => {
    it('returns USDC address for each supported chain', () => {
      expect(getTokenAddress(8453, 'USDC').toLowerCase()).toBe(
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'.toLowerCase()
      )
      expect(getTokenAddress(42161, 'USDC').toLowerCase()).toBe(
        '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'.toLowerCase()
      )
    })
  })

  describe('RAILGUN_NETWORK_MAP', () => {
    it('maps chain IDs to Railgun network names', () => {
      expect(RAILGUN_NETWORK_MAP[8453].networkName).toBe('Base_Mainnet')
      expect(RAILGUN_NETWORK_MAP[42161].networkName).toBe('Arbitrum')
      expect(RAILGUN_NETWORK_MAP[56].networkName).toBe('BNBChain')
    })

    it('includes Arbitrum B402 fork creation block', () => {
      // B402 Railgun fork deployed at block 452197063 on Arbitrum
      expect(RAILGUN_NETWORK_MAP[42161].creationBlock).toBe(452197063)
    })
  })

  describe('getRailgunNetworkName (helper)', () => {
    it('returns the Railgun SDK network name for a chain', () => {
      expect(getRailgunNetworkName(8453)).toBe('Base_Mainnet')
      expect(getRailgunNetworkName(42161)).toBe('Arbitrum')
      expect(getRailgunNetworkName(56)).toBe('BNBChain')
    })

    it('throws for unsupported chain', () => {
      expect(() => getRailgunNetworkName(999)).toThrow()
    })
  })

  describe('getContractsForChain (helper)', () => {
    it('returns chain-specific contract addresses including Railgun relay', () => {
      const baseContracts = getContractsForChain(8453)
      expect(baseContracts.RAILGUN_RELAY.toLowerCase()).toBe(
        '0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85'.toLowerCase()
      )

      const arbContracts = getContractsForChain(42161)
      expect(arbContracts.RAILGUN_RELAY.toLowerCase()).toBe(
        '0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601'.toLowerCase()
      )
    })

    it('returns deterministic ERC-4337 addresses (same across chains)', () => {
      const baseContracts = getContractsForChain(8453)
      const arbContracts = getContractsForChain(42161)

      // Standard deterministic addresses — same on every chain
      expect(baseContracts.ENTRY_POINT).toBe(arbContracts.ENTRY_POINT)
      expect(baseContracts.NEXUS_FACTORY).toBe(arbContracts.NEXUS_FACTORY)
      expect(baseContracts.NEXUS_BOOTSTRAP).toBe(arbContracts.NEXUS_BOOTSTRAP)
    })

    it('Base contracts match legacy BASE_CONTRACTS constant (backward compat)', () => {
      const baseContracts = getContractsForChain(8453)
      expect(baseContracts.RAILGUN_RELAY).toBe(BASE_CONTRACTS.RAILGUN_RELAY)
      expect(baseContracts.ENTRY_POINT).toBe(BASE_CONTRACTS.ENTRY_POINT)
      expect(baseContracts.NEXUS_FACTORY).toBe(BASE_CONTRACTS.NEXUS_FACTORY)
    })
  })
})
