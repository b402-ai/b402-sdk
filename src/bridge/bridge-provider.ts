/**
 * BridgeProvider Interface — Cross-chain bridge/swap aggregator abstraction
 *
 * Mirrors the SwapProvider interface but for cross-chain (and bridge+swap) routes.
 * Implementations: LI.FI (first), Socket/Rango/Squid (future).
 *
 * Unlike SwapProvider, bridges have:
 *   - Two chain IDs (from + to)
 *   - Destination address (may differ from sender)
 *   - A tool name (Across, Stargate, CCTP, ...) the aggregator picked
 *   - Estimated bridge duration (seconds)
 */

import type { BridgeQuoteParams, BridgeQuote } from './types'

export interface BridgeProvider {
  /** Provider name (e.g., 'lifi', 'socket') */
  readonly name: string

  /**
   * Get a cross-chain bridge (or bridge+swap) quote.
   * @param params - from/to chain+token+amount, sender, recipient, slippage
   * @returns Quote with calldata ready to execute on the source chain
   */
  getBridgeQuote(params: BridgeQuoteParams): Promise<BridgeQuote>
}

export class BridgeProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly retryable: boolean = false,
    public readonly statusCode?: number,
  ) {
    super(`[${provider}] ${message}`)
    this.name = 'BridgeProviderError'
  }
}

/**
 * Try providers in order, fall back on retryable errors.
 */
export async function getBridgeQuoteWithFallback(
  providers: BridgeProvider[],
  params: BridgeQuoteParams,
): Promise<BridgeQuote> {
  let lastError: Error | undefined

  for (const provider of providers) {
    try {
      return await provider.getBridgeQuote(params)
    } catch (err) {
      lastError = err as Error
      if (err instanceof BridgeProviderError && !err.retryable) {
        throw err
      }
    }
  }

  throw lastError ?? new Error('No bridge providers available')
}
