import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import {
  RELAY_ADAPT_ADDRESS,
  computeAdaptParams,
  buildOrderedCalls,
  buildRelayCalldata,
  type ActionData,
} from '../../src/privacy/lib/relay-adapt'

// Mock transaction struct for buildRelayCalldata
const mockTransactionStruct = {
  proof: {
    a: { x: '1', y: '2' },
    b: { x: ['3', '4'] as [string, string], y: ['5', '6'] as [string, string] },
    c: { x: '7', y: '8' },
  },
  merkleRoot: '0x' + '0'.repeat(64),
  nullifiers: ['0x' + '1'.repeat(64)],
  commitments: ['0x' + '2'.repeat(64)],
  boundParams: {
    treeNumber: 0,
    minGasPrice: '0',
    unshield: 1,
    chainID: '0x2105',
    adaptContract: RELAY_ADAPT_ADDRESS,
    adaptParams: '0x' + '0'.repeat(64),
    commitmentCiphertext: [],
  },
  unshieldPreimage: {
    npk: '0x' + '0'.repeat(64),
    token: { tokenType: 0, tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', tokenSubID: 0 },
    value: '1000000',
  },
}

describe('relay-adapt', () => {
  it('RELAY_ADAPT_ADDRESS is correct', () => {
    expect(RELAY_ADAPT_ADDRESS).toBe('0xB0BC6d50098519c2a030661338F82a8792b85404')
  })

  describe('computeAdaptParams', () => {
    const actionData: ActionData = {
      random: new Uint8Array(31).fill(42),
      requireSuccess: true,
      minGasLimit: 2000000n,
      calls: [
        { to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x095ea7b3', value: 0n },
      ],
    }

    it('returns deterministic hash for same inputs', () => {
      const nullifiers = ['0x' + 'ab'.repeat(32)]
      const hash1 = computeAdaptParams(nullifiers, actionData)
      const hash2 = computeAdaptParams(nullifiers, actionData)
      expect(hash1).toBe(hash2)
      expect(hash1).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it('different nullifiers produce different hash', () => {
      const hash1 = computeAdaptParams(['0x' + 'aa'.repeat(32)], actionData)
      const hash2 = computeAdaptParams(['0x' + 'bb'.repeat(32)], actionData)
      expect(hash1).not.toBe(hash2)
    })

    it('matches manual keccak256 computation', () => {
      const nullifiers = ['0x' + '01'.repeat(32)]
      const result = computeAdaptParams(nullifiers, actionData)

      // Manually compute same encoding
      const abiCoder = ethers.AbiCoder.defaultAbiCoder()
      const encoded = abiCoder.encode(
        [
          'bytes32[][] nullifiers',
          'uint256 transactionsLength',
          'tuple(bytes31 random, bool requireSuccess, uint256 minGasLimit, tuple(address to, bytes data, uint256 value)[] calls) actionData',
        ],
        [
          [[...nullifiers]],
          1,
          actionData,
        ],
      )
      expect(result).toBe(ethers.keccak256(encoded))
    })
  })

  describe('buildOrderedCalls', () => {
    it('appends shield call at end with value 0n', () => {
      const userCalls = [
        { to: '0xA', data: '0x01' },
        { to: '0xB', data: '0x02' },
      ]
      const shieldCallData = '0xshield'
      const result = buildOrderedCalls(userCalls, shieldCallData, '0xToken', [{ tokenAddress: '0xOut' }])

      expect(result).toHaveLength(3) // 2 user + 1 shield
      expect(result[0].to).toBe('0xA')
      expect(result[1].to).toBe('0xB')
      expect(result[2].to).toBe(RELAY_ADAPT_ADDRESS)
      expect(result[2].data).toBe(shieldCallData)
      expect(result[2].value).toBe(0n)
    })

    it('preserves user call order', () => {
      const userCalls = [
        { to: '0x1', data: '0xa' },
        { to: '0x2', data: '0xb' },
        { to: '0x3', data: '0xc' },
      ]
      const result = buildOrderedCalls(userCalls, '0x', '0x', [])
      expect(result[0].to).toBe('0x1')
      expect(result[1].to).toBe('0x2')
      expect(result[2].to).toBe('0x3')
    })

    it('converts string values to bigint', () => {
      const userCalls = [
        { to: '0xA', data: '0x01', value: '1000' },
      ]
      const result = buildOrderedCalls(userCalls, '0x', '0x', [])
      expect(result[0].value).toBe(1000n)
    })

    it('defaults missing value to 0n', () => {
      const userCalls = [{ to: '0xA', data: '0x01' }]
      const result = buildOrderedCalls(userCalls, '0x', '0x', [])
      expect(result[0].value).toBe(0n)
    })
  })

  describe('buildRelayCalldata', () => {
    const actionData: ActionData = {
      random: new Uint8Array(31).fill(1),
      requireSuccess: true,
      minGasLimit: 2000000n,
      calls: [{ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x', value: 0n }],
    }

    it('returns to = RELAY_ADAPT_ADDRESS', () => {
      const result = buildRelayCalldata(mockTransactionStruct, actionData)
      expect(result.to).toBe(RELAY_ADAPT_ADDRESS)
    })

    it('data is valid hex', () => {
      const result = buildRelayCalldata(mockTransactionStruct, actionData)
      expect(result.data).toMatch(/^0x[0-9a-f]+$/i)
      expect(result.data.length).toBeGreaterThan(10)
    })
  })
})
