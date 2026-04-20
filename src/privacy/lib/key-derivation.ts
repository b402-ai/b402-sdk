/**
 * Client-Side Key Derivation
 *
 * Derives Railgun keys from a signature.
 * All keys stay in the browser - never sent to server.
 */

import { ethers, Mnemonic } from 'ethers'
// Use main package exports where available
import { ByteUtils, ShieldNote } from '@railgun-community/engine'
// These must be imported from subpaths (not in main export)
// pnpm.packageExtensions in package.json extends the exports to allow these
import { deriveNodes, WalletNode } from '@railgun-community/engine/dist/key-derivation/wallet-node'
import { poseidonHex } from '@railgun-community/engine/dist/utils/poseidon'
import { encodeAddress } from '@railgun-community/engine/dist/key-derivation/bech32'

export interface ViewingKeyPair {
  privateKey: Uint8Array
  pubkey: bigint[]
  _originalPubkey?: Uint8Array | bigint[] // Store original for AddressData conversion
}

export interface SpendingKeyPair {
  privateKey: Uint8Array
  pubkey: bigint[]
}

export interface RailgunKeys {
  mnemonic: string
  viewingKeyPair: ViewingKeyPair
  spendingKeyPair: SpendingKeyPair
  nullifyingKey: bigint
  masterPublicKey: bigint
}

/**
 * Derive Railgun keys from a signature
 *
 * @param signature - Signature of B402_UNIFIED_MESSAGE ('b402 Incognito EOA Derivation')
 * @returns All derived keys needed for Railgun operations
 */
export async function deriveRailgunKeys(signature: string): Promise<RailgunKeys> {
  // Step 1: Derive mnemonic from signature
  // Same method as backend: keccak256(signature) → first 16 bytes → BIP39 mnemonic
  const entropy = ethers.keccak256(signature).slice(0, 34) // 0x + 32 hex chars = 16 bytes
  const mnemonic = Mnemonic.fromEntropy(entropy).phrase

  // Step 2: Derive wallet nodes from mnemonic
  const walletNodes = deriveNodes(mnemonic, 0) // index 0

  // Step 3: Get viewing key pair
  const viewingKeyPair = await walletNodes.viewing.getViewingKeyPair()

  // Step 4: Get spending key pair
  const spendingKeyPair = walletNodes.spending.getSpendingKeyPair()

  // Step 5: Compute nullifying key from viewing private key
  // nullifyingKey = poseidon(viewingPrivateKey)
  const nullifyingKey = ByteUtils.hexToBigInt(
    poseidonHex([ByteUtils.fastBytesToHex(viewingKeyPair.privateKey)])
  )

  // Step 6: Compute master public key
  // masterPublicKey = WalletNode.getMasterPublicKey(spendingPubkey, nullifyingKey)
  const masterPublicKey = WalletNode.getMasterPublicKey(spendingKeyPair.pubkey, nullifyingKey)

  // Store original viewingPublicKey for AddressData (needs to be Uint8Array)
  const originalViewingPubkey = viewingKeyPair.pubkey

  // Convert pubkey to bigint[] format for our interface
  const viewingPubkey = Array.isArray(viewingKeyPair.pubkey)
    ? viewingKeyPair.pubkey.map((p: any) => typeof p === 'bigint' ? p : BigInt(p))
    : [BigInt(`0x${Buffer.from(viewingKeyPair.pubkey).toString('hex')}`)]

  const spendingPubkey = Array.isArray(spendingKeyPair.pubkey)
    ? spendingKeyPair.pubkey.map((p: any) => typeof p === 'bigint' ? p : BigInt(p))
    : [BigInt(`0x${Buffer.from(spendingKeyPair.pubkey).toString('hex')}`)]

  return {
    mnemonic,
    viewingKeyPair: {
      privateKey: viewingKeyPair.privateKey,
      pubkey: viewingPubkey as bigint[],
      // Store original for AddressData conversion
      _originalPubkey: originalViewingPubkey
    },
    spendingKeyPair: {
      privateKey: spendingKeyPair.privateKey,
      pubkey: spendingPubkey as bigint[]
    },
    nullifyingKey,
    masterPublicKey
  }
}

/**
 * Get the Railgun address (0zk...) from derived keys
 */
export function getRailgunAddress(keys: RailgunKeys): string {
  // Use original pubkey if available, otherwise convert from bigint[]
  let viewingPublicKey: Uint8Array
  if (keys.viewingKeyPair._originalPubkey) {
    viewingPublicKey = keys.viewingKeyPair._originalPubkey instanceof Uint8Array
      ? keys.viewingKeyPair._originalPubkey
      : new Uint8Array(Buffer.from(keys.viewingKeyPair._originalPubkey.map(p => Number(p)).slice(0, 32)))
  } else {
    // Fallback: convert bigint[] to Uint8Array (first 32 bytes)
    const hexStr = keys.viewingKeyPair.pubkey[0].toString(16).padStart(64, '0')
    viewingPublicKey = ByteUtils.hexToBytes(hexStr)
  }

  const addressData = {
    masterPublicKey: keys.masterPublicKey,
    viewingPublicKey
  }

  return encodeAddress(addressData)
}

/**
 * Compute expected NPK for a given random value
 * This is used to verify shield commitments belong to these keys
 */
export function computeExpectedNPK(masterPublicKey: bigint, random: bigint): bigint {
  // getNotePublicKey expects random as string (hex), convert bigint to hex string
  const randomHex = `0x${random.toString(16)}`
  const npk = ShieldNote.getNotePublicKey(masterPublicKey, randomHex)
  return typeof npk === 'bigint' ? npk : BigInt(npk)
}
