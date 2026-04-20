/**
 * Proof Inputs Builder
 *
 * Builds the private and public inputs for the ZK circuit.
 */

import type { SpendableUTXO } from './utxo-fetcher'
import type { SpendingKeyPair } from './key-derivation'
import type { MerkleProofResponse } from './types'
// Import from main package where available
import { ByteUtils, ByteLength, TransactNote } from '@railgun-community/engine'
// Import from subpaths (pnpm.packageExtensions in package.json extends exports)
import { poseidon, poseidonHex } from '@railgun-community/engine/dist/utils/poseidon'

export interface PrivateInputsRailgun {
  tokenAddress: bigint
  publicKey: bigint[]
  randomIn: bigint[]
  valueIn: bigint[]
  pathElements: bigint[][]
  leavesIndices: bigint[]
  nullifyingKey: bigint
  npkOut: bigint[]
  valueOut: bigint[]
}

export interface PublicInputsRailgun {
  merkleRoot: bigint
  boundParamsHash: bigint
  nullifiers: bigint[]
  commitmentsOut: bigint[]
}

export interface UnshieldProofInputsParams {
  utxo: SpendableUTXO
  nullifyingKey: bigint
  spendingKeyPair: SpendingKeyPair
  unshieldAmount: bigint
  recipientAddress: string
  tokenAddress: string
}

/**
 * Parameters for partial unshield with change (01x02 circuit)
 */
export interface PartialUnshieldProofInputsParams {
  utxo: SpendableUTXO
  nullifyingKey: bigint
  spendingKeyPair: SpendingKeyPair
  unshieldAmount: bigint        // Amount to unshield to recipient
  changeAmount: bigint          // Amount to keep shielded (new UTXO)
  recipientAddress: string      // Unshield destination (incognito wallet)
  changeMasterPublicKey: bigint // User's master public key for deriving change note
  changeRandom: bigint          // Random value for change note
  tokenAddress: string
}

/**
 * Information about the change note created during partial unshield
 */
export interface ChangeNoteInfo {
  commitment: string      // Commitment hash (hex)
  value: bigint           // Change amount
  random: bigint          // Random value used
  npk: bigint             // Note public key
  tokenAddress: string    // Token address
}

// Railgun merkle tree depth is 16
const MERKLE_TREE_DEPTH = 16

/**
 * Convert API merkle proof format to circuit format
 * Path indices array → single bigint bitfield
 */
function convertMerkleProof(apiProof: MerkleProofResponse): {
  elements: bigint[]
  indices: bigint
} {
  let elements = apiProof.proof.map(p => BigInt(p))

  // Circuit expects exactly 16 path elements
  // Pad with zeros if needed (shouldn't happen with correct API)
  if (elements.length < MERKLE_TREE_DEPTH) {
    console.warn(`[convertMerkleProof] Path elements count ${elements.length} < ${MERKLE_TREE_DEPTH}, padding...`)
    while (elements.length < MERKLE_TREE_DEPTH) {
      elements.push(BigInt(0))
    }
  } else if (elements.length > MERKLE_TREE_DEPTH) {
    console.warn(`[convertMerkleProof] Path elements count ${elements.length} > ${MERKLE_TREE_DEPTH}, truncating...`)
    elements = elements.slice(0, MERKLE_TREE_DEPTH)
  }

  // Convert path indices array [0,1,0,1...] to bitfield
  // Each position where pathIndices[i] === 1 sets bit i
  let indicesBitfield = BigInt(0)
  for (let i = 0; i < Math.min(apiProof.pathIndices.length, MERKLE_TREE_DEPTH); i++) {
    if (apiProof.pathIndices[i] === 1) {
      indicesBitfield |= BigInt(1) << BigInt(i)
    }
  }


  return { elements, indices: indicesBitfield }
}

/**
 * Build proof inputs for unshield transaction
 */
