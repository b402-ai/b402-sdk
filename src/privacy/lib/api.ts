/**
 * Privacy API client for B402 backend
 */

import type {
  ShieldCommitment,
  NullifierScanResponse,
  MerkleProofResponse,
  OutputCommitment
} from './types'

// Re-export types for use in other modules
export type { ShieldCommitment, OutputCommitment, MerkleProofResponse } from './types'

/** Retry-aware fetch: retries on 429 / 5xx with exponential backoff */
async function fetchWithRetry(url: string, init?: RequestInit, maxRetries = 8): Promise<Response> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, init)
      if (res.status === 429 || res.status >= 500) {
        // Check for permanent errors that won't self-heal (don't retry these)
        if (res.status === 500) {
          const body = await res.clone().text().catch(() => '')
          if (body.includes('database inconsistency') || body.includes('invalid merkle proof')) {
            // Return the response as-is — caller should handle permanent errors
            return res
          }
        }
        // Longer initial delay for 429 (Cloud Run cold start takes ~7s)
        const baseDelay = res.status === 429 ? 5000 : 2000
        const delay = Math.min(baseDelay * Math.pow(2, attempt), 60000)
        if (process.env.DEBUG) console.log(`  [API] ${res.status} on ${url.split('?')[0]} — retry ${attempt + 1}/${maxRetries} in ${(delay / 1000).toFixed(0)}s`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      return res
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      const delay = Math.min(5000 * Math.pow(2, attempt), 60000)
      if (process.env.DEBUG) console.log(`  [API] fetch error — retry ${attempt + 1}/${maxRetries} in ${(delay / 1000).toFixed(0)}s`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr || new Error(`fetchWithRetry: all ${maxRetries} attempts failed for ${url}`)
}

export interface CommitmentsResponse {
  shields: ShieldCommitment[]
  unshieldedAmounts?: Record<string, string> // token address -> amount in wei
}

export async function fetchCommitmentsByEOA(
  apiUrl: string,
  eoa: string,
  incognitoWallet?: string,
  chainId?: number
): Promise<CommitmentsResponse> {
  // Build query params
  const params = new URLSearchParams({ eoa })
  if (incognitoWallet) {
    params.append('incognitoWallet', incognitoWallet)
  }
  if (chainId) {
    params.append('chainId', chainId.toString())
  }

  // Use backend API directly
  const apiBaseUrl = apiUrl || process.env.B402_BACKEND_API_URL || 'http://localhost:3002'
  const url = `${apiBaseUrl}/privacy/commitments?${params.toString()}`

  const response = await fetchWithRetry(url)
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as { shields?: ShieldCommitment[], unshieldedAmounts?: Record<string, string> }
  return { shields: data.shields || [], unshieldedAmounts: data.unshieldedAmounts }
}

export async function fetchNullifierData(
  apiUrl: string,
  nullifiers: string[],
  chainId?: number
): Promise<NullifierScanResponse> {
  if (nullifiers.length > 1000) {
    throw new Error('Maximum 1000 nullifiers per request')
  }

  // Use backend API directly
  const apiBaseUrl = apiUrl || process.env.B402_BACKEND_API_URL || 'http://localhost:3002'
  const url = `${apiBaseUrl}/privacy/nullifiers`
  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nullifiers, ...(chainId ? { chainId } : {}) })
  })

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as NullifierScanResponse
}

export async function fetchNullifierDataBatched(
  apiUrl: string,
  nullifiers: string[],
  chainId?: number
): Promise<NullifierScanResponse> {
  const batchSize = 1000
  const batches: string[][] = []

  for (let i = 0; i < nullifiers.length; i += batchSize) {
    batches.push(nullifiers.slice(i, i + batchSize))
  }

  const results = await Promise.all(
    batches.map(batch => fetchNullifierData(apiUrl, batch, chainId))
  )

  const merged: NullifierScanResponse = { used: [], unused: [] }
  for (const result of results) {
    merged.used.push(...result.used)
    merged.unused.push(...result.unused)
  }

  return merged
}

/**
 * Fetch merkle proof with retry logic
 *
 * The backend merkle tree may take 30-90 seconds to sync after a new shield.
 * This function retries with exponential backoff until the proof is available.
 */
