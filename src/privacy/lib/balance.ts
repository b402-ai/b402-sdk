/**
 * Client-Side Balance Calculator
 * 
 * Calculates spendable shielded balance from UTXOs without requiring backend API calls.
 * Uses the same UTXO fetching logic as unshield operations.
 * Includes caching to avoid repeated API calls.
 */

import type { Signer } from 'ethers'
import { getTokenAddress } from './tokens'
import { getCachedSignature } from './signature-cache'
import { fetchSpendableUTXOsLightweight } from './utxo-fetcher'
import type { ShieldCommitment } from './types'
import type { DecryptedNote } from './utxo-fetcher'

// Lightweight UTXO type (no merkle proof - just for balance display)
interface LightweightUTXO {
  commitment: ShieldCommitment
  note: DecryptedNote
  nullifier: string
  position: number
  tree: number
}

// Cache for UTXO data (keyed by EOA address)
interface UTXOCacheEntry {
  utxos: LightweightUTXO[]
  timestamp: number
  keys: {
    masterPublicKey: string
    nullifyingKey: string
  }
}

const UTXO_CACHE = new Map<string, UTXOCacheEntry>()
const CACHE_DURATION_MS = 60 * 1000 // 60 seconds cache (increased from 30s)

// Request deduplication - prevent concurrent identical API calls
let pendingFetchPromise: Promise<PrivacyBalanceResult> | null = null
let pendingFetchAddress: string | null = null

export interface TokenBalance {
  tokenAddress: string
  symbol: string
  spendable: string // Balance in wei (string for JSON serialization)
  balance: string // Same as spendable (for compatibility)
}

export interface PrivacyBalanceResult {
  eoa: string
  balances: TokenBalance[]
}

// Token address to symbol mapping (BSC mainnet)
// Must match SUPPORTED_TOKENS in b402FacilitatorService.ts
const TOKEN_SYMBOLS: Record<string, string> = {
  '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d': 'USD1',
  '0x55d398326f99059ff775485246999027b3197955': 'USDT',
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC',
}

/**
 * Calculate spendable shielded balance client-side
 * 
 * Uses the same UTXO fetching logic as unshield operations.
 * No backend API calls needed - all computation happens in browser.
 * Includes caching to avoid repeated API calls.
 * 
 * @param signer - Ethers signer
 * @param network - Network ('mainnet' or 'testnet')
 * @param forceRefresh - Force refresh even if cache is valid
 * @returns Spendable balance per token
 */
export async function calculateSpendableBalance(
  signer: Signer,
  network: 'mainnet' | 'testnet' = 'mainnet',
  forceRefresh = false
): Promise<PrivacyBalanceResult> {
  const signerAddress = await signer.getAddress()

  // Request deduplication - if we're already fetching for this address, wait for that result
  if (pendingFetchPromise && pendingFetchAddress === signerAddress.toLowerCase()) {
    console.log('[Balance] Deduplicating concurrent request for', signerAddress.slice(0, 10))
    return pendingFetchPromise
  }

  // Create the fetch promise and store it for deduplication
  const fetchPromise = (async (): Promise<PrivacyBalanceResult> => {
    try {
      return await calculateSpendableBalanceInternal(signer, signerAddress, network, forceRefresh)
    } finally {
      // Clear pending state when done
      pendingFetchPromise = null
      pendingFetchAddress = null
    }
  })()

  pendingFetchPromise = fetchPromise
  pendingFetchAddress = signerAddress.toLowerCase()

  return fetchPromise
}