export function buildUnshieldProofInputs(
  params: UnshieldProofInputsParams
): { privateInputs: PrivateInputsRailgun; publicInputs: PublicInputsRailgun } {
  const {
    utxo,
    nullifyingKey,
    spendingKeyPair,
    unshieldAmount,
    recipientAddress,
    tokenAddress
  } = params

  // Convert merkle proof to circuit format
  const { elements: pathElements, indices: leavesIndices } = convertMerkleProof(utxo.merkleProof)

  // CRITICAL: Use the token address from the commitment, not the passed-in parameter
  // The commitment was computed with this exact token address format on-chain
  const commitmentTokenAddress = utxo.commitment.tokenAddress.toLowerCase()

  // Verify input commitment matches what's in the merkle tree
  const inputCommitment = ByteUtils.hexToBigInt(
    poseidonHex([
      ByteUtils.nToHex(utxo.note.notePublicKey, ByteLength.UINT_256),
      commitmentTokenAddress,
      ByteUtils.nToHex(utxo.note.value, ByteLength.UINT_256)
    ])
  )

  const expectedCommitment = utxo.commitment.commitmentHash.toLowerCase()
  const computedCommitment = `0x${inputCommitment.toString(16).padStart(64, '0')}`.toLowerCase()

  if (expectedCommitment !== computedCommitment) {
    console.warn('[Proof Inputs] Commitment mismatch!')
    console.warn('[Proof Inputs] Expected:', expectedCommitment)
    console.warn('[Proof Inputs] Computed:', computedCommitment)
    throw new Error('Input commitment verification failed')
  }

  // Calculate nullifier
  const nullifier = TransactNote.getNullifier(nullifyingKey, utxo.position)

  // Build unshield note (output)
  // For unshield, npk = recipient address (contract casts it to address)
  const unshieldNotePublicKey = BigInt(recipientAddress)


  // Private inputs (witness - kept secret)
  // CRITICAL: Use commitmentTokenAddress to match the commitment hash
  const privateInputs: PrivateInputsRailgun = {
    tokenAddress: ByteUtils.hexToBigInt(commitmentTokenAddress),
    publicKey: spendingKeyPair.pubkey,
    randomIn: [utxo.note.random],
    valueIn: [utxo.note.value],
    pathElements: [pathElements],
    leavesIndices: [leavesIndices],
    nullifyingKey,
    npkOut: [unshieldNotePublicKey],
    valueOut: [unshieldAmount]
  }

  // Calculate output commitment
  // For unshield: commitment = poseidon(npk, token, value)
  // Use same token address format as input for consistency
  const unshieldCommitment = ByteUtils.hexToBigInt(
    poseidonHex([
      ByteUtils.nToHex(unshieldNotePublicKey, ByteLength.UINT_256),
      commitmentTokenAddress,
      ByteUtils.nToHex(unshieldAmount, ByteLength.UINT_256)
    ])
  )

  // Public inputs (circuit outputs)
  const publicInputs: PublicInputsRailgun = {
    merkleRoot: BigInt(utxo.merkleProof.root),
    boundParamsHash: BigInt(0), // Set later by prover
    nullifiers: [nullifier],
    commitmentsOut: [unshieldCommitment]
  }

  return { privateInputs, publicInputs }
}

/**
 * Build proof inputs for partial unshield transaction (01x02 circuit)
 *
 * This creates 2 outputs:
 * 1. Unshield output: tokens sent to recipient address
 * 2. Change output: remaining tokens as a new shielded UTXO back to self
 *
 * @returns Proof inputs + change note info for tracking
 */
