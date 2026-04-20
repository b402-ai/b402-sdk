/**
 * 0x Swap Provider — Aggregated DEX routing via 0x API v2
 *
 * Uses the allowance-holder endpoint (not Permit2) for simpler multicall:
 * we control the approve step in the ERC-7579 batch, so direct allowance is cleaner.
 *
 * API docs: https://0x.org/docs/api
 */

import type { SwapQuoteParams, SwapQuote } from '../types'
import type { SwapProvider } from './swap-provider'
import { SwapProviderError } from './swap-provider'

const BASE_URL = 'https://api.0x.org'

export class ZeroXProvider implements SwapProvider {
  readonly name = '0x'

  constructor(
    private readonly apiKey: string,
    private readonly chainId: number = 8453,
  ) {}

  async getQuote(params: SwapQuoteParams): Promise<SwapQuote> {
    const queryParams = new URLSearchParams({
      chainId: this.chainId.toString(),
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      sellAmount: params.sellAmount.toString(),
      taker: params.taker,
      slippageBps: params.slippageBps.toString(),
    })

    const url = `${BASE_URL}/swap/allowance-holder/quote?${queryParams}`

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        '0x-api-key': this.apiKey,
        '0x-version': 'v2',
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      const reason = (body as Record<string, string>).reason ?? `HTTP ${response.status}`
      const retryable = response.status === 429 || response.status >= 500
      throw new SwapProviderError(reason, this.name, retryable, response.status)
    }

    const data = await response.json() as Record<string, unknown>

    const tx = data.transaction as Record<string, string> | undefined

    return {
      provider: this.name,
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      sellAmount: params.sellAmount,
      buyAmount: BigInt(data.buyAmount as string),
      allowanceTarget: (data.allowanceTarget as string) ?? (tx?.to ?? ''),
      to: tx?.to ?? '',
      data: tx?.data ?? '',
      value: tx?.value ?? '0',
      estimatedGas: BigInt(tx?.gas ?? tx?.gasLimit ?? '0'),
    }
  }
}
