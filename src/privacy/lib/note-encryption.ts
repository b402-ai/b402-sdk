/**
 * Note Encryption Module
 *
 * Implements AES-256-GCM encryption for Railgun transaction notes.
 * This is used to encrypt the change note in partial unshield transactions.
 *
 * For partial unshield (01x02 circuit):
 * - Output 1: Unshield (no ciphertext needed - recipient is public address)
 * - Output 2: Change note (requires commitmentCiphertext for receiver to decrypt)
 *
 * The commitmentCiphertext allows the receiver (self in case of change) to:
 * 1. Discover the note when scanning the blockchain
 * 2. Decrypt the note details (value, token, random)
 * 3. Spend the note in future transactions
 */

import { ByteUtils, ByteLength } from '@railgun-community/engine'
import { getPublicViewingKey, getSharedSymmetricKey, getNoteBlindingKeys } from '@railgun-community/engine/dist/utils/keys-utils'
import { AES } from '@railgun-community/engine/dist/utils/encryption/aes'
import { poseidonHex } from '@railgun-community/engine/dist/utils/poseidon'
import type { ViewingKeyPair } from './key-derivation'

/**
 * Output type enum (matches @railgun-community/engine)
 */
export enum OutputType {
  Transfer = 0,
  BroadcasterFee = 1,
  Change = 2
}

/**
 * Wallet source identifier
 * This is used to identify which wallet created the note (for analytics/debugging)
 */
const WALLET_SOURCE = 'b402' // 4 characters, will be padded to 16 bytes

/**
 * Structure for the commitment ciphertext that goes into boundParams
 * This matches the Solidity struct in the Railgun contract
 */
export interface CommitmentCiphertext {
  ciphertext: [string, string, string, string]  // [iv+tag, data0, data1, data2]
  blindedSenderViewingKey: string               // bytes32
  blindedReceiverViewingKey: string             // bytes32
  annotationData: string                        // bytes - encrypted metadata
  memo: string                                  // bytes - encrypted memo text
}

/**
 * Parameters for encrypting a change note
 */
export interface EncryptChangeNoteParams {
  // Note details
  noteRandom: string           // 16 bytes hex (32 chars without 0x)
  noteValue: bigint            // Value in wei
  tokenHash: string            // Token hash (32 bytes)

  // Keys for encryption
  senderMasterPublicKey: bigint       // Sender's master public key
  receiverMasterPublicKey: bigint     // Receiver's master public key (same as sender for self-transfer)
  senderViewingPrivateKey: Uint8Array // Sender's viewing private key
  receiverViewingPublicKey: Uint8Array // Receiver's viewing public key

  // Optional
  memoText?: string            // Optional memo text
}

/**
 * Generate a random sender random value (15 bytes)
 * This is used for blinding the sender address
 */
export function generateSenderRandom(): string {
  const randomBytes = new Uint8Array(15)
  crypto.getRandomValues(randomBytes)
  return ByteUtils.fastBytesToHex(randomBytes)
}

/**
 * Generate a random note random value (16 bytes)
 */
export function generateNoteRandom(): string {
  const randomBytes = new Uint8Array(16)
  crypto.getRandomValues(randomBytes)
  return ByteUtils.fastBytesToHex(randomBytes)
}

/**
 * Encode wallet source to 16 bytes hex
 */
function encodeWalletSource(walletSource: string): string {
  // Encode as UTF-8 and pad to 16 bytes
  const encoder = new TextEncoder()
  const encoded = encoder.encode(walletSource)
  const padded = new Uint8Array(16)
  padded.set(encoded.slice(0, 16))
  return ByteUtils.fastBytesToHex(padded)
}

/**
 * Create encrypted note annotation data (V2 format)
 *
 * Structure:
 * - Field 0 (16 bytes): outputType (1 byte) + senderRandom (15 bytes)
 * - Field 1 (16 bytes): zeroes (padding)
 * - Field 2 (16 bytes): wallet source (encoded)
 *
 * Encrypted with AES-256-CTR using viewingPrivateKey
 */
