/**
 * Aerodrome Provider — Direct DEX routing via Aerodrome Router on Base
 *
 * Aerodrome is the largest liquidity hub on Base.
 * Router: 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
 *
 * Used as fallback when 0x is rate-limited or for core pairs (USDC/WETH)
 * where Aerodrome has the deepest liquidity.
 */

import { ethers } from 'ethers'
import type { SwapQuoteParams, SwapQuote } from '../types'
import type { SwapProvider } from './swap-provider'
import { SwapProviderError } from './swap-provider'

/**
 * Aerodrome Route struct — defines the path through pools.
 * Aerodrome uses (from, to, stable, factory) routes.
 */
interface AerodromeRoute {
  from: string
  to: string
  stable: boolean
  factory: string
}

/** Params for building swap calldata */
export interface AerodromeSwapParams {
  tokenIn: string
  tokenOut: string
  amountIn: bigint
  amountOutMin: bigint
  to: string
  deadline: bigint
}

/** Aerodrome Router ABI (only the functions we use) */
const ROUTER_ABI = [
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
  'function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
]

/** Default Aerodrome pool factory on Base */
const AERODROME_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da'

export class AerodromeProvider implements SwapProvider {
  readonly name = 'aerodrome'
  private readonly routerAddress: string
  private readonly routerInterface: ethers.Interface

  constructor(routerAddress: string, private readonly provider?: ethers.Provider) {
    this.routerAddress = routerAddress
    this.routerInterface = new ethers.Interface(ROUTER_ABI)
  }

  /**
   * Get a swap quote by calling router.getAmountsOut() on-chain.
   * Requires an ethers Provider to be set.
   */
  async getQuote(params: SwapQuoteParams): Promise<SwapQuote> {
    if (!this.provider) {
      throw new SwapProviderError('Provider required for on-chain quote', this.name, false)
    }

    const route = this.buildRoute(params.sellToken, params.buyToken)

    const data = this.routerInterface.encodeFunctionData('getAmountsOut', [
      params.sellAmount,
      route,
    ])

    try {
      const result = await this.provider.call({
        to: this.routerAddress,
        data,
      })

      const decoded = this.routerInterface.decodeFunctionResult('getAmountsOut', result)
      const amounts = decoded[0] as bigint[]
      const buyAmount = amounts[amounts.length - 1]

      // Build the swap calldata for execution
      const minOut = this.applySlippage(buyAmount, params.slippageBps)
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800) // 30 min

      const swapCalldata = this.buildSwapCalldata({
        tokenIn: params.sellToken,
        tokenOut: params.buyToken,
        amountIn: params.sellAmount,
        amountOutMin: minOut,
        to: params.taker,
        deadline,
      })

      return {
        provider: this.name,
        sellToken: params.sellToken,
        buyToken: params.buyToken,
        sellAmount: params.sellAmount,
        buyAmount,
        allowanceTarget: this.routerAddress,
        to: swapCalldata.to,
        data: swapCalldata.data,
        value: swapCalldata.value,
        estimatedGas: 300_000n, // Conservative estimate for Aerodrome swap
      }
    } catch (err) {
      throw new SwapProviderError(
        `getAmountsOut failed: ${(err as Error).message}`,
        this.name,
        true,
      )
    }
  }

  /**
   * Build the swap transaction calldata.
   * This can be used directly without getQuote if you already know the amounts.
   */
  buildSwapCalldata(params: AerodromeSwapParams): { to: string; data: string; value: string } {
    const route = this.buildRoute(params.tokenIn, params.tokenOut)

    const data = this.routerInterface.encodeFunctionData('swapExactTokensForTokens', [
      params.amountIn,
      params.amountOutMin,
      route,
      params.to,
      params.deadline,
    ])

    return {
      to: this.routerAddress,
      data,
      value: '0',
    }
  }

  /**
   * Apply slippage to an amount: amount * (10000 - slippageBps) / 10000
   */
  applySlippage(amount: bigint, slippageBps: number): bigint {
    if (slippageBps === 0) return amount
    return amount * BigInt(10000 - slippageBps) / 10000n
  }

  /**
   * Build Aerodrome route for a token pair.
   * Uses volatile pool (stable = false) for most pairs.
   * USDC/DAI would use stable = true.
   */
  private buildRoute(tokenIn: string, tokenOut: string): AerodromeRoute[] {
    // For USDC↔DAI, use stable pool
    const stable = this.isStablePair(tokenIn, tokenOut)

    return [{
      from: tokenIn,
      to: tokenOut,
      stable,
      factory: AERODROME_FACTORY,
    }]
  }

  private isStablePair(tokenA: string, tokenB: string): boolean {
    const stableTokens = new Set([
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
      '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
    ].map(a => a.toLowerCase()))

    return stableTokens.has(tokenA.toLowerCase()) && stableTokens.has(tokenB.toLowerCase())
  }
}
