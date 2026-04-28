/**
 * LI.FI Provider — Cross-chain bridge + swap aggregator
 *
 * Wraps https://li.quest/v1/quote — aggregates ~30 bridges and ~20 DEXes
 * across ~20 EVM chains behind a single API.
 *
 * The quote response carries ready-to-execute calldata: we pass
 * `transactionRequest.to` + `transactionRequest.data` straight into a
 * RelayAdapt multicall. No hardcoded Diamond address — trust the API so
 * we inherit any future contract migrations.
 *
 * Fee model: LI.FI charges a flat 0.25% by default (see `feeCosts`).
 * Integrator fee is 0 unless configured.
 */

import type { BridgeProvider } from './bridge-provider'
import { BridgeProviderError } from './bridge-provider'
import type { BridgeQuoteParams, BridgeQuote } from './types'

const LIFI_API_BASE = 'https://li.quest/v1'
const DEFAULT_INTEGRATOR = 'b402'

/** Cross-chain transfer status as surfaced to SDK callers. */
export interface LiFiStatus {
  /** Normalized status: pending | done | failed. */
  status: 'pending' | 'done' | 'failed'
  /** Raw LiFi sub-status string when available (e.g. WAIT_DESTINATION_TRANSACTION). */
  substatus?: string
  /** Destination-chain tx hash once the bridge fills. */
  destTxHash?: string
  /** Source-chain tx hash echoed back. */
  srcTxHash?: string
}

/** Shape of the relevant fields from the LI.FI /quote response. */
interface LiFiQuoteResponse {
  tool: string
  toolDetails?: { name?: string }
  estimate: {
    fromAmount: string
    toAmount: string
    toAmountMin: string
    approvalAddress: string
    feeCosts?: Array<{ amount: string; token: { address: string } }>
    gasCosts?: Array<{ amount: string; estimate: string }>
    executionDuration?: number
  }
  transactionRequest?: {
    to: string
    data: string
    value: string
    gasLimit?: string
  }
  action: {
    fromToken: { address: string }
    toToken: { address: string }
    fromChainId: number
    toChainId: number
  }
}

export class LiFiProvider implements BridgeProvider {
  readonly name = 'lifi'

  constructor(
    private readonly apiKey?: string,
    private readonly integrator: string = DEFAULT_INTEGRATOR,
  ) {}

  async getBridgeQuote(params: BridgeQuoteParams): Promise<BridgeQuote> {
    const query = new URLSearchParams({
      fromChain: String(params.fromChainId),
      toChain: String(params.toChainId),
      fromToken: params.fromToken,
      toToken: params.toToken,
      fromAmount: params.fromAmount.toString(),
      fromAddress: params.fromAddress,
      toAddress: params.toAddress,
      slippage: (params.slippageBps / 10000).toString(),
      integrator: params.integrator ?? this.integrator,
    })

    const url = `${LIFI_API_BASE}/quote?${query}`
    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.apiKey) headers['x-lifi-api-key'] = this.apiKey

    let res: Response
    try {
      res = await fetch(url, { headers })
    } catch (err) {
      throw new BridgeProviderError(
        `Network error: ${(err as Error).message}`,
        this.name,
        true,
      )
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new BridgeProviderError(
        `HTTP ${res.status}: ${body.slice(0, 300)}`,
        this.name,
        res.status >= 500 || res.status === 429,
        res.status,
      )
    }

    const quote = (await res.json()) as LiFiQuoteResponse

    if (!quote.transactionRequest) {
      throw new BridgeProviderError(
        'Quote has no transactionRequest (route not executable)',
        this.name,
        false,
      )
    }

    const fromTokenAddr = params.fromToken.toLowerCase()
    const feeAmount = (quote.estimate.feeCosts ?? [])
      .filter(f => f.token.address.toLowerCase() === fromTokenAddr)
      .reduce((sum, f) => sum + BigInt(f.amount), 0n)

    const gasCost = (quote.estimate.gasCosts ?? [])
      .reduce((sum, g) => sum + BigInt(g.amount ?? '0'), 0n)

    return {
      provider: this.name,
      tool: quote.tool,
      toolName: quote.toolDetails?.name ?? quote.tool,
      fromChainId: quote.action.fromChainId,
      toChainId: quote.action.toChainId,
      fromToken: quote.action.fromToken.address,
      toToken: quote.action.toToken.address,
      fromAmount: BigInt(quote.estimate.fromAmount),
      toAmount: BigInt(quote.estimate.toAmount),
      toAmountMin: BigInt(quote.estimate.toAmountMin),
      approvalAddress: quote.estimate.approvalAddress,
      to: quote.transactionRequest.to,
      data: quote.transactionRequest.data,
      value: quote.transactionRequest.value ?? '0x0',
      estimatedGas: BigInt(quote.transactionRequest.gasLimit ?? '500000'),
      feeAmount,
      gasCost,
      estimatedDurationSec: quote.estimate.executionDuration ?? 0,
    }
  }

  /**
   * Poll LiFi for the cross-chain transfer status of a source-chain txHash.
   * Returns a normalized status the SDK can poll on without parsing LiFi's
   * full JSON shape.
   *
   * Reference: https://docs.li.fi/api-reference/check-the-status-of-a-cross-chain-transfer
   */
  async getStatus(srcTxHash: string): Promise<LiFiStatus> {
    const query = new URLSearchParams({ txHash: srcTxHash })
    const url = `${LIFI_API_BASE}/status?${query}`
    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.apiKey) headers['x-lifi-api-key'] = this.apiKey

    const res = await fetch(url, { headers })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new BridgeProviderError(
        `HTTP ${res.status}: ${body.slice(0, 300)}`,
        this.name,
        res.status >= 500 || res.status === 429,
        res.status,
      )
    }
    const body = (await res.json()) as {
      status?: string
      substatus?: string
      sending?: { txHash?: string }
      receiving?: { txHash?: string }
    }

    const raw = (body.status || '').toUpperCase()
    const status: LiFiStatus['status'] =
      raw === 'DONE' ? 'done'
      : raw === 'FAILED' || raw === 'INVALID' ? 'failed'
      : 'pending'

    return {
      status,
      substatus: body.substatus,
      srcTxHash: body.sending?.txHash ?? srcTxHash,
      destTxHash: body.receiving?.txHash,
    }
  }
}