async function calculateSpendableBalanceInternal(
  signer: Signer,
  signerAddress: string,
  network: 'mainnet' | 'testnet',
  forceRefresh: boolean
): Promise<PrivacyBalanceResult> {
  // Step 1: Get signature (cached 24h) - uses unified signature cache
  const signature = await getCachedSignature(signer)

  // Step 2: Derive keys from signature (all client-side)
  const { deriveRailgunKeys } = await import('./key-derivation')
  const keys = await deriveRailgunKeys(signature)

  // Step 3: Check cache
  const cacheKey = signerAddress.toLowerCase()
  const cached = UTXO_CACHE.get(cacheKey)
  const now = Date.now()
  
  let allUTXOs: LightweightUTXO[]

  if (!forceRefresh && cached && (now - cached.timestamp) < CACHE_DURATION_MS) {
    // Use cached UTXOs if cache is valid
    // Verify keys match (in case user switched accounts)
    const keysMatch =
      cached.keys.masterPublicKey === keys.masterPublicKey.toString() &&
      cached.keys.nullifyingKey === keys.nullifyingKey.toString()

    if (keysMatch) {
      allUTXOs = cached.utxos
    } else {
      // Keys don't match, fetch fresh using LIGHTWEIGHT fetch (no merkle proofs)
      allUTXOs = await fetchSpendableUTXOsLightweight(
        signerAddress,
        keys.viewingKeyPair.privateKey,
        keys.masterPublicKey,
        keys.nullifyingKey
      )
      // Update cache
      UTXO_CACHE.set(cacheKey, {
        utxos: allUTXOs,
        timestamp: now,
        keys: {
          masterPublicKey: keys.masterPublicKey.toString(),
          nullifyingKey: keys.nullifyingKey.toString()
        }
      })
    }
  } else {
    // Fetch fresh UTXOs using LIGHTWEIGHT fetch (no merkle proofs)
    // Merkle proofs are only needed for actual withdrawal, not balance display
    allUTXOs = await fetchSpendableUTXOsLightweight(
      signerAddress,
      keys.viewingKeyPair.privateKey,
      keys.masterPublicKey,
      keys.nullifyingKey
      // No tokenAddress filter - get all tokens
    )
    // Update cache
    UTXO_CACHE.set(cacheKey, {
      utxos: allUTXOs,
      timestamp: now,
      keys: {
        masterPublicKey: keys.masterPublicKey.toString(),
        nullifyingKey: keys.nullifyingKey.toString()
      }
    })
  }

  // Group UTXOs by token and calculate balances
  console.log('[Balance] Found', allUTXOs.length, 'total spendable UTXOs:', allUTXOs.map(u => ({
    token: u.note.tokenAddress.slice(0, 10),
    value: u.note.value.toString(),
    position: u.position
  })))
  const tokenBalancesMap = new Map<string, { balance: bigint; utxos: typeof allUTXOs }>()

  for (const utxo of allUTXOs) {
    const tokenAddress = utxo.note.tokenAddress.toLowerCase()
    const current = tokenBalancesMap.get(tokenAddress) || { balance: BigInt(0), utxos: [] }
    tokenBalancesMap.set(tokenAddress, {
      balance: current.balance + utxo.note.value,
      utxos: [...current.utxos, utxo]
    })
  }

  // Convert to TokenBalance array
  const balances: TokenBalance[] = Array.from(tokenBalancesMap.entries())
    .map(([tokenAddress, data]) => {
      const symbol = TOKEN_SYMBOLS[tokenAddress.toLowerCase()] || 'UNKNOWN'
      const balanceWei = data.balance.toString()

      return {
        tokenAddress,
        symbol,
        spendable: balanceWei,
        balance: balanceWei
      }
    })
    .filter(b => b.symbol !== 'UNKNOWN') // Only return known tokens

  return {
    eoa: signerAddress,
    balances
  }
}

/**
 * Get spendable balance for a specific token
 * Uses cached UTXOs if available
 * 
 * @param signer - Ethers signer
 * @param token - Token symbol (USD1, USDT, USDC)
 * @param network - Network ('mainnet' or 'testnet')
 * @param forceRefresh - Force refresh even if cache is valid
 * @returns Spendable balance in wei (as string)
 */
export async function getTokenSpendableBalance(
  signer: Signer,
  token: string,
  network: 'mainnet' | 'testnet' = 'mainnet',
  forceRefresh = false
): Promise<string> {
  const signerAddress = await signer.getAddress()
  const tokenAddress = getTokenAddress(network, token as any)

  // Use calculateSpendableBalance which has caching
  const result = await calculateSpendableBalance(signer, network, forceRefresh)
  const tokenBalance = result.balances.find(b => 
    b.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
  )

  return tokenBalance?.spendable || '0'
}

/**
 * Clear UTXO cache for a specific address or all addresses
 * 
 * @param address - Optional address to clear cache for. If not provided, clears all.
 */
export function clearUTXOCache(address?: string): void {
  if (address) {
    UTXO_CACHE.delete(address.toLowerCase())
  } else {
    UTXO_CACHE.clear()
  }
}

