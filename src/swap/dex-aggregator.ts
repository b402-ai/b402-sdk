/**
 * DEX Aggregator Integration (Odos)
 *
 * Routes through ALL DEXes on Base (Aerodrome V2+CL, Uniswap, Sushiswap, etc.)
 * via the Odos Smart Order Router. Free, no API key needed.
 *
 * For private swaps: userAddr and receiver are set to RelayAdapt.
 */

import { ethers } from 'ethers'

const ODOS_QUOTE_URL = 'https://api.odos.xyz/sor/quote/v2'
const ODOS_ASSEMBLE_URL = 'https://api.odos.xyz/sor/assemble'

// Odos Router V2 on Base
export const ODOS_ROUTER = '0x19cEeAd7105607Cd444F5ad10dd51356436095a1'

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
]

export interface AggregatorQuote {
  amountIn: bigint
  amountOut: bigint
  minAmountOut: bigint
  priceImpact: number
  routerAddress: string
  pathId: string
  gasEstimate: number
}

/**
 * Get a swap quote from the Odos aggregator.
 * Free, no API key needed. Routes across all DEXes on Base.
 */
export async function getAggregatorQuote(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  slippagePercent = 0.5,
  userAddr: string,
): Promise<AggregatorQuote> {
  const response = await fetch(ODOS_QUOTE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chainId: 8453,
      inputTokens: [{ tokenAddress: tokenIn, amount: amountIn.toString() }],
      outputTokens: [{ tokenAddress: tokenOut, proportion: 1 }],
      slippageLimitPercent: slippagePercent,
      userAddr,
      referralCode: 0,
      disableRFQs: true,
      compact: true,
    }),
  })

  if (!response.ok) {
    throw new Error(`Odos quote failed: ${response.status}`)
  }

  const data = await response.json() as any

  if (!data.outAmounts?.[0]) {
    throw new Error('No route found')
  }

  const amountOut = BigInt(data.outAmounts[0])
  const slippageBps = Math.round(slippagePercent * 100)
  const minAmountOut = amountOut * BigInt(10000 - slippageBps) / BigInt(10000)

  return {
    amountIn,
    amountOut,
    minAmountOut,
    priceImpact: Math.abs(data.percentDiff || 0),
    routerAddress: ODOS_ROUTER,
    pathId: data.pathId,
    gasEstimate: data.gasEstimate || 0,
  }
}

/**
 * Build swap calldata from an Odos quote.
 * Returns [approve, swap] calls ready for a UserOp or RelayAdapt batch.
 */
export async function buildAggregatorSwapCalls(
  quote: AggregatorQuote,
  tokenIn: string,
  receiver: string,
): Promise<Array<{ to: string; data: string; value: string }>> {
  const response = await fetch(ODOS_ASSEMBLE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pathId: quote.pathId,
      userAddr: receiver,
      receiver,
    }),
  })

  if (!response.ok) {
    throw new Error(`Odos assemble failed: ${response.status}`)
  }

  const data = await response.json() as any

  if (!data.transaction?.to || !data.transaction?.data) {
    throw new Error('Failed to build swap transaction')
  }

  const tokenInterface = new ethers.Interface(ERC20_ABI)
  const approveData = tokenInterface.encodeFunctionData('approve', [
    data.transaction.to,
    quote.amountIn,
  ])

  return [
    { to: tokenIn, data: approveData, value: '0' },
    { to: data.transaction.to, data: data.transaction.data, value: data.transaction.value || '0' },
  ]
}