function createEncryptedAnnotationData(
  outputType: OutputType,
  senderRandom: string,
  walletSource: string,
  viewingPrivateKey: Uint8Array
): string {
  // Field 0: outputType (1 byte) + senderRandom (15 bytes) = 16 bytes
  const outputTypeHex = ByteUtils.nToHex(BigInt(outputType), ByteLength.UINT_8) // 2 chars
  const senderRandomFormatted = senderRandom // Should be 30 chars (15 bytes)
  const metadataField0 = `${outputTypeHex}${senderRandomFormatted}`

  if (metadataField0.length !== 32) {
    throw new Error(`Metadata field 0 must be 16 bytes (32 hex chars). Got ${metadataField0.length}`)
  }

  // Field 1: 16 bytes of zeros
  const metadataField1 = '0'.repeat(32)

  // Field 2: wallet source, padded to 16 bytes
  let metadataField2 = encodeWalletSource(walletSource)
  while (metadataField2.length < 32) {
    metadataField2 = `0${metadataField2}`
  }

  // Encrypt with AES-256-CTR (same as Railgun engine does)
  const toEncrypt = [metadataField0, metadataField1, metadataField2]
  const metadataCiphertext = encryptCTR(toEncrypt, viewingPrivateKey)

  // Return: IV + encrypted data (3 blocks)
  return metadataCiphertext.iv +
         metadataCiphertext.data[0] +
         metadataCiphertext.data[1] +
         metadataCiphertext.data[2]
}

/**
 * CTR encryption using the engine's AES implementation
 * Works in both Node.js and browser environments
 */
function encryptCTR(
  plaintext: string[],
  key: Uint8Array
): { iv: string; data: string[] } {
  // Use the engine's AES implementation which handles both Node.js and browser
  return AES.encryptCTR(plaintext, key)
}

/**
 * Encode master public key for ciphertext
 *
 * For self-transfer (change note), the receiver is the same as sender.
 * When sender wants to hide their address from receiver, we use unencoded MPK.
 * When sender wants to be visible, we XOR sender and receiver MPK.
 *
 * For change notes (self-transfer with hidden sender):
 * - senderRandom is set (not null)
 * - Return unencoded receiverMasterPublicKey
 */
function getEncodedMasterPublicKey(
  senderRandom: string | undefined,
  receiverMasterPublicKey: bigint,
  senderMasterPublicKey: bigint
): bigint {
  const MEMO_SENDER_RANDOM_NULL = '0'.repeat(30) // 15 bytes of zeros

  // If senderRandom is set and not null, return unencoded (hide sender)
  if (senderRandom && senderRandom !== MEMO_SENDER_RANDOM_NULL) {
    return receiverMasterPublicKey // Unencoded
  }

  // Otherwise, XOR to encode (show sender)
  return receiverMasterPublicKey ^ senderMasterPublicKey
}

/**
 * Encode memo text to hex
 */
function encodeMemoText(memoText?: string): string {
  if (!memoText) {
    return ''
  }
  const encoder = new TextEncoder()
  const encoded = encoder.encode(memoText)
  return ByteUtils.fastBytesToHex(encoded)
}

/**
 * Encrypt a change note for a partial unshield transaction
 *
 * This creates the commitmentCiphertext structure needed for the change note.
 * The encryption uses:
 * 1. Blinded viewing keys (for key agreement)
 * 2. ECDH shared secret (for AES key derivation)
 * 3. AES-256-GCM encryption (for the note data)
 *
 * @param params - Encryption parameters
 * @returns CommitmentCiphertext ready for boundParams
 */
