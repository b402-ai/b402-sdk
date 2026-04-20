/**
 * Token configuration and utilities
 *
 * Resolves token addresses and decimals for the configured chain.
 */

import { type SupportedToken, SUPPORTED_TOKENS } from './local-config'
import { B402_CHAINS, getDefaultChainId } from '../../config/chains'

export type Network = 'mainnet' | 'testnet'

export function getTokenAddress(network: Network, token: SupportedToken, chainId?: number): string {
  const chain = chainId || getDefaultChainId()

  // Use SUPPORTED_TOKENS for Base (default chain)
  if (chain === 8453 && SUPPORTED_TOKENS[token]) {
    return SUPPORTED_TOKENS[token].address
  }

  // For other chains, look up from B402_CHAINS config
  const chainConfig = B402_CHAINS[chain]
  if (!chainConfig) {
    throw new Error(`Unsupported chain: ${chain}`)
  }

  const tokenConfig = chainConfig.tokens[token]
  if (!tokenConfig) {
    throw new Error(`Token ${token} not available on ${chainConfig.name}`)
  }

  return tokenConfig.address
}

export function getTokenDecimals(network: Network, token: SupportedToken, chainId?: number): number {
  const chain = chainId || getDefaultChainId()

  // Use SUPPORTED_TOKENS for Base (default chain)
  if (chain === 8453 && SUPPORTED_TOKENS[token]) {
    return SUPPORTED_TOKENS[token].decimals
  }

  // For other chains, look up from B402_CHAINS config
  const chainConfig = B402_CHAINS[chain]
  if (!chainConfig) {
    throw new Error(`Unsupported chain: ${chain}`)
  }

  const tokenConfig = chainConfig.tokens[token]
  if (!tokenConfig) {
    throw new Error(`Token ${token} not available on ${chainConfig.name}`)
  }

  return tokenConfig.decimals
}
