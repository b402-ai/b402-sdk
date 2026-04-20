/**
 * Persistent change note store.
 * Stores change notes from partial unshields so they can be spent in subsequent operations.
 *
 * Uses a JSON file in the user's home directory (~/.b402/change-notes.json).
 * Falls back to in-memory if file I/O fails (browser environment).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface StoredChangeNote {
  [key: string]: any
}

// ── File path ────────────────────────────────────────────────────────

const B402_DIR = join(homedir(), '.b402')
const STORE_FILE = join(B402_DIR, 'change-notes.json')

// ── File I/O ─────────────────────────────────────────────────────────

function loadStore(): Map<string, StoredChangeNote[]> {
  try {
    if (existsSync(STORE_FILE)) {
      const data = JSON.parse(readFileSync(STORE_FILE, 'utf-8'))
      return new Map(Object.entries(data))
    }
  } catch {
    // Corrupted file or no access — start fresh
  }
  return new Map()
}

function saveStore(store: Map<string, StoredChangeNote[]>): void {
  try {
    if (!existsSync(B402_DIR)) {
      mkdirSync(B402_DIR, { recursive: true })
    }
    const obj: Record<string, StoredChangeNote[]> = {}
    for (const [k, v] of store) {
      obj[k] = v
    }
    writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2))
  } catch {
    // File I/O failed (browser, readonly fs) — silent fail, in-memory still works
  }
}

// ── In-memory cache (loaded lazily from file) ────────────────────────

let _store: Map<string, StoredChangeNote[]> | null = null

function getStore(): Map<string, StoredChangeNote[]> {
  if (!_store) {
    _store = loadStore()
  }
  return _store
}

// ── Public API ───────────────────────────────────────────────────────

export function storeChangeNote(walletKey: string, note: StoredChangeNote): void {
  const store = getStore()
  const notes = store.get(walletKey) || []

  // Deduplicate by commitmentHash
  if (note.commitmentHash && notes.some(n => n.commitmentHash === note.commitmentHash)) {
    return
  }

  notes.push(note)
  store.set(walletKey, notes)
  saveStore(store)
}

export function getChangeNotes(walletKey: string): StoredChangeNote[] {
  return getStore().get(walletKey) || []
}

/** Alias for getChangeNotes (used by utxo-fetcher) */
export const getStoredChangeNotes = getChangeNotes

export function removeChangeNote(walletKey: string, noteHash: string): void {
  const store = getStore()
  const notes = store.get(walletKey) || []
  store.set(walletKey, notes.filter(n => n.commitmentHash !== noteHash && n.noteHash !== noteHash))
  saveStore(store)
}

export function clearChangeNotes(walletKey?: string): void {
  const store = getStore()
  if (walletKey) {
    store.delete(walletKey)
  } else {
    store.clear()
  }
  saveStore(store)
}