export async function encryptChangeNote(
  params: EncryptChangeNoteParams
): Promise<CommitmentCiphertext> {
  const {
    noteRandom,
    noteValue,
    tokenHash,
    senderMasterPublicKey,
    receiverMasterPublicKey,
    senderViewingPrivateKey,
    receiverViewingPublicKey,
    memoText
  } = params

  // Generate sender random for blinding (15 bytes = 30 hex chars)
  // For change notes, we always hide the sender address
  const senderRandom = generateSenderRandom()

  // Get blinded viewing keys
  // sharedRandom = noteRandom (used for ECDH)
  // senderRandom = for additional blinding
  const { blindedSenderViewingKey, blindedReceiverViewingKey } = getNoteBlindingKeys(
    await getPublicViewingKey(senderViewingPrivateKey),
    receiverViewingPublicKey,
    noteRandom,
    senderRandom
  )

  // Calculate shared symmetric key using ECDH
  // sharedKey = SHA256(senderPrivateKey * blindedReceiverViewingKey)
  const sharedKey = await getSharedSymmetricKey(
    senderViewingPrivateKey,
    blindedReceiverViewingKey
  )

  if (!sharedKey) {
    throw new Error('Failed to compute shared symmetric key')
  }

  // Prepare note data for encryption
  // Format: [encodedMPK, tokenHash, random+value, encodedMemoText]
  const encodedMasterPublicKey = getEncodedMasterPublicKey(
    senderRandom,
    receiverMasterPublicKey,
    senderMasterPublicKey
  )

  // Format values for encryption
  const encodedMPKHex = ByteUtils.nToHex(encodedMasterPublicKey, ByteLength.UINT_256)
  const tokenHashFormatted = ByteUtils.formatToByteLength(tokenHash, ByteLength.UINT_256, false)
  const randomFormatted = ByteUtils.formatToByteLength(noteRandom, ByteLength.UINT_128, false)
  const valueFormatted = ByteUtils.nToHex(noteValue, ByteLength.UINT_128)
  const randomValueCombined = `${randomFormatted}${valueFormatted}`
  const encodedMemoHex = encodeMemoText(memoText)

  // Encrypt with AES-256-GCM
  // Data blocks: [encodedMPK, tokenHash, random+value, encodedMemo]
  const plaintextBlocks = [
    encodedMPKHex,
    tokenHashFormatted,
    randomValueCombined,
    encodedMemoHex || '00' // At least 1 byte if no memo
  ]

  const noteCiphertext = AES.encryptGCM(plaintextBlocks, sharedKey)

  if (noteCiphertext.data.length < 3) {
    throw new Error('Note ciphertext data must have at least 3 blocks')
  }

  // Format ciphertext for contract
  // ciphertext[0] = IV (16 bytes) + Tag (16 bytes) = 32 bytes
  // ciphertext[1-3] = encrypted data blocks
  const ivTagCombined = `${noteCiphertext.iv}${noteCiphertext.tag}`

  const ciphertext: [string, string, string, string] = [
    ByteUtils.hexlify(ivTagCombined, true),        // IV + Tag
    ByteUtils.hexlify(noteCiphertext.data[0], true), // Encrypted MPK
    ByteUtils.hexlify(noteCiphertext.data[1], true), // Encrypted tokenHash
    ByteUtils.hexlify(noteCiphertext.data[2], true)  // Encrypted random+value
  ]

  // Create annotation data (encrypted metadata about the note)
  const annotationData = createEncryptedAnnotationData(
    OutputType.Change,
    senderRandom,
    WALLET_SOURCE,
    senderViewingPrivateKey
  )

  // Extract memo from ciphertext if present
  const memo = noteCiphertext.data.length > 3
    ? ByteUtils.hexlify(noteCiphertext.data[3], true)
    : '0x'

  const result = {
    ciphertext,
    blindedSenderViewingKey: ByteUtils.hexlify(blindedSenderViewingKey, true),
    blindedReceiverViewingKey: ByteUtils.hexlify(blindedReceiverViewingKey, true),
    annotationData: ByteUtils.hexlify(annotationData, true),
    memo
  }

  return result
}