export async function fetchMerkleProof(
  apiUrl: string,
  commitmentHash: string,
  treeNumber: string,
  position: string,
  options?: { maxRetries?: number; initialDelayMs?: number; chainId?: number }
): Promise<MerkleProofResponse> {
  const maxRetries = options?.maxRetries ?? 8
  const initialDelayMs = options?.initialDelayMs ?? 10000  // 10 seconds

  // Use backend API directly
  const apiBaseUrl = apiUrl || process.env.B402_BACKEND_API_URL || 'http://localhost:3002'
  const chainParam = options?.chainId ? `&chainId=${options.chainId}` : ''
  const url = `${apiBaseUrl}/privacy/merkle-proof?commitmentHash=${commitmentHash}&treeNumber=${treeNumber}&position=${position}${chainParam}`

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithRetry(url, undefined, 5)

      if (response.ok) {
        return (await response.json()) as MerkleProofResponse
      }

      const errorBody = await response.text().catch(() => 'no body')

      // Database inconsistency is permanent — don't retry
      if (errorBody.includes('database inconsistency') || errorBody.includes('invalid merkle proof')) {
        throw new Error(`Merkle proof broken (permanent): ${errorBody.slice(0, 100)}`)
      }

      // Check if it's a retryable error (merkle tree not synced yet)
      const isRetryable = errorBody.includes('not found') ||
                          response.status === 500 ||
                          response.status === 503

      if (!isRetryable) {
        throw new Error(`API error: ${response.status} ${response.statusText}`)
      }

      lastError = new Error(`Merkle proof not ready: ${errorBody}`)

    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      // Don't retry permanent errors — re-throw immediately
      if (lastError.message.includes('(permanent)')) {
        throw lastError
      }
    }

    // Wait before retry with exponential backoff (10s, 15s, 22s, 33s, ...)
    if (attempt < maxRetries) {
      const delayMs = initialDelayMs * Math.pow(1.5, attempt - 1)
      if (process.env.DEBUG) console.log(`  [merkle] pos=${position} attempt ${attempt}/${maxRetries}, retry in ${(delayMs/1000).toFixed(0)}s`)
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  throw lastError || new Error('Failed to fetch merkle proof after all retries')
}

export async function fetchMerkleProofsBatch(
  apiUrl: string,
  requests: Array<{ commitmentHash: string; treeNumber: string; position: string }>,
  options?: { maxRetries?: number; initialDelayMs?: number; chainId?: number }
): Promise<(MerkleProofResponse | null)[]> {
  // Process one at a time to avoid overwhelming the backend during sync
  const results: (MerkleProofResponse | null)[] = []

  for (const req of requests) {
    try {
      const result = await fetchMerkleProof(
        apiUrl,
        req.commitmentHash,
        req.treeNumber,
        req.position,
        options
      )
      results.push(result)
    } catch (err: any) {
      // Skip commitments with broken merkle proofs (database inconsistency)
      if (process.env.DEBUG) console.log(`  [merkle] Skipping pos=${req.position}: ${err.message?.slice(0, 80)}`)
      results.push(null)
    }
  }

  return results
}

export async function submitUnshieldTransaction(
  apiUrl: string,
  transaction: {
    serializedTransaction: string
    toAddress: string
    relayerFee: string
  }
): Promise<{ txHash: string }> {
  // Use backend API directly
  const apiBaseUrl = apiUrl || process.env.B402_BACKEND_API_URL || 'http://localhost:3002'
  const url = `${apiBaseUrl}/privacy/broadcast`
  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(transaction)
  })

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as { txHash: string }
}

// Queue unshield request - backend broadcaster will execute in 1-3 hours
// Endpoint: POST /privacy/unshield
export interface UnshieldQueueRequest {
  txidVersion: string            // e.g., "V2_PoseidonMerkle"
  transactionTo: string          // Railgun contract address
  transactionData: string        // Hex-encoded tx data (0x...)
  chain: {
    type: number                 // Chain type (0 for EVM)
    id: number                   // Chain ID (56 for BSC)
  }
  nullifierHash: string          // 32-byte hex (0x + 64 chars)
}

export interface UnshieldQueueResponse {
  exists: boolean                // true if request already queued (deduplication)
  unshieldId: string             // UUID to track status
  timeElapsedMs?: number         // (if exists) time since creation in ms
  broadcasterTxHash?: string     // (if exists) tx hash from broadcaster
  createdAt?: string             // (if exists) creation timestamp
  broadcastedAt?: string         // (if exists) when it was broadcast
  completedAt?: string           // (if exists) when it completed
}

export async function queueUnshield(
  _apiUrl: string, // Ignored - using internal route for security
  request: UnshieldQueueRequest
): Promise<UnshieldQueueResponse> {
  // Use internal API route that adds x-api-secret header server-side
  // This prevents exposing the secret in client-side code
  const response = await fetch('/api/privacy/unshield', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Queue unshield failed: ${response.status} ${errorText}`)
  }

  return (await response.json()) as UnshieldQueueResponse
}

// NOTE: queueChangeNoteUnshield() has been removed.
// Instead, use queueChangeNoteAfterTransact() from auto-unshield.ts
// which uses the existing /privacy/unshield endpoint after waiting for indexing.
