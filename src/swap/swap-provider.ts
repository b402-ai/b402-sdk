/**
 * SwapProvider Interface — Abstracts over different DEX routing backends
 *
 * Implementations: 0x API (aggregated) and Aerodrome Router (direct).
 * Strategy: try 0x first (better routing), fall back to Aerodrome for core pairs.
 */

import type { SwapQuoteParams, SwapQuote } from '../types'

export interface SwapProvider {
  /** Provider name (e.g., '0x', 'aerodrome') */
  readonly name: string

  /**
   * Get a swap quote.
   * @param params - Sell/buy tokens, amount, taker address, slippage
   * @returns Quote with calldata for execution
   */
  getQuote(params: SwapQuoteParams): Promise<SwapQuote>
}

export class SwapProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly retryable: boolean = false,
    public readonly statusCode?: number,
  ) {
    super(`[${provider}] ${message}`)
    this.name = 'SwapProviderError'
  }
}

/**
 * Auto-select provider: try 0x first, fall back to Aerodrome.
 */
export async function getQuoteWithFallback(
  providers: SwapProvider[],
  params: SwapQuoteParams,
): Promise<SwapQuote> {
  let lastError: Error | undefined

  for (const provider of providers) {
    try {
      return await provider.getQuote(params)
    } catch (err) {
      lastError = err as Error
      // Only fall back on retryable errors (rate limits, timeouts)
      if (err instanceof SwapProviderError && !err.retryable) {
        throw err
      }
    }
  }

  throw lastError ?? new Error('No swap providers available')
}