export function buildPartialUnshieldProofInputs(
  params: PartialUnshieldProofInputsParams
): {
  privateInputs: PrivateInputsRailgun
  publicInputs: PublicInputsRailgun
  changeNote: ChangeNoteInfo
} {
  const {
    utxo,
    nullifyingKey,
    spendingKeyPair,
    unshieldAmount,
    changeAmount,
    recipientAddress,
    changeMasterPublicKey,
    changeRandom,
    tokenAddress
  } = params

  // Validate: unshieldAmount + changeAmount must equal UTXO value
  if (unshieldAmount + changeAmount !== utxo.note.value) {
    throw new Error(
      `Value mismatch: unshield(${unshieldAmount}) + change(${changeAmount}) != utxo(${utxo.note.value})`
    )
  }

  // Convert merkle proof to circuit format
  const { elements: pathElements, indices: leavesIndices } = convertMerkleProof(utxo.merkleProof)

  // CRITICAL: Use the token address from the commitment
  const commitmentTokenAddress = utxo.commitment.tokenAddress.toLowerCase()

  // Verify input commitment matches what's in the merkle tree
  const inputCommitment = ByteUtils.hexToBigInt(
    poseidonHex([
      ByteUtils.nToHex(utxo.note.notePublicKey, ByteLength.UINT_256),
      commitmentTokenAddress,
      ByteUtils.nToHex(utxo.note.value, ByteLength.UINT_256)
    ])
  )

  const expectedCommitment = utxo.commitment.commitmentHash.toLowerCase()
  const computedCommitment = `0x${inputCommitment.toString(16).padStart(64, '0')}`.toLowerCase()

  if (expectedCommitment !== computedCommitment) {
    console.warn('[Proof Inputs] Commitment mismatch!')
    throw new Error('Input commitment verification failed')
  }

  // Calculate nullifier
  const nullifier = TransactNote.getNullifier(nullifyingKey, utxo.position)

  // Output 1: Unshield note (recipient gets tokens)
  // For unshield, npk = recipient address (contract casts it to address)
  const unshieldNotePublicKey = BigInt(recipientAddress)

  // Output 2: Change note (user keeps shielded)
  // For change, we derive npk from master public key + random
  // Using poseidon(masterPublicKey, random) - same as TransactNote.getNotePublicKey()
  // Note: Must use poseidon() with bigints directly, NOT poseidonHex() with hex strings
  const changeNpk = poseidon([changeMasterPublicKey, changeRandom])

  // Private inputs with 2 outputs
  // CRITICAL: Order matters! Railgun expects:
  // - Output 0: Change note (internal transfer, stays shielded)
  // - Output 1: Unshield note (to recipient address)
  // This matches how Railgun engine builds transactions: tokenOutputs first, then unshieldNote
  const privateInputs: PrivateInputsRailgun = {
    tokenAddress: ByteUtils.hexToBigInt(commitmentTokenAddress),
    publicKey: spendingKeyPair.pubkey,
    randomIn: [utxo.note.random],
    valueIn: [utxo.note.value],
    pathElements: [pathElements],
    leavesIndices: [leavesIndices],
    nullifyingKey,
    npkOut: [changeNpk, unshieldNotePublicKey],     // Change first, then unshield
    valueOut: [changeAmount, unshieldAmount]         // Change first, then unshield
  }

  // Calculate output commitments using poseidonHex() for consistency with full unshield
  // CRITICAL: Must use same format as buildUnshieldProofInputs() - poseidonHex with hex strings
  // This ensures the token address is properly padded to 32 bytes before hashing

  // Output 0: Change commitment (internal transfer, stays shielded)
  const changeCommitment = ByteUtils.hexToBigInt(
    poseidonHex([
      ByteUtils.nToHex(changeNpk, ByteLength.UINT_256),
      commitmentTokenAddress,
      ByteUtils.nToHex(changeAmount, ByteLength.UINT_256)
    ])
  )

  // Output 1: Unshield commitment (same formula as full unshield)
  const unshieldCommitment = ByteUtils.hexToBigInt(
    poseidonHex([
      ByteUtils.nToHex(unshieldNotePublicKey, ByteLength.UINT_256),
      commitmentTokenAddress,
      ByteUtils.nToHex(unshieldAmount, ByteLength.UINT_256)
    ])
  )

  // Public inputs with 2 output commitments
  // CRITICAL: Order must match privateInputs - change first, unshield last
  // The contract validates that commitments[LAST] matches unshieldPreimage
  const publicInputs: PublicInputsRailgun = {
    merkleRoot: BigInt(utxo.merkleProof.root),
    boundParamsHash: BigInt(0), // Set later by prover
    nullifiers: [nullifier],
    commitmentsOut: [changeCommitment, unshieldCommitment]  // Change first, unshield last
  }

  // Return change note info for tracking
  const changeNote: ChangeNoteInfo = {
    commitment: `0x${changeCommitment.toString(16).padStart(64, '0')}`,
    value: changeAmount,
    random: changeRandom,
    npk: changeNpk,
    tokenAddress: commitmentTokenAddress
  }

  return { privateInputs, publicInputs, changeNote }
}

