import { describe, it, expect } from 'vitest'
import { buildAddLiquidityCalls, buildRemoveLiquidityCalls, buildClaimRewardsCalls } from '../../src/lp/lp-builder'
import { AERODROME_POOLS } from '../../src/lp/aerodrome-pools'

const pool = AERODROME_POOLS['weth-usdc']

describe('lp-builder', () => {
  describe('buildAddLiquidityCalls', () => {
    it('returns 6 calls', () => {
      const calls = buildAddLiquidityCalls({
        pool,
        usdcAmount: 1_000_000n, // 1 USDC
        swapCalldata: { to: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43', data: '0x1234', value: '0' },
        expectedWethOut: 500000000000000n, // 0.0005 WETH
        usdcForLiquidity: 500_000n,
        amountAMin: 400000000000000n,
        amountBMin: 400_000n,
        recipient: '0x1234567890123456789012345678901234567890',
        deadline: 99999999999n,
      })

      expect(calls).toHaveLength(6)

      // Call 1: approve USDC
      expect(calls[0].to).toBe(pool.tokenB.address)
      expect(calls[0].value).toBe('0')

      // Call 2: swap
      expect(calls[1].to).toBe('0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43')
      expect(calls[1].data).toBe('0x1234')

      // Call 3: approve WETH
      expect(calls[2].to).toBe(pool.tokenA.address)

      // Call 4: addLiquidity
      expect(calls[3].to).toBe('0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43')

      // Call 5: approve LP to gauge
      expect(calls[4].to).toBe(pool.poolAddress)

      // Call 6: gauge.deposit
      expect(calls[5].to).toBe(pool.gaugeAddress)
    })

    it('all calls have valid data', () => {
      const calls = buildAddLiquidityCalls({
        pool,
        usdcAmount: 1_000_000n,
        swapCalldata: { to: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43', data: '0xabcdef', value: '0' },
        expectedWethOut: 500000000000000n,
        usdcForLiquidity: 500_000n,
        amountAMin: 0n,
        amountBMin: 0n,
        recipient: '0x1234567890123456789012345678901234567890',
        deadline: 99999999999n,
      })

      for (const call of calls) {
        expect(call.data.length).toBeGreaterThan(2)
        expect(call.value).toBe('0')
      }
    })
  })

  describe('buildRemoveLiquidityCalls', () => {
    it('returns 4 calls when staked', () => {
      const calls = buildRemoveLiquidityCalls({
        pool,
        stakedAmount: 1000000000000000000n,
        unstakedAmount: 0n,
        amountAMin: 0n,
        amountBMin: 0n,
        wallet: '0x1234567890123456789012345678901234567890',
        deadline: 99999999999n,
      })

      expect(calls).toHaveLength(4) // getReward + withdraw + approve + removeLiquidity
    })

    it('returns 2 calls when only unstaked', () => {
      const calls = buildRemoveLiquidityCalls({
        pool,
        stakedAmount: 0n,
        unstakedAmount: 1000000000000000000n,
        amountAMin: 0n,
        amountBMin: 0n,
        wallet: '0x1234567890123456789012345678901234567890',
        deadline: 99999999999n,
      })

      expect(calls).toHaveLength(2) // just approve + removeLiquidity (no gauge)
    })
  })

  describe('buildClaimRewardsCalls', () => {
    it('returns 1 call', () => {
      const calls = buildClaimRewardsCalls(
        pool.gaugeAddress,
        '0x1234567890123456789012345678901234567890',
      )

      expect(calls).toHaveLength(1)
      expect(calls[0].to).toBe(pool.gaugeAddress)
    })
  })
})
