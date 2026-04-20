/**
 * In-memory signature cache for Node.js SDK.
 * Caches Railgun wallet signatures to avoid re-deriving keys each operation.
 */

const cache = new Map<string, string>()

function resolveKey(key: any): string {
  if (typeof key === 'string') return key
  if (key?.address) return key.address
  return String(key)
}

export function getCachedSignature(key: any): string | null {
  return cache.get(resolveKey(key)) ?? null
}

export function setCachedSignature(key: any, signature: string): void {
  cache.set(resolveKey(key), signature)
}

export function clearSignatureCache(): void {
  cache.clear()
}

export function hasCachedSignature(key: any): boolean {
  return cache.has(resolveKey(key))
}
