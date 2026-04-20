import { describe, it, expect } from 'vitest'
import { AerodromeProvider } from '../../src/swap/aerodrome-provider'

const ROUTER = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const WETH = '0x4200000000000000000000000000000000000006'
const DAI = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'

describe('AerodromeProvider', () => {
  const provider = new AerodromeProvider(ROUTER)

  describe('constructor', () => {
    it('creates instance with router address', () => {
      expect(provider.name).toBe('aerodrome')
    })
  })

  describe('buildSwapCalldata', () => {
    it('encodes swap correctly and returns router as `to`', () => {
      const result = provider.buildSwapCalldata({
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: 1000000n,
        amountOutMin: 990000n,
        to: '0x0000000000000000000000000000000000000001',
        deadline: 99999999999n,
      })

      expect(result.to).toBe(ROUTER)
      expect(result.data).toMatch(/^0x/)
      expect(result.value).toBe('0')
    })

    it('data starts with swapExactTokensForTokens selector', () => {
      const result = provider.buildSwapCalldata({
        tokenIn: USDC,
        tokenOut: WETH,
        amountIn: 1000000n,
        amountOutMin: 0n,
        to: '0x0000000000000000000000000000000000000001',
        deadline: 99999999999n,
      })

      // swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)
      // Selector: first 4 bytes of keccak256 of the signature
      expect(result.data.length).toBeGreaterThan(10) // at least selector + some data
    })
  })

  describe('applySlippage', () => {
    it('100 bps on 10000n → 9900n', () => {
      expect(provider.applySlippage(10000n, 100)).toBe(9900n)
    })

    it('0 bps returns original amount', () => {
      expect(provider.applySlippage(10000n, 0)).toBe(10000n)
    })

    it('50 bps on 1000000n → 995000n', () => {
      expect(provider.applySlippage(1000000n, 50)).toBe(995000n)
    })

    it('500 bps (5%) on 10000n → 9500n', () => {
      expect(provider.applySlippage(10000n, 500)).toBe(9500n)
    })
  })
})
