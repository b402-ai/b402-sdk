/**
 * Railgun SDK utilities
 * Deterministic credential derivation from EOA private key
 */

import { ethers, Mnemonic } from 'ethers'

// Unified message for all Railgun operations
// MUST match signature-cache.ts and incognito.ts
export const B402_UNIFIED_MESSAGE = 'b402 Incognito EOA Derivation'

/**
 * Derives a deterministic BIP39 mnemonic from an EOA private key
 * Uses UNIFIED message to match browser wallet flow
 */
export async function deriveMnemonicFromEOA(eoaPrivateKey: string): Promise<string> {
  const wallet = new ethers.Wallet(eoaPrivateKey)
  const signature = await wallet.signMessage(B402_UNIFIED_MESSAGE)
  const entropy = ethers.keccak256(signature).slice(0, 34) // 32 bytes + '0x'
  const mnemonic = Mnemonic.fromEntropy(entropy)
  return mnemonic.phrase
}

/**
 * Generates a random 32-byte private key for shield operations
 */
export function getShieldPrivateKey(): string {
  return ethers.hexlify(ethers.randomBytes(32))
}