/**
 * Parameters for transact (internal transfer) with 01x02 circuit
 *
 * This creates 2 shielded outputs (NO unshield):
 * - Output 0: Fee note to b402's zk-address
 * - Output 1: User's change note back to self
 *
 * Key difference from partial unshield:
 * - Both outputs stay shielded (no unshieldPreimage.npk set)
 * - Both npkOut values are derived from master public keys
 */
export interface TransactProofInputsParams {
  utxo: SpendableUTXO
  nullifyingKey: bigint
  spendingKeyPair: SpendingKeyPair

  // Fee output (to b402)
  feeAmount: bigint
  feeRecipientMasterPublicKey: bigint
  feeRandom: bigint

  // User change output
  changeAmount: bigint
  userMasterPublicKey: bigint
  changeRandom: bigint

  tokenAddress: string
}

/**
 * Build proof inputs for transact (internal transfer, NO unshield)
 *
 * Uses 01x02 circuit with 2 shielded outputs:
 * - Output 0: Fee note to b402
 * - Output 1: User's change note
 *
 * Unlike partial unshield, NEITHER output leaves Railgun.
 * Both outputs are encrypted notes that go into the merkle tree.
 *
 * @returns Proof inputs + both note infos for tracking
 */
export function buildTransactProofInputs(
  params: TransactProofInputsParams
): {
  privateInputs: PrivateInputsRailgun
  publicInputs: PublicInputsRailgun
  feeNote: ChangeNoteInfo
  changeNote: ChangeNoteInfo
} {
  const {
    utxo,
    nullifyingKey,
    spendingKeyPair,
    feeAmount,
    feeRecipientMasterPublicKey,
    feeRandom,
    changeAmount,
    userMasterPublicKey,
    changeRandom
  } = params

  // Validate: feeAmount + changeAmount must equal UTXO value
  if (feeAmount + changeAmount !== utxo.note.value) {
    throw new Error(
      `Value mismatch: fee(${feeAmount}) + change(${changeAmount}) != utxo(${utxo.note.value})`
    )
  }

  // Convert merkle proof to circuit format
  const { elements: pathElements, indices: leavesIndices } = convertMerkleProof(utxo.merkleProof)

  // CRITICAL: Use the token address from the commitment
  const commitmentTokenAddress = utxo.commitment.tokenAddress.toLowerCase()

  // Verify input commitment matches what's in the merkle tree
  const inputCommitment = ByteUtils.hexToBigInt(
    poseidonHex([
      ByteUtils.nToHex(utxo.note.notePublicKey, ByteLength.UINT_256),
      commitmentTokenAddress,
      ByteUtils.nToHex(utxo.note.value, ByteLength.UINT_256)
    ])
  )

  const expectedCommitment = utxo.commitment.commitmentHash.toLowerCase()
  const computedCommitment = `0x${inputCommitment.toString(16).padStart(64, '0')}`.toLowerCase()

  if (expectedCommitment !== computedCommitment) {
    console.warn('[buildTransactProofInputs] Commitment mismatch!')
    throw new Error('Input commitment verification failed')
  }

  // Calculate nullifier
  const nullifier = TransactNote.getNullifier(nullifyingKey, utxo.position)

  // Output 0: Fee note (to b402's zk-address)
  // Derive npk from b402's master public key + random
  const feeNpk = poseidon([feeRecipientMasterPublicKey, feeRandom])

  // Output 1: Change note (user keeps shielded)
  // Derive npk from user's master public key + random
  const changeNpk = poseidon([userMasterPublicKey, changeRandom])

  // Private inputs with 2 outputs
  // Order: fee first, change second
  const privateInputs: PrivateInputsRailgun = {
    tokenAddress: ByteUtils.hexToBigInt(commitmentTokenAddress),
    publicKey: spendingKeyPair.pubkey,
    randomIn: [utxo.note.random],
    valueIn: [utxo.note.value],
    pathElements: [pathElements],
    leavesIndices: [leavesIndices],
    nullifyingKey,
    npkOut: [feeNpk, changeNpk],         // Fee first, change second
    valueOut: [feeAmount, changeAmount]   // Fee first, change second
  }

  // Calculate output commitments
  // Output 0: Fee commitment
  const feeCommitment = ByteUtils.hexToBigInt(
    poseidonHex([
      ByteUtils.nToHex(feeNpk, ByteLength.UINT_256),
      commitmentTokenAddress,
      ByteUtils.nToHex(feeAmount, ByteLength.UINT_256)
    ])
  )

  // Output 1: Change commitment
  const changeCommitment = ByteUtils.hexToBigInt(
    poseidonHex([
      ByteUtils.nToHex(changeNpk, ByteLength.UINT_256),
      commitmentTokenAddress,
      ByteUtils.nToHex(changeAmount, ByteLength.UINT_256)
    ])
  )

  // Public inputs with 2 output commitments
  const publicInputs: PublicInputsRailgun = {
    merkleRoot: BigInt(utxo.merkleProof.root),
    boundParamsHash: BigInt(0), // Set later by prover
    nullifiers: [nullifier],
    commitmentsOut: [feeCommitment, changeCommitment]  // Fee first, change second
  }

  // Return both note infos for tracking
  const feeNote: ChangeNoteInfo = {
    commitment: `0x${feeCommitment.toString(16).padStart(64, '0')}`,
    value: feeAmount,
    random: feeRandom,
    npk: feeNpk,
    tokenAddress: commitmentTokenAddress
  }

  const changeNote: ChangeNoteInfo = {
    commitment: `0x${changeCommitment.toString(16).padStart(64, '0')}`,
    value: changeAmount,
    random: changeRandom,
    npk: changeNpk,
    tokenAddress: commitmentTokenAddress
  }

  return { privateInputs, publicInputs, feeNote, changeNote }
}

/**
 * Verify merkle proof locally before generating ZK proof
 * This catches issues early and saves proof generation time
 */
export function verifyMerkleProof(
  commitment: bigint,
  merkleProof: MerkleProofResponse
): boolean {
  const pathElements = merkleProof.proof.map(p => BigInt(p))
  let computedHash = commitment

  for (let i = 0; i < pathElements.length; i++) {
    const isRight = merkleProof.pathIndices[i] === 1
    const siblingHash = pathElements[i]

    if (isRight) {
      // Current node is right child, sibling (left) goes first
      computedHash = ByteUtils.hexToBigInt(
        poseidonHex([
          ByteUtils.nToHex(siblingHash, ByteLength.UINT_256),
          ByteUtils.nToHex(computedHash, ByteLength.UINT_256)
        ])
      )
    } else {
      // Current node is left child, sibling (right) goes second
      computedHash = ByteUtils.hexToBigInt(
        poseidonHex([
          ByteUtils.nToHex(computedHash, ByteLength.UINT_256),
          ByteUtils.nToHex(siblingHash, ByteLength.UINT_256)
        ])
      )
    }
  }

  const expectedRoot = BigInt(merkleProof.root)
  return computedHash === expectedRoot
}
