/**
 * Bridge type definitions.
 */

export interface BridgeQuoteParams {
  /** Source chain ID (e.g., 8453 for Base) */
  fromChainId: number
  /** Destination chain ID (e.g., 42161 for Arbitrum) */
  toChainId: number
  /** Token address on source chain */
  fromToken: string
  /** Token address on destination chain (may differ for bridge+swap) */
  toToken: string
  /** Amount to send in source token's smallest unit */
  fromAmount: bigint
  /** Address doing the on-chain call on source chain (e.g., RelayAdapt) */
  fromAddress: string
  /** Recipient address on destination chain */
  toAddress: string
  /** Max slippage in basis points (e.g., 50 = 0.5%) */
  slippageBps: number
  /** Optional integrator tag for LI.FI analytics */
  integrator?: string
}

export interface BridgeQuote {
  /** Provider name */
  provider: string
  /** Underlying tool chosen by aggregator (e.g., 'across', 'stargate', 'cctp') */
  tool: string
  /** Human-readable tool name */
  toolName: string

  /** Source chain ID */
  fromChainId: number
  /** Destination chain ID */
  toChainId: number
  /** Source token address */
  fromToken: string
  /** Destination token address */
  toToken: string
  /** Source amount in wei */
  fromAmount: bigint
  /** Expected destination amount in wei */
  toAmount: bigint
  /** Minimum destination amount (after slippage) */
  toAmountMin: bigint

  /** Address to approve tokens for (Diamond/router) */
  approvalAddress: string
  /** Contract to call on source chain */
  to: string
  /** Encoded calldata */
  data: string
  /** ETH value to send (usually '0' for ERC-20 routes) */
  value: string
  /** Estimated gas limit */
  estimatedGas: bigint

  /** Total LI.FI + integrator fee in source token's smallest unit */
  feeAmount: bigint
  /** Total gas cost in native token's smallest unit (wei) */
  gasCost: bigint
  /** Expected bridge duration in seconds */
  estimatedDurationSec: number
}
