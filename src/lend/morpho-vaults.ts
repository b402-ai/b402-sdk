/**
 * Morpho Vault Registry — ERC-4626 vaults on Base
 *
 * Each vault is a MetaMorpho vault that allocates deposits across
 * Morpho lending markets. Users deposit USDC, vault curators optimize yield.
 */

import { ethers } from 'ethers'

export interface MorphoVault {
  address: string
  name: string
  curator: string
  token: string      // underlying asset symbol
  decimals: number
}

export const MORPHO_VAULTS: Record<string, MorphoVault> = {
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
} as const

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
 * Resolve a vault name to its config.
 * Accepts: name (e.g. "steakhouse") or address (e.g. "0xbeeF...").
 */
export function resolveVault(nameOrAddress: string): MorphoVault {
  const key = nameOrAddress.toLowerCase()

  // Try by name
  if (MORPHO_VAULTS[key]) return MORPHO_VAULTS[key]

  // Try by address
  for (const vault of Object.values(MORPHO_VAULTS)) {
    if (vault.address.toLowerCase() === key) return vault
  }

  throw new Error(
    `Unknown vault: ${nameOrAddress}. Available: ${Object.keys(MORPHO_VAULTS).join(', ')}`,
  )
}
