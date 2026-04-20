import { describe, it, expect, beforeAll } from 'vitest'
import { ethers } from 'ethers'
import { deriveRailgunKeys, getRailgunAddress, computeExpectedNPK } from '../../src/privacy/lib/key-derivation'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const INCOGNITO_MESSAGE = 'b402 Incognito EOA Derivation'

// Derive signature once for fixture
const wallet = new ethers.Wallet(TEST_KEY)

describe('key-derivation', () => {
  let signature: string

  // Sign the incognito message once before all tests
  beforeAll(async () => {
    signature = await wallet.signMessage(INCOGNITO_MESSAGE)
  })

  describe('deriveRailgunKeys', () => {
    it('returns deterministic keys from the same signature', async () => {
      const keys1 = await deriveRailgunKeys(signature)
      const keys2 = await deriveRailgunKeys(signature)

      expect(keys1.mnemonic).toBe(keys2.mnemonic)
      expect(keys1.nullifyingKey).toBe(keys2.nullifyingKey)
      expect(keys1.masterPublicKey).toBe(keys2.masterPublicKey)
    })

    it('produces a valid 12-word BIP39 mnemonic', async () => {
      const keys = await deriveRailgunKeys(signature)
      const words = keys.mnemonic.split(' ')
      expect(words).toHaveLength(12)
      // Each word should be non-empty
      for (const word of words) {
        expect(word.length).toBeGreaterThan(0)
      }
    })

    it('derives all required key fields', async () => {
      const keys = await deriveRailgunKeys(signature)

      expect(keys.viewingKeyPair.privateKey).toBeInstanceOf(Uint8Array)
      expect(keys.viewingKeyPair.pubkey.length).toBeGreaterThan(0)
      expect(keys.spendingKeyPair.privateKey).toBeInstanceOf(Uint8Array)
      expect(keys.spendingKeyPair.pubkey.length).toBeGreaterThan(0)
      expect(typeof keys.nullifyingKey).toBe('bigint')
      expect(typeof keys.masterPublicKey).toBe('bigint')
      expect(keys.nullifyingKey).toBeGreaterThan(0n)
      expect(keys.masterPublicKey).toBeGreaterThan(0n)
    })
  })

  describe('getRailgunAddress', () => {
    it('returns 0zk-prefixed address', async () => {
      const keys = await deriveRailgunKeys(signature)
      const address = getRailgunAddress(keys)
      expect(address).toMatch(/^0zk/)
    })

    it('is deterministic for same keys', async () => {
      const keys = await deriveRailgunKeys(signature)
      const addr1 = getRailgunAddress(keys)
      const addr2 = getRailgunAddress(keys)
      expect(addr1).toBe(addr2)
    })
  })

  describe('computeExpectedNPK', () => {
    it('returns deterministic result for fixed inputs', async () => {
      const keys = await deriveRailgunKeys(signature)
      const random = 42n
      const npk1 = computeExpectedNPK(keys.masterPublicKey, random)
      const npk2 = computeExpectedNPK(keys.masterPublicKey, random)
      expect(npk1).toBe(npk2)
      expect(typeof npk1).toBe('bigint')
      expect(npk1).toBeGreaterThan(0n)
    })
  })
})