/**
 * Create commitmentCiphertext for a change note in partial unshield
 *
 * This is a simplified version that uses the same wallet for sender and receiver
 * (since the change goes back to self).
 *
 * @param changeNoteRandom - Random value for the change note (16 bytes hex)
 * @param changeNoteValue - Value of the change note in wei
 * @param tokenHash - Token hash (32 bytes)
 * @param masterPublicKey - User's master public key
 * @param viewingKeyPair - User's viewing key pair
 * @returns Array with single CommitmentCiphertext for the change note
 */
export async function createChangeNoteCommitmentCiphertext(
  changeNoteRandom: string,
  changeNoteValue: bigint,
  tokenHash: string,
  masterPublicKey: bigint,
  viewingKeyPair: ViewingKeyPair
): Promise<CommitmentCiphertext[]> {
  // For self-transfer, sender == receiver
  const receiverViewingPublicKey = await getPublicViewingKey(viewingKeyPair.privateKey)

  const commitmentCiphertext = await encryptChangeNote({
    noteRandom: changeNoteRandom,
    noteValue: changeNoteValue,
    tokenHash,
    senderMasterPublicKey: masterPublicKey,
    receiverMasterPublicKey: masterPublicKey,
    senderViewingPrivateKey: viewingKeyPair.privateKey,
    receiverViewingPublicKey
  })

  // Return as array (contract expects array of ciphertexts)
  // For partial unshield, we only have 1 change note
  return [commitmentCiphertext]
}

/**
 * Format a random bigint value as a 16-byte hex string for note encryption
 *
 * The change note random used in the commitment should match the random
 * used for encryption. The random is stored as a bigint but needs to be
 * formatted as a 16-byte hex string (32 chars without 0x prefix) for encryption.
 *
 * @param random - The random value as bigint (e.g., from generateSecureRandom())
 * @returns 16-byte hex string (32 chars) without 0x prefix
 */
export function formatNoteRandomForEncryption(random: bigint): string {
  // Convert bigint to hex and ensure it's 32 chars (16 bytes)
  // Railgun uses 16-byte random values for notes
  const hex = random.toString(16).padStart(32, '0')

  // Take the last 32 chars (16 bytes) in case the bigint is larger
  // This matches how ByteUtils.formatToByteLength works
  return hex.slice(-32)
}

/**
 * Generate a secure 16-byte random value as a hex string
 * This matches the format expected by TransactNote
 */
export function generateNoteRandomHex(): string {
  const randomBytes = new Uint8Array(16)
  crypto.getRandomValues(randomBytes)
  return ByteUtils.fastBytesToHex(randomBytes)
}

/**
 * Decrypted change note data
 */
export interface DecryptedChangeNote {
  masterPublicKey: bigint  // Encoded MPK from the note
  tokenHash: string        // Token hash (32 bytes hex)
  random: bigint           // Note random value
  value: bigint            // Note value in wei
}

/**
 * Decrypt a change note from its ciphertext
 *
 * This reverses the encryption done by encryptChangeNote().
 * Used to discover change notes from partial unshield transactions.
 *
 * Like Railgun engine, we try BOTH blinded keys:
 * - blindedSenderViewingKey: for notes we're receiving
 * - blindedReceiverViewingKey: for notes we sent (to track our own sends)
 *
 * @param ciphertext - The 4 ciphertext fields [iv+tag, data0, data1, data2]
 * @param blindedSenderViewingKey - The blinded SENDER viewing key
 * @param viewingPrivateKey - Our viewing private key
 * @param blindedReceiverViewingKey - Optional blinded RECEIVER viewing key (try both)
 * @param memo - The memo field from the event (4th encrypted block). AES-GCM tag
 *               covers all 4 encrypted blocks, so this MUST be included for decryption.
 * @returns Decrypted note data or null if decryption fails
 */
