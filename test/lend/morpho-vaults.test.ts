import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import { MORPHO_VAULTS, resolveVault } from '../../src/lend/morpho-vaults'

describe('morpho-vaults', () => {
  it('contains all 4 vaults', () => {
    const keys = Object.keys(MORPHO_VAULTS)
    expect(keys).toHaveLength(4)
    expect(keys).toContain('steakhouse')
    expect(keys).toContain('moonwell')
    expect(keys).toContain('gauntlet')
    expect(keys).toContain('steakhouse-hy')
  })

  it('every vault has valid checksum address, name, and curator', () => {
    for (const [key, vault] of Object.entries(MORPHO_VAULTS)) {
      expect(vault.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(ethers.getAddress(vault.address)).toBe(vault.address) // checksum-valid
      expect(vault.name.length).toBeGreaterThan(0)
      expect(vault.curator.length).toBeGreaterThan(0)
      expect(vault.token).toBe('USDC')
      expect(vault.decimals).toBe(6)
    }
  })

  describe('resolveVault', () => {
    it('resolves by name', () => {
      expect(resolveVault('steakhouse').name).toBe('Steakhouse USDC')
    })

    it('resolves by address (case-insensitive)', () => {
      const addr = MORPHO_VAULTS.moonwell.address.toLowerCase()
      expect(resolveVault(addr).name).toBe('Moonwell Flagship USDC')
    })

    it('throws for unknown vault', () => {
      expect(() => resolveVault('nonexistent')).toThrow('Unknown vault')
    })
  })
})
