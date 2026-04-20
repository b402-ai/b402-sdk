import { describe, it, expect } from 'vitest'
import { B402 } from '../src/b402'
import { BASE_TOKENS } from '../src/types'
import { MORPHO_VAULTS } from '../src/lend/morpho-vaults'

// Valid test private keys (never use on mainnet with real funds)
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

describe('B402', () => {
  describe('constructor', () => {
    it('throws if no privateKey or signer', () => {
      expect(() => new B402({})).toThrow('privateKey or signer is required')
    })

    it('creates instance with valid key', () => {
      const b402 = new B402({ privateKey: TEST_KEY })
      expect(b402).toBeInstanceOf(B402)
    })

    it('accepts custom rpcUrl', () => {
      const b402 = new B402({
        privateKey: TEST_KEY,
        rpcUrl: 'https://custom.rpc.com',
      })
      expect(b402).toBeInstanceOf(B402)
    })

    it('accepts custom facilitatorUrl', () => {
      const b402 = new B402({
        privateKey: TEST_KEY,
        facilitatorUrl: 'https://custom.facilitator.com',
      })
      expect(b402).toBeInstanceOf(B402)
    })
  })

  describe('swap', () => {
    it('throws if no zeroXApiKey', async () => {
      const b402 = new B402({ privateKey: TEST_KEY })
      await expect(b402.swap({ from: 'USDC', to: 'WETH', amount: '10' }))
        .rejects.toThrow('zeroXApiKey required')
    })
  })

  describe('transact', () => {
    it('throws if calls is empty', async () => {
      const b402 = new B402({ privateKey: TEST_KEY })
      await expect(b402.transact([])).rejects.toThrow('calls array is required')
    })

    it('throws if calls is null-ish', async () => {
      const b402 = new B402({ privateKey: TEST_KEY })
      await expect(b402.transact(null as any)).rejects.toThrow('calls array is required')
    })
  })

  describe('unshield', () => {
    it('throws on unknown token', async () => {
      const b402 = new B402({ privateKey: TEST_KEY })
      await expect(b402.unshield({ token: 'SHIBA', amount: '10' }))
        .rejects.toThrow('Unknown token: SHIBA')
    })
  })

  describe('static helpers', () => {
    it('lists all vaults', () => {
      const vaults = B402.vaults
      expect(vaults).toHaveLength(4)
      expect(vaults[0]).toHaveProperty('name')
      expect(vaults[0]).toHaveProperty('fullName')
      expect(vaults[0]).toHaveProperty('address')
      expect(vaults[0]).toHaveProperty('curator')
    })

    it('lists all tokens', () => {
      const tokens = B402.tokens
      expect(tokens).toHaveLength(5)
      expect(tokens.find(t => t.symbol === 'USDC')).toBeTruthy()
      expect(tokens.find(t => t.symbol === 'WETH')).toBeTruthy()
      expect(tokens.find(t => t.symbol === 'DAI')).toBeTruthy()
      expect(tokens.find(t => t.symbol === 'AERO')).toBeTruthy()
      expect(tokens.find(t => t.symbol === 'USDT')).toBeTruthy()
    })

    it('vault addresses are valid', () => {
      for (const v of B402.vaults) {
        expect(v.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      }
    })

    it('token addresses are valid', () => {
      for (const t of B402.tokens) {
        expect(t.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      }
    })
  })

  describe('constants', () => {
    it('BASE_TOKENS has correct decimals', () => {
      expect(BASE_TOKENS.USDC.decimals).toBe(6)
      expect(BASE_TOKENS.WETH.decimals).toBe(18)
      expect(BASE_TOKENS.DAI.decimals).toBe(18)
    })

    it('MORPHO_VAULTS has all 4 entries', () => {
      expect(Object.keys(MORPHO_VAULTS)).toHaveLength(4)
      expect(MORPHO_VAULTS.steakhouse).toBeDefined()
      expect(MORPHO_VAULTS.moonwell).toBeDefined()
      expect(MORPHO_VAULTS.gauntlet).toBeDefined()
      expect(MORPHO_VAULTS['steakhouse-hy']).toBeDefined()
    })
  })
})
