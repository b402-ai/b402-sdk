/**
 * Morpho Vault Registry — chain-aware
 *
 * MetaMorpho ERC-4626 vaults. Users deposit USDC; curators allocate across
 * Morpho lending markets. Vault keys are stable across chains where possible
 * (e.g. `steakhouse` exists on both Base and Arbitrum).
 */

import { ethers } from 'ethers'

export interface MorphoVault {
  address: string
  name: string
  curator: string
  token: string      // underlying asset symbol
  decimals: number
}

const BASE_VAULTS: Record<string, MorphoVault> = {
  steakhouse: {
    address: '0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183',
    name: 'Steakhouse USDC',
    curator: 'Steakhouse Financial',
    token: 'USDC',
    decimals: 6,
  },
  moonwell: {
    address: '0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca',
    name: 'Moonwell Flagship USDC',
    curator: 'Moonwell',
    token: 'USDC',
    decimals: 6,
  },
  gauntlet: {
    address: '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61',
    name: 'Gauntlet USDC Prime',
    curator: 'Gauntlet',
    token: 'USDC',
    decimals: 6,
  },
  'steakhouse-hy': {
    address: '0xCBeeF01994E24a60f7DCB8De98e75AD8BD4Ad60d',
    name: 'Steakhouse High Yield USDC',
    curator: 'Steakhouse Financial',
    token: 'USDC',
    decimals: 6,
  },
}

// Verified live from Morpho API (api.morpho.org/graphql) Apr 2026.
// Steakhouse High Yield is the highest-TVL reputable USDC vault on Arb.
// No Moonwell on Arb (they're Base/Optimism only).
const ARB_VAULTS: Record<string, MorphoVault> = {
  'steakhouse-hy': {
    address: '0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA',
    name: 'Steakhouse High Yield USDC',
    curator: 'Steakhouse Financial',
    token: 'USDC',
    decimals: 6,
  },
  steakhouse: {
    address: '0x250CF7c82bAc7cB6cf899b6052979d4B5BA1f9ca',
    name: 'Steakhouse Prime USDC',
    curator: 'Steakhouse Financial',
    token: 'USDC',
    decimals: 6,
  },
  gauntlet: {
    address: '0x7e97fa6893871A2751B5fE961978DCCb2c201E65',
    name: 'Gauntlet USDC Core',
    curator: 'Gauntlet',
    token: 'USDC',
    decimals: 6,
  },
  'gauntlet-prime': {
    address: '0x7c574174DA4b2be3f705c6244B4BfA0815a8B3Ed',
    name: 'Gauntlet USDC Prime',
    curator: 'Gauntlet',
    token: 'USDC',
    decimals: 6,
  },
}

export const MORPHO_VAULTS_BY_CHAIN: Record<number, Record<string, MorphoVault>> = {
  8453: BASE_VAULTS,
  42161: ARB_VAULTS,
}

/**
 * Base vault map. Kept as the unscoped export for backward compatibility —
 * pre-multi-chain consumers (e.g. `B402.vaults`) import this name.
 * For chain-aware lookup, use `getMorphoVaults(chainId)`.
 */
export const MORPHO_VAULTS: Record<string, MorphoVault> = BASE_VAULTS

export function getMorphoVaults(chainId: number): Record<string, MorphoVault> {
  return MORPHO_VAULTS_BY_CHAIN[chainId] ?? {}
}

export const ERC4626_INTERFACE = new ethers.Interface([
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)',
  'function previewDeposit(uint256 assets) view returns (uint256 shares)',
  'function convertToAssets(uint256 shares) view returns (uint256 assets)',
  'function balanceOf(address owner) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function asset() view returns (address)',
])

/**
 * Resolve a vault name or address to its config on the given chain.
 * Defaults to Base (8453) when chainId is omitted to preserve old call sites.
 */
export function resolveVault(nameOrAddress: string, chainId: number = 8453): MorphoVault {
  const vaults = MORPHO_VAULTS_BY_CHAIN[chainId]
  if (!vaults) {
    throw new Error(`No Morpho vaults configured for chainId ${chainId}. Supported: ${Object.keys(MORPHO_VAULTS_BY_CHAIN).join(', ')}`)
  }

  const key = nameOrAddress.toLowerCase()
  if (vaults[key]) return vaults[key]

  for (const vault of Object.values(vaults)) {
    if (vault.address.toLowerCase() === key) return vault
  }

  throw new Error(
    `Unknown vault "${nameOrAddress}" on chainId ${chainId}. Available: ${Object.keys(vaults).join(', ')}`,
  )
}
