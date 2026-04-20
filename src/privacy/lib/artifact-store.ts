/**
 * Artifact Store for Railgun Circuit Files
 *
 * Stores circuit artifacts (wasm, zkey, vkey) persistently.
 * - Browser: Uses IndexedDB for persistent storage
 * - Node.js: Uses file system for persistent storage
 *
 * Total size: ~9.5MB (downloaded once, cached forever)
 *
 * This enables client-side ZK proof generation without re-downloading
 * circuit files on every session.
 */

// Browser API declarations for isomorphic code (Node.js SDK uses file system path)
declare var window: any
declare var indexedDB: any
declare type IDBDatabase = any
declare type IDBOpenDBRequest = any

// Define ArtifactStore locally to avoid importing @railgun-community/wallet
// which has internal RPC initialization that can fail
type GetArtifact = (path: string) => Promise<string | Buffer | null>
type StoreArtifact = (dir: string, path: string, item: string | Uint8Array) => Promise<void>
type ArtifactExists = (path: string) => Promise<boolean>

class ArtifactStore {
  get: GetArtifact
  store: StoreArtifact
  exists: ArtifactExists

  constructor(get: GetArtifact, store: StoreArtifact, exists: ArtifactExists) {
    this.get = get
    this.store = store
    this.exists = exists
  }
}

// Detect environment
const isNode = typeof window === 'undefined' && typeof process !== 'undefined'

// Node.js cache directory
// Anchored to the user's home dir so spawned processes (MCP in Claude Desktop,
// systemd services, etc.) write to a predictable writable location instead of
// the caller's CWD. Override with B402_ARTIFACTS_DIR.
const NODE_CACHE_DIR =
  process.env.B402_ARTIFACTS_DIR ||
  (typeof process !== 'undefined' && process.env?.HOME
    ? `${process.env.HOME}/.b402/artifacts`
    : './.cache/artifacts')

const DB_NAME = 'railgun-artifacts'
const DB_VERSION = 1
const STORE_NAME = 'artifacts'

// ============================================
// Node.js File-Based Storage
// ============================================

/**
 * Creates a file-system-backed artifact store for Node.js
 */
async function createFileArtifactStore(): Promise<ArtifactStore> {
  const fs = await import('fs')
  const pathModule = await import('path')

  // Get artifact from file system
  const get = async (artifactPath: string): Promise<string | Buffer | null> => {
    try {
      const filePath = pathModule.join(NODE_CACHE_DIR, artifactPath)
      if (!fs.existsSync(filePath)) {
        return null
      }
      return fs.readFileSync(filePath)
    } catch {
      return null
    }
  }

  // Store artifact to file system
  const store = async (dir: string, artifactPath: string, item: string | Uint8Array): Promise<void> => {
    const filePath = pathModule.join(NODE_CACHE_DIR, artifactPath)
    const fileDir = pathModule.dirname(filePath)

    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true })
    }

    fs.writeFileSync(filePath, Buffer.from(item))
  }

  // Check if artifact exists in file system
  const exists = async (artifactPath: string): Promise<boolean> => {
    try {
      const filePath = pathModule.join(NODE_CACHE_DIR, artifactPath)
      return fs.existsSync(filePath)
    } catch {
      return false
    }
  }

  return new ArtifactStore(get, store, exists)
}

// ============================================
// Browser IndexedDB Storage
// ============================================

/**
 * Opens or creates the IndexedDB database for artifact storage
 */
async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`))
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
  })
}

/**
 * Creates an IndexedDB-backed artifact store for browser
 */
async function createBrowserArtifactStore(): Promise<ArtifactStore> {
  const db = await openDatabase()

  // Get artifact from IndexedDB
  const get = async (path: string): Promise<string | Buffer | null> => {
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const store = tx.objectStore(STORE_NAME)
        const request = store.get(path)

        request.onsuccess = () => {
          resolve(request.result || null)
        }

        request.onerror = () => {
          reject(new Error(`Failed to get artifact: ${request.error?.message}`))
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  // Store artifact in IndexedDB
  const store = async (dir: string, path: string, item: string | Uint8Array): Promise<void> => {
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const objectStore = tx.objectStore(STORE_NAME)
        const request = objectStore.put(item, path)

        request.onsuccess = () => {
          resolve()
        }

        request.onerror = () => {
          reject(new Error(`Failed to store artifact: ${request.error?.message}`))
        }
      } catch (error) {
        reject(error)
      }
    })
  }

  // Check if artifact exists in IndexedDB
  const exists = async (path: string): Promise<boolean> => {
    try {
      const item = await get(path)
      return item !== null
    } catch {
      return false
    }
  }

  return new ArtifactStore(get, store, exists)
}

// ============================================
// Public API
// ============================================

/**
 * Creates an artifact store for Railgun circuits
 * Automatically uses the right storage backend based on environment:
 * - Browser: IndexedDB
 * - Node.js: File system
 *
 * @returns ArtifactStore instance
 */
export async function createIndexedDBArtifactStore(): Promise<ArtifactStore> {
  if (isNode) {
    return createFileArtifactStore()
  } else {
    return createBrowserArtifactStore()
  }
}

/**
 * Clears all cached artifacts
 * - Browser: Deletes IndexedDB
 * - Node.js: Deletes cache directory
 */
export async function clearArtifactCache(): Promise<void> {
  if (isNode) {
    const fs = await import('fs')
    if (fs.existsSync(NODE_CACHE_DIR)) {
      fs.rmSync(NODE_CACHE_DIR, { recursive: true })
    }
  } else {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB_NAME)

      request.onsuccess = () => {
        resolve()
      }

      request.onerror = () => {
        reject(new Error(`Failed to clear artifact cache: ${request.error?.message}`))
      }
    })
  }
}

/**
 * Checks if artifacts are already cached
 * Can be used to show different UI for first-time vs returning users
 */
export async function areArtifactsCached(): Promise<boolean> {
  try {
    const store = await createIndexedDBArtifactStore()
    // Check for the main circuit file (01x01 is the simplest circuit)
    return await store.exists('artifacts-v2.1/01x01/wasm')
  } catch {
    return false
  }
}