export async function decryptChangeNote(
  ciphertext: [string, string, string, string],
  blindedSenderViewingKey: string,
  viewingPrivateKey: Uint8Array,
  blindedReceiverViewingKey?: string,
  memo?: string
): Promise<DecryptedChangeNote | null> {
  // Try both blinded keys like Railgun engine does
  // 1. First try as receiver (using blindedSenderViewingKey)
  // 2. Then try as sender (using blindedReceiverViewingKey)
  const keysToTry: string[] = [blindedSenderViewingKey]
  if (blindedReceiverViewingKey) {
    keysToTry.push(blindedReceiverViewingKey)
  }

  for (const key of keysToTry) {
    const result = await tryDecryptWithKey(ciphertext, key, viewingPrivateKey, memo)
    if (result) {
      return result
    }
  }

  return null
}

async function tryDecryptWithKey(
  ciphertext: [string, string, string, string],
  blindedKey: string,
  viewingPrivateKey: Uint8Array,
  memo?: string
): Promise<DecryptedChangeNote | null> {
  try {
    // Dynamic import to avoid SSR issues
    const { AES } = await import('@railgun-community/engine/dist/utils/encryption/aes')

    // Get shared key using ECDH - strip 0x prefix if present
    const blindedKeyClean = blindedKey.startsWith('0x') ? blindedKey.slice(2) : blindedKey

    const blindedKeyBytes = ByteUtils.hexToBytes(blindedKeyClean)

    const sharedKey = await getSharedSymmetricKey(viewingPrivateKey, blindedKeyBytes)

    if (!sharedKey) {
      return null
    }

    // Parse ciphertext - strip 0x prefix if present
    const c0 = ciphertext[0].startsWith('0x') ? ciphertext[0].slice(2) : ciphertext[0]
    const c1 = ciphertext[1].startsWith('0x') ? ciphertext[1].slice(2) : ciphertext[1]
    const c2 = ciphertext[2].startsWith('0x') ? ciphertext[2].slice(2) : ciphertext[2]
    const c3 = ciphertext[3].startsWith('0x') ? ciphertext[3].slice(2) : ciphertext[3]

    // ciphertext[0] = IV (16 bytes) + Tag (16 bytes) = 32 bytes = 64 hex chars
    const iv = c0.slice(0, 32)   // 16 bytes = 32 hex chars
    const tag = c0.slice(32, 64) // 16 bytes = 32 hex chars

    // Include memo as 4th data block — AES-GCM tag covers all encrypted blocks
    const memoClean = memo ? (memo.startsWith('0x') ? memo.slice(2) : memo) : undefined
    const encryptedData = memoClean ? [c1, c2, c3, memoClean] : [c1, c2, c3]

    // Decrypt with AES-GCM
    const decrypted = AES.decryptGCM({ iv, tag, data: encryptedData }, sharedKey)

    if (!decrypted || decrypted.length < 3) {
      return null
    }

    // Parse decrypted data
    // decrypted[0] = encoded MPK (32 bytes)
    // decrypted[1] = token hash (32 bytes)
    // decrypted[2] = random (16 bytes) + value (16 bytes)
    // AES.decryptGCM returns hex strings
    const mpkHex = String(decrypted[0])
    const tokenHashHex = String(decrypted[1])
    const randomValueHex = String(decrypted[2])

    const masterPublicKey = ByteUtils.hexToBigInt(mpkHex)
    const tokenHash = tokenHashHex

    // Split random+value (each is 16 bytes = 32 hex chars)
    const randomHex = randomValueHex.slice(0, 32)
    const valueHex = randomValueHex.slice(32, 64)

    const random = ByteUtils.hexToBigInt(randomHex)
    const value = ByteUtils.hexToBigInt(valueHex)

    return {
      masterPublicKey,
      tokenHash,
      random,
      value
    }
  } catch {
    return null
  }
}
