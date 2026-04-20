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
    if (existsSync(CACHE_FILE)) {
      const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
      for (const [key, shields] of Object.entries(data)) {
        cache.set(key, shields as CachedShield[])
      }
    }
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
    const obj: Record<string, CachedShield[]> = {}
    for (const [key, shields] of cache.entries()) {
      obj[key] = shields
    }
    writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2))
  } catch {
    // Best-effort persistence
  }
}

export function getCachedShield(key: string): CachedShield | null {
  ensureLoaded()
  const shields = cache.get(key.toLowerCase())
  return shields?.[0] ?? null
}

export function getCachedShields(walletKey: string): CachedShield[] {
  ensureLoaded()
  return cache.get(walletKey.toLowerCase()) || []
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
