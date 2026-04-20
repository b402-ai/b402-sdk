/**
 * Morpho GraphQL API client — live vault metrics (APY, TVL, fees)
 *
 * Endpoint: https://api.morpho.org/graphql
 * Uses V1 vaultByAddress query with GraphQL aliases for batch fetching.
 */

import { MORPHO_VAULTS } from './morpho-vaults'

const MORPHO_API = 'https://api.morpho.org/graphql'
const CACHE_TTL_MS = 60_000 // 60 seconds

export interface VaultMetrics {
  /** Gross APY as decimal (0.0357 = 3.57%) */
  apy: number
  /** Net APY after fees (what users actually earn) */
  netApy: number
  /** Total value locked in USD */
  totalAssetsUsd: number
  /** Vault fee as decimal (0.25 = 25%) */
  fee: number
}

// ── Cache ──

let cachedMetrics: Record<string, VaultMetrics> | null = null
let cacheTimestamp = 0

function getCached(): Record<string, VaultMetrics> | null {
  if (cachedMetrics && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedMetrics
  }
  return null
}

function setCache(data: Record<string, VaultMetrics>): void {
  cachedMetrics = data
  cacheTimestamp = Date.now()
}

// ── API ──

/**
 * Batch-fetch metrics for all registered vaults in one GraphQL request.
 * Returns a map keyed by vault slug (e.g. "steakhouse", "moonwell").
 * Returns null if the API is unreachable.
 */
export async function fetchAllVaultMetrics(
  chainId: number = 8453,
): Promise<Record<string, VaultMetrics> | null> {
  const cached = getCached()
  if (cached) return cached

  try {
    // Build aliased query: steakhouse: vaultByAddress(...) { ... }
    const fragments = Object.entries(MORPHO_VAULTS).map(([key, vault]) => {
      const alias = key.replace('-', '_') // GraphQL aliases can't have hyphens
      return `${alias}: vaultByAddress(address: "${vault.address}", chainId: ${chainId}) { name state { apy netApy totalAssetsUsd fee } }`
    })

    const query = `{ ${fragments.join(' ')} }`

    const res = await fetch(MORPHO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })

    if (!res.ok) return null

    const json = await res.json() as any
    if (!json.data) return null

    const result: Record<string, VaultMetrics> = {}
    for (const [key] of Object.entries(MORPHO_VAULTS)) {
      const alias = key.replace('-', '_')
      const vault = json.data[alias]
      if (vault?.state) {
        result[key] = {
          apy: vault.state.apy ?? 0,
          netApy: vault.state.netApy ?? 0,
          totalAssetsUsd: vault.state.totalAssetsUsd ?? 0,
          fee: vault.state.fee ?? 0,
        }
      }
    }

    setCache(result)
    return result
  } catch {
    return null
  }
}

/**
 * Fetch metrics for a single vault by address.
 * Returns null if the API is unreachable or vault not found.
 */
export async function fetchVaultMetrics(
  address: string,
  chainId: number = 8453,
): Promise<VaultMetrics | null> {
  // Try batch cache first
  const cached = getCached()
  if (cached) {
    for (const [key, vault] of Object.entries(MORPHO_VAULTS)) {
      if (vault.address.toLowerCase() === address.toLowerCase() && cached[key]) {
        return cached[key]
      }
    }
  }

  try {
    const query = `{ vaultByAddress(address: "${address}", chainId: ${chainId}) { name state { apy netApy totalAssetsUsd fee } } }`

    const res = await fetch(MORPHO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })

    if (!res.ok) return null

    const json = await res.json() as any
    const vault = json.data?.vaultByAddress
    if (!vault?.state) return null

    return {
      apy: vault.state.apy ?? 0,
      netApy: vault.state.netApy ?? 0,
      totalAssetsUsd: vault.state.totalAssetsUsd ?? 0,
      fee: vault.state.fee ?? 0,
    }
  } catch {
    return null
  }
}

/**
 * Format TVL as human-readable string (e.g. "$285.5M", "$14.9M", "$190K")
 */
export function formatTVL(usd: number): string {
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(1)}B`
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(0)}K`
  return `$${usd.toFixed(0)}`
}

/**
 * Format APY as percentage string (e.g. "3.57%")
 */
export function formatAPY(apy: number): string {
  return `${(apy * 100).toFixed(2)}%`
}
