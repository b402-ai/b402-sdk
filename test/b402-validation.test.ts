import { describe, it, expect } from 'vitest'
import { B402 } from '../src/b402'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

describe('B402 input validation', () => {
  const b402 = new B402({ privateKey: TEST_KEY })

  describe('privateSwap', () => {
    it('throws on unknown from token', async () => {
      await expect(
        b402.privateSwap({ from: 'SHIBA', to: 'WETH', amount: '1' }),
      ).rejects.toThrow('Unknown token: SHIBA')
    })

    it('throws on unknown to token', async () => {
      await expect(
        b402.privateSwap({ from: 'USDC', to: 'PEPE', amount: '1' }),
      ).rejects.toThrow('Unknown token: PEPE')
    })
  })

  describe('privateLend', () => {
    it('throws on unknown vault', async () => {
      await expect(
        b402.privateLend({ token: 'USDC', amount: '1', vault: 'nonexistent' }),
      ).rejects.toThrow('Unknown vault')
    })
  })

  describe('privateRedeem', () => {
    it('throws on unknown vault', async () => {
      await expect(
        b402.privateRedeem({ vault: 'nonexistent' }),
      ).rejects.toThrow('Unknown vault')
    })
  })

  describe('shield', () => {
    it('throws on unknown token', async () => {
      await expect(
        b402.shield({ token: 'DOGE', amount: '1' }),
      ).rejects.toThrow('Unknown token: DOGE')
    })
  })

  describe('unshield', () => {
    it('throws on unknown token', async () => {
      await expect(
        b402.unshield({ token: 'LUNA', amount: '1' }),
      ).rejects.toThrow('Unknown token: LUNA')
    })
  })

  describe('lend', () => {
    it('throws on unknown token', async () => {
      await expect(
        b402.lend({ token: 'BONK', amount: '1' }),
      ).rejects.toThrow('Unknown token: BONK')
    })

    it('throws on unknown vault', async () => {
      await expect(
        b402.lend({ token: 'USDC', amount: '1', vault: 'badVault' }),
      ).rejects.toThrow('Unknown vault')
    })
  })
})
