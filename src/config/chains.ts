/**
 * Multi-chain configuration for b402
 *
 * B402 Railgun fork contracts (0% protocol fees):
 * - BSC Mainnet:      0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601
 * - Base Mainnet:     0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85
 * - Arbitrum One:     0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601 (deployed 2026-04-13)
 */

export interface ChainConfig {
  name: string
  chainId: number
  railgunRelay: `0x${string}`
  /** RelayAdapt cross-contract call router — differs per chain. Optional for chains without RelayAdapt deployed yet. */
  relayAdapt?: `0x${string}`
  rpc: string
  backendApiUrl: string
  facilitatorUrl?: string
  explorerUrl: string
  tokens: Record<string, {
    address: `0x${string}`
    symbol: string
    decimals: number
  }>
}

// B402 treasury keys (for receiving fee notes)
export const B402_TREASURY = {
  MPK: '0x2ee3d72502613195a791ab3b68935d910bc1a36b634d62eeceb9a9cfb1a1d697',
  VPK: '0x04ffbb58b9a4cb0fb472ad2a934e63832bf1a959b07f390f149fa4c70867fe53'
} as const

export const B402_CHAINS: Record<number, ChainConfig> = {
  // BSC Mainnet - B402 Railgun fork (0% protocol fees, deployed 2026-02-05)
  56: {
    name: 'BSC',
    chainId: 56,
    railgunRelay: '0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601',
    rpc: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
    backendApiUrl: process.env.BSC_BACKEND_API_URL || 'https://b402-backend-api-836626313375.europe-west1.run.app',
    explorerUrl: 'https://bscscan.com',
    tokens: {
      USDT: {
        address: '0x55d398326f99059fF775485246999027B3197955',
        symbol: 'USDT',
        decimals: 18
      },
      USDC: {
        address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        symbol: 'USDC',
        decimals: 18
      },
      DAI: {
        address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
        symbol: 'DAI',
        decimals: 18
      },
      WBNB: {
        address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        symbol: 'WBNB',
        decimals: 18
      },
      USD1: {
        address: '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d',
        symbol: 'USD1',
        decimals: 18
      }
    }
  },

  // Arbitrum One - B402 Railgun fork (0% protocol fees, deployed 2026-04-13)
  42161: {
    name: 'Arbitrum',
    chainId: 42161,
    railgunRelay: (process.env.ARB_RAILGUN_RELAY || '0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601') as `0x${string}`,
    relayAdapt: '0x1fC2C36Ef9385147B140601cebb76C08de1aF9Cc',
    rpc: process.env.ARB_RPC_URL || 'https://arbitrum-one-rpc.publicnode.com',
    backendApiUrl: process.env.ARB_BACKEND_API_URL || 'https://b402-arb-api-62092339396.us-central1.run.app',
    facilitatorUrl: process.env.ARB_FACILITATOR_URL || 'https://b402-facilitator-arb-62092339396.us-central1.run.app',
    explorerUrl: 'https://arbiscan.io',
    tokens: {
      USDC: {
        address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        symbol: 'USDC',
        decimals: 6,
      },
      USDT: {
        address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        symbol: 'USDT',
        decimals: 6,
      },
      WETH: {
        address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        symbol: 'WETH',
        decimals: 18,
      },
      ARB: {
        address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
        symbol: 'ARB',
        decimals: 18,
      },
    },
  },

  // Base Mainnet - B402 Railgun fork (0% protocol fees)
  8453: {
    name: 'Base',
    chainId: 8453,
    railgunRelay: '0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85',
    relayAdapt: '0xB0BC6d50098519c2a030661338F82a8792b85404',
    rpc: process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/CygH7Y6PEyNCuKF6NFcG6DxYRXqI4zE2',
    backendApiUrl: process.env.BASE_BACKEND_API_URL || 'https://b402-base-api-62092339396.us-central1.run.app',
    explorerUrl: 'https://basescan.org',
    tokens: {
      USDC: {
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        symbol: 'USDC',
        decimals: 6
      },
      WETH: {
        address: '0x4200000000000000000000000000000000000006',
        symbol: 'WETH',
        decimals: 18
      },
      DAI: {
        address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
        symbol: 'DAI',
        decimals: 18
      }
    }
  }
}

// Railgun SDK network mapping
// Maps chain IDs to Railgun SDK NetworkName values and creation blocks
export const RAILGUN_NETWORK_MAP: Record<number, { networkName: string; creationBlock: number }> = {
  56:    { networkName: 'BNBChain',     creationBlock: 70253312 },
  8453:  { networkName: 'Base_Mainnet', creationBlock: 42085870 },
  42161: { networkName: 'Arbitrum',     creationBlock: 452197063 },
}

// Chain aliases for easier configuration
export const CHAIN_ALIASES: Record<string, number> = {
  'bsc': 56,
  'bsc-mainnet': 56,
  'bnb': 56,
  'base': 8453,
  'base-mainnet': 8453,
  'arb': 42161,
  'arbitrum': 42161,
  'arbitrum-one': 42161,
}

/**
 * Get chain config by chain ID or alias
 */
