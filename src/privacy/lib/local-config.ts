/**
 * Local configuration for the privacy layer
 *
 * Base tokens are defined inline. BSC/other chain tokens are resolved
 * via B402_CHAINS in config/chains.ts at runtime.
 */

import { BASE_TOKENS } from '../../types'
import { getDefaultChainId, getRailgunRelay, getBackendApiUrl } from '../../config/chains'

// Tokens supported across all chains (union of Base + BSC tokens)
export type SupportedToken = 'USDC' | 'WETH' | 'DAI' | 'AERO' | 'USDT' | 'WBNB' | 'USD1'

// Base token addresses (default chain)
// For BSC tokens, tokens.ts resolves via B402_CHAINS config
export const SUPPORTED_TOKENS: Record<string, {
  address: string
  symbol: string
  decimals: number
}> = {
  USDC: {
    address: BASE_TOKENS.USDC.address,
    symbol: BASE_TOKENS.USDC.symbol,
    decimals: BASE_TOKENS.USDC.decimals
  },
  WETH: {
    address: BASE_TOKENS.WETH.address,
    symbol: BASE_TOKENS.WETH.symbol,
    decimals: BASE_TOKENS.WETH.decimals
  },
  DAI: {
    address: BASE_TOKENS.DAI.address,
    symbol: BASE_TOKENS.DAI.symbol,
    decimals: BASE_TOKENS.DAI.decimals
  },
  AERO: {
    address: BASE_TOKENS.AERO.address,
    symbol: BASE_TOKENS.AERO.symbol,
    decimals: BASE_TOKENS.AERO.decimals
  }
}

export const BACKEND_API_URL = process.env.B402_BACKEND_API_URL || getBackendApiUrl(getDefaultChainId())

// Use getters so env vars are read at runtime (after dotenv loads)
export const PRIVACY_CONFIG = {
  get BACKEND_API_URL() {
    return process.env.B402_BACKEND_API_URL || getBackendApiUrl(getDefaultChainId())
  },
  get RAILGUN_SMART_WALLET() { return getRailgunRelay(getDefaultChainId()) },
  INCOGNITO_RESERVED_MESSAGE: 'b402 Incognito EOA Derivation',
  INCOGNITO_SALT_PREFIX: 'b402-incognito',
  CACHE_TTL: {
    BALANCE: 5 * 60 * 1000,
    COMMITMENTS: 10 * 60 * 1000,
    MERKLE_PROOF: 10 * 60 * 1000,
  },
  get B402_RAILGUN_KEYS() {
    return {
      masterPublicKey: process.env.B402_RAILGUN_MPK || '0x0000000000000000000000000000000000000000000000000000000000000000',
      viewingPublicKey: process.env.B402_RAILGUN_VPK || '0x0000000000000000000000000000000000000000000000000000000000000000',
    }
  },
  FEE_CONFIG: {
    DEFAULT_FEE_PERCENTAGE: 1,
    MIN_FEE_WEI: '1000000000000000',
  },
} as const
