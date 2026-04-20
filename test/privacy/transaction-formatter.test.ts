import { describe, it, expect } from 'vitest'
import {
  formatUnshieldTransaction,
  formatTransactTransaction,
  encodeUnshieldTransaction,
} from '../../src/privacy/lib/transaction-formatter'
import type { ProofResult } from '../../src/privacy/lib/prover'

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const RAILGUN_BASE = '0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85'

function makeProofResult(): ProofResult {
  return {
    proof: {
      pi_a: ['111', '222'],
      pi_b: [['333', '444'], ['555', '666']],
      pi_c: ['777', '888'],
    },
    publicInputs: {
      merkleRoot: 12345n,
      boundParamsHash: 67890n,
      nullifiers: [11111n],
      commitmentsOut: [22222n],
    },
    boundParams: {
      treeNumber: 0,
      minGasPrice: 0,
      unshield: 1,
      chainID: '0x2105',
      adaptContract: '0x0000000000000000000000000000000000000000',
      adaptParams: '0x' + '0'.repeat(64),
      commitmentCiphertext: [],
    },
  }
}

describe('transaction-formatter', () => {
  describe('formatUnshieldTransaction', () => {
    const params = {
      proofResult: makeProofResult(),
      treeNumber: 0,
      tokenAddress: USDC_ADDRESS,
      recipientAddress: '0x0000000000000000000000000000000000000001',
      unshieldAmount: 1000000n,
      chainId: 8453,
    }

    it('maps proof fields correctly', () => {
      const tx = formatUnshieldTransaction(params)
      expect(tx.proof.a.x).toBe('111')
      expect(tx.proof.a.y).toBe('222')
      expect(tx.proof.b.x).toEqual(['333', '444'])
      expect(tx.proof.b.y).toEqual(['555', '666'])
      expect(tx.proof.c.x).toBe('777')
      expect(tx.proof.c.y).toBe('888')
    })

    it('formats merkleRoot/nullifiers/commitments as 0x-prefixed 64-char hex', () => {
      const tx = formatUnshieldTransaction(params)
      expect(tx.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/)
      for (const n of tx.nullifiers) {
        expect(n).toMatch(/^0x[0-9a-f]{64}$/)
      }
      for (const c of tx.commitments) {
        expect(c).toMatch(/^0x[0-9a-f]{64}$/)
      }
    })

    it('unshieldPreimage has correct token fields', () => {
      const tx = formatUnshieldTransaction(params)
      expect(tx.unshieldPreimage.token.tokenType).toBe(0)
      expect(tx.unshieldPreimage.token.tokenAddress).toBe(USDC_ADDRESS)
      expect(tx.unshieldPreimage.token.tokenSubID).toBe(0)
      expect(tx.unshieldPreimage.value).toBe('1000000')
    })

    it('boundParams.unshield is 1 for unshield', () => {
      const tx = formatUnshieldTransaction(params)
      expect(tx.boundParams.unshield).toBe(1)
    })
  })

  describe('formatTransactTransaction', () => {
    const params = {
      proofResult: makeProofResult(),
      treeNumber: 0,
      tokenAddress: USDC_ADDRESS,
      chainId: 8453,
    }

    it('npk is zero for transact (no unshield)', () => {
      const tx = formatTransactTransaction(params)
      expect(tx.unshieldPreimage.npk).toBe('0x' + '0'.repeat(64))
    })

    it('unshield flag is 0', () => {
      const tx = formatTransactTransaction(params)
      expect(tx.boundParams.unshield).toBe(0)
    })

    it('unshieldPreimage value is "0"', () => {
      const tx = formatTransactTransaction(params)
      expect(tx.unshieldPreimage.value).toBe('0')
    })
  })

  describe('encodeUnshieldTransaction', () => {
    it('returns to = Railgun contract on Base (8453)', () => {
      const tx = formatUnshieldTransaction({
        proofResult: makeProofResult(),
        treeNumber: 0,
        tokenAddress: USDC_ADDRESS,
        recipientAddress: '0x0000000000000000000000000000000000000001',
        unshieldAmount: 1000000n,
        chainId: 8453,
      })
      const encoded = encodeUnshieldTransaction(tx, 8453)
      expect(encoded.to).toBe(RAILGUN_BASE)
      expect(encoded.data).toMatch(/^0x/)
    })

    it('throws for unknown chainId', () => {
      const tx = formatUnshieldTransaction({
        proofResult: makeProofResult(),
        treeNumber: 0,
        tokenAddress: USDC_ADDRESS,
        recipientAddress: '0x0000000000000000000000000000000000000001',
        unshieldAmount: 1000000n,
        chainId: 999,
      })
      expect(() => encodeUnshieldTransaction(tx, 999)).toThrow('No Railgun contract for chain 999')
    })
  })
})