export function getChainConfig(chainIdOrAlias: number | string): ChainConfig {
  let chainId: number

  if (typeof chainIdOrAlias === 'string') {
    const alias = chainIdOrAlias.toLowerCase()
    chainId = CHAIN_ALIASES[alias]
    if (!chainId) {
      // Try parsing as number
      chainId = parseInt(alias, 10)
    }
  } else {
    chainId = chainIdOrAlias
  }

  const config = B402_CHAINS[chainId]
  if (!config) {
    throw new Error(`Unsupported chain: ${chainIdOrAlias}. Supported: ${Object.keys(CHAIN_ALIASES).join(', ')}`)
  }

  return config
}

/**
 * Get token address for a chain
 */
export function getTokenAddress(chainId: number, symbol: string): `0x${string}` {
  const chain = B402_CHAINS[chainId]
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainId}`)
  }

  const token = chain.tokens[symbol.toUpperCase()]
  if (!token) {
    throw new Error(`Unsupported token ${symbol} on chain ${chain.name}`)
  }

  return token.address
}

/**
 * Get Railgun relay contract for a chain
 */
export function getRailgunRelay(chainId: number): `0x${string}` {
  const chain = B402_CHAINS[chainId]
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainId}`)
  }
  return chain.railgunRelay
}

/**
 * Get RelayAdapt cross-contract call router for a chain.
 * Throws if the chain has no RelayAdapt deployed (required for private DeFi / bridges).
 */
export function getRelayAdaptAddress(chainId: number): `0x${string}` {
  const chain = B402_CHAINS[chainId]
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainId}`)
  }
  if (!chain.relayAdapt) {
    throw new Error(`RelayAdapt not deployed on chain ${chain.name} (${chainId})`)
  }
  return chain.relayAdapt
}

/**
 * Get backend API URL for a chain
 */
export function getBackendApiUrl(chainId: number): string {
  const chain = B402_CHAINS[chainId]
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainId}`)
  }
  return chain.backendApiUrl
}

// Standard ERC-4337 contracts deployed via deterministic CREATE2 — same address on every chain
const ERC4337_CONTRACTS = {
  ENTRY_POINT: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as `0x${string}`,
  NEXUS_FACTORY: '0x0000006648ED9B2B842552BE63Af870bC74af837' as `0x${string}`,
  NEXUS_BOOTSTRAP: '0x0000003eDf18913c01cBc482C978bBD3D6E8ffA3' as `0x${string}`,
  K1_VALIDATOR: '0x0000000031ef4155C978d48a8A7d4EDba03b04fE' as `0x${string}`,
} as const

// Chain-specific ERC-4337 paymaster addresses (each chain has its own deployment)
const PAYMASTER_BY_CHAIN: Record<number, `0x${string}`> = {
  8453: '0x9C2D794Cc5ac6C33CDFCb9Ea225766c5CB681650',  // Base
  42161: '0xF1915aE69343e79106423fc898f25083a26B9050', // Arbitrum (deployed 2026-04-13)
}

export interface ChainContracts {
  RAILGUN_RELAY: `0x${string}`
  ENTRY_POINT: `0x${string}`
  NEXUS_FACTORY: `0x${string}`
  NEXUS_BOOTSTRAP: `0x${string}`
  K1_VALIDATOR: `0x${string}`
  PAYMASTER: `0x${string}` | undefined
}

/**
 * Get all contract addresses for a chain (Railgun + ERC-4337 + paymaster).
 * ERC-4337 contracts are deterministic — same address on every chain.
 * Railgun and paymaster are chain-specific.
 */
export function getContractsForChain(chainId: number): ChainContracts {
  const chain = B402_CHAINS[chainId]
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainId}`)
  }
  return {
    RAILGUN_RELAY: chain.railgunRelay,
    ENTRY_POINT: ERC4337_CONTRACTS.ENTRY_POINT,
    NEXUS_FACTORY: ERC4337_CONTRACTS.NEXUS_FACTORY,
    NEXUS_BOOTSTRAP: ERC4337_CONTRACTS.NEXUS_BOOTSTRAP,
    K1_VALIDATOR: ERC4337_CONTRACTS.K1_VALIDATOR,
    PAYMASTER: PAYMASTER_BY_CHAIN[chainId],
  }
}

/**
 * Get the Railgun SDK NetworkName for a chain ID.
 * Used to initialize the Railgun engine and call populateShield/populateUnshield.
 */
export function getRailgunNetworkName(chainId: number): string {
  const entry = RAILGUN_NETWORK_MAP[chainId]
  if (!entry) {
    throw new Error(`Chain ${chainId} not supported by Railgun SDK`)
  }
  return entry.networkName
}

/**
 * Get default chain from environment or fallback to Base
 */
export function getDefaultChainId(): number {
  const chainEnv = process.env.CHAIN || process.env.B402_CHAIN || 'base'
  const chainId = CHAIN_ALIASES[chainEnv.toLowerCase()] || parseInt(chainEnv, 10)

  if (!B402_CHAINS[chainId]) {
    console.warn(`Unknown chain ${chainEnv}, defaulting to Base (8453)`)
    return 8453
  }

  return chainId
}
