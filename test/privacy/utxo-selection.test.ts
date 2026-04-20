import { describe, it, expect } from 'vitest'
import {
  computeNullifier,
  getSpendableBalance,
  selectUTXOsForAmount,
  type SpendableUTXO,
} from '../../src/privacy/lib/utxo-fetcher'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WETH = '0x4200000000000000000000000000000000000006'

function mockUTXO(value: bigint, tokenAddress: string = USDC): SpendableUTXO {
  return {
    commitment: {
      commitmentHash: '0x' + 'a'.repeat(64),
      treeNumber: '0',
      position: '1',
      tokenAddress,
      tokenType: 0,
      tokenSubID: '0',
      amount: value.toString(),
      fee: '0',
      npk: '0x' + 'b'.repeat(64),
      encryptedBundle0: '0x',
      encryptedBundle1: '0x',
      encryptedBundle2: '0x',
      shieldKey: '0x',
    },
    merkleProof: {
      root: '0x' + 'c'.repeat(64),
      proof: Array(16).fill('0x' + '0'.repeat(64)),
      pathIndices: Array(16).fill(0),
    },
    note: {
      value,
      random: 123n,
      notePublicKey: 456n,
      tokenAddress,
    },
    nullifier: '0x' + 'd'.repeat(64),
    tree: 0,
    position: 1,
  }
}

describe('utxo-selection', () => {
  describe('computeNullifier', () => {
    it('returns deterministic result for same inputs', () => {
      const nullifyingKey = 12345n
      const position = 42
      const n1 = computeNullifier(nullifyingKey, position)
      const n2 = computeNullifier(nullifyingKey, position)
      expect(n1).toBe(n2)
    })

    it('returns 0x-prefixed 64-char hex', () => {
      const result = computeNullifier(12345n, 42)
      expect(result).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('different position produces different nullifier', () => {
      const key = 12345n
      expect(computeNullifier(key, 1)).not.toBe(computeNullifier(key, 2))
    })
  })

  describe('getSpendableBalance', () => {
    it('sums values for matching token', () => {
      const utxos = [mockUTXO(100n), mockUTXO(200n), mockUTXO(300n)]
      expect(getSpendableBalance(utxos, USDC)).toBe(600n)
    })

    it('ignores other tokens', () => {
      const utxos = [mockUTXO(100n, USDC), mockUTXO(200n, WETH)]
      expect(getSpendableBalance(utxos, USDC)).toBe(100n)
    })

    it('returns 0n for empty array', () => {
      expect(getSpendableBalance([], USDC)).toBe(0n)
    })

    it('is case-insensitive', () => {
      const utxos = [mockUTXO(100n, USDC)]
      expect(getSpendableBalance(utxos, USDC.toLowerCase())).toBe(100n)
    })
  })

  describe('selectUTXOsForAmount', () => {
    it('selects largest-first, stops when target met', () => {
      const utxos = [
        mockUTXO(50n),
        mockUTXO(200n),
        mockUTXO(100n),
      ]
      const selected = selectUTXOsForAmount(utxos, 150n, USDC)
      // Should select 200n first (largest), which covers 150n
      expect(selected).toHaveLength(1)
      expect(selected[0].note.value).toBe(200n)
    })

    it('selects multiple UTXOs when needed', () => {
      const utxos = [
        mockUTXO(50n),
        mockUTXO(100n),
        mockUTXO(80n),
      ]
      const selected = selectUTXOsForAmount(utxos, 150n, USDC)
      // Should select 100n + 80n = 180n >= 150n
      expect(selected).toHaveLength(2)
    })

    it('throws Insufficient balance when total < target', () => {
      const utxos = [mockUTXO(50n), mockUTXO(30n)]
      expect(() => selectUTXOsForAmount(utxos, 100n, USDC)).toThrow('Insufficient balance')
    })

    it('filters by token address (case-insensitive)', () => {
      const utxos = [mockUTXO(100n, USDC), mockUTXO(200n, WETH)]
      const selected = selectUTXOsForAmount(utxos, 50n, USDC.toLowerCase())
      expect(selected).toHaveLength(1)
      expect(selected[0].note.tokenAddress).toBe(USDC)
    })

    it('throws when token has no UTXOs', () => {
      const utxos = [mockUTXO(100n, WETH)]
      expect(() => selectUTXOsForAmount(utxos, 50n, USDC)).toThrow('Insufficient balance')
    })
  })
})
