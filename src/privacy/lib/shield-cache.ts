/**
 * Persistent shield cache for Node.js SDK.
 *
 * Shields from UserOp TXs are indexed by the bundler address on the backend,
 * not the user's EOA. This cache persists shield data (position, treeNumber,
 * commitment hash, encrypted bundle) extracted from the TX receipt so UTXOs
 * can be discovered without querying the bundler address.
 *
 * Cache file: ~/.b402/shield-cache.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface CachedShield {
  txHash: string
  tokenAddress: string
  amount: string
  indexed: boolean
  timestamp: number
  /** Chain the shield was created on. Optional for back-compat with pre-multichain caches. */
  chainId?: number
  commitmentHash?: string
  treeNumber?: any
  position?: any
  npk?: string
  encryptedBundle0?: string
  encryptedBundle1?: string
  encryptedBundle2?: string
  shieldKey?: string
  [key: string]: any
}

const CACHE_DIR = join(homedir(), '.b402')
const CACHE_FILE = join(CACHE_DIR, 'shield-cache.json')

// Bump when the file shape changes in a way that invalidates older entries.
// On read, files without this version are wiped — they predate chainId
// tagging and would cause cross-chain leaks if surfaced.
const CACHE_VERSION = 2

// In-memory cache backed by disk
let cache = new Map<string, CachedShield[]>()
let loaded = false
let testMode = false

/** Disable disk persistence (for tests). */
export function setTestMode(enabled: boolean): void {
  testMode = enabled
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  if (testMode) return
  try {
    if (!existsSync(CACHE_FILE)) return
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
    if (raw && typeof raw === 'object' && raw.__version === CACHE_VERSION && raw.entries) {
      for (const [key, shields] of Object.entries(raw.entries)) {
        cache.set(key, shields as CachedShield[])
      }
    }
    // else: legacy/unversioned file — leave cache empty so no stale entries
    // get returned. Backend indexer covers any actual shields the user has.
  } catch {
    // Corrupted file — start fresh
    cache = new Map()
  }
}

function persist(): void {
  if (testMode) return
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true })
    }
    const entries: Record<string, CachedShield[]> = {}
    for (const [key, shields] of cache.entries()) {
      entries[key] = shields
    }
    writeFileSync(
      CACHE_FILE,
      JSON.stringify({ __version: CACHE_VERSION, entries }, null, 2),
    )
  } catch {
    // Best-effort persistence
  }
}

export function getCachedShield(key: string): CachedShield | null {
  ensureLoaded()
  const shields = cache.get(key.toLowerCase())
  return shields?.[0] ?? null
}

/**
 * Read cached shields, scoped to one chain.
 *
 * The cache is a fresh-shield buffer — the chain-scoped backend API is the
 * source of truth for shield commitments. Cache entries written before
 * `chainId` tagging are dropped on first read after upgrade (see
 * `ensureLoaded`'s schema-version migration); we never guess their chain
 * from on-chain data because addresses (token, vault) are not unique across
 * chains.
 */
export function getCachedShields(walletKey: string, chainId?: number): CachedShield[] {
  ensureLoaded()
  const all = cache.get(walletKey.toLowerCase()) || []
  if (chainId === undefined) return all
  return all.filter((s) => s.chainId === chainId)
}

export function setCachedShield(key: string, entry: CachedShield): void {
  ensureLoaded()
  key = key.toLowerCase()
  const shields = cache.get(key) || []
  // Deduplicate by position+treeNumber
  if (entry.position && entry.treeNumber) {
    const exists = shields.some(
      s => s.position === entry.position && s.treeNumber === entry.treeNumber
    )
    if (exists) return
  }
  shields.push(entry)
  cache.set(key, shields)
  persist()
}

export function clearShieldCache(): void {
  cache = new Map()
  loaded = true
  persist()
}
