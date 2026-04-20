/**
 * Client-Side Unshield Operations
 *
 * Generates ZK proofs ENTIRELY in the browser.
 * Spending keys NEVER leave the browser.
 *
 * Flow:
 * 1. User signs message → derive keys locally
 * 2. Fetch UTXOs from API (no keys sent)
 * 3. Generate ZK proof with snarkjs (client-side)
 * 4. User signs and sends transaction
 *
 * First-time users: 25-60 seconds (artifact download + proof)
 * Returning users: 5-15 seconds (proof only, artifacts cached)
 */

import { ethers } from 'ethers'
import type { Signer } from 'ethers'
import type { SupportedToken } from './local-config'
import { getTokenAddress, getTokenDecimals } from './tokens'
import { getDefaultChainId } from '../../config/chains'
import { getCachedSignature } from './signature-cache'
// Import from main package where available
import { ByteUtils, ByteLength } from '@railgun-community/engine'
// Import from subpaths (pnpm.packageExtensions in package.json extends exports)
import { poseidonHex } from '@railgun-community/engine/dist/utils/poseidon'
// Import local modules
import { deriveRailgunKeys } from './key-derivation'
import { fetchSpendableUTXOs, selectUTXOsForAmount, getSpendableBalance } from './utxo-fetcher'
import { buildUnshieldProofInputs, buildPartialUnshieldProofInputs, verifyMerkleProof, type ChangeNoteInfo } from './proof-inputs'
import { generateProofClientSide } from './prover'
import { buildUnshieldTransaction } from './transaction-formatter'
import { createChangeNoteCommitmentCiphertext, formatNoteRandomForEncryption } from './note-encryption'
import { storeChangeNote } from './change-note-store'

export interface UnshieldOptions {
  amount: string // Human-readable amount (e.g., "10.50")
  token: SupportedToken
  recipientAddress: string // Incognito wallet address
  signer: Signer
  network?: 'mainnet' | 'testnet'
  chainId?: number
  onProgress?: (progress: number, status: string) => void
}

export interface UnshieldResult {
  hash: string
  hashes?: string[]
  amount: string
  to: string
  totalReceiveAmountWei?: string
}

/**
 * Unshield tokens from Railgun to incognito wallet
 *
 * TRUE CLIENT-SIDE IMPLEMENTATION:
 * - Keys derived locally from signature
 * - UTXOs fetched from indexed API (no keys sent)
 * - ZK proof generated with snarkjs in browser
 * - Spending keys NEVER leave the browser
 *
 * @param options - Unshield configuration
 * @returns Transaction result
 */
export async function unshieldTokens(options: UnshieldOptions): Promise<UnshieldResult> {
  const {
    amount,
    token,
    recipientAddress,
    signer,
    network = 'mainnet',
    onProgress = () => {}
  } = options

  const signerAddress = await signer.getAddress()
  const provider = signer.provider
  if (!provider) {
    throw new Error('Signer must have a provider')
  }

  const chainId = options.chainId || getDefaultChainId()
  const tokenAddress = getTokenAddress(network, token, chainId)
  const tokenDecimals = getTokenDecimals(network, token, chainId)
  const amountWei = ethers.parseUnits(amount, tokenDecimals)

  // Step 1: Get signature (cached 24h)
  onProgress(0, 'Requesting signature...')
  const signature = await getCachedSignature(signer)

  // Step 2: Derive keys from signature (all client-side)
  onProgress(5, 'Deriving Railgun keys...')
  const keys = await deriveRailgunKeys(signature)

  // Step 3: Fetch spendable UTXOs from API (no spending keys sent)
  onProgress(10, 'Fetching shielded tokens...')
  const utxos = await fetchSpendableUTXOs(
    signerAddress,
    keys.viewingKeyPair.privateKey,
    keys.masterPublicKey,
    keys.nullifyingKey,
    tokenAddress,
    chainId
  )

  if (utxos.length === 0) {
    throw new Error('No spendable shielded tokens found')
  }

  // Check balance
  const balance = getSpendableBalance(utxos, tokenAddress)
  if (balance < amountWei) {
    throw new Error(`Insufficient shielded balance. Have ${ethers.formatUnits(balance, tokenDecimals)}, need ${amount}`)
  }

  // Select UTXOs to cover amount
  const selectedUTXOs = selectUTXOsForAmount(utxos, amountWei, tokenAddress)

  onProgress(15, `Found ${selectedUTXOs.length} UTXO(s) to unshield...`)

  // For now, handle single UTXO (most common case)
  // Multi-UTXO batching can be added later
  if (selectedUTXOs.length > 1) {
    // Multiple UTXOs selected, using first one. Full batch support coming soon.
  }

  const utxo = selectedUTXOs[0]

  // Step 4: Build proof inputs
  onProgress(20, 'Building proof inputs...')

  // CRITICAL: Use the token address from the commitment, not the passed-in parameter
  const commitmentTokenAddress = utxo.commitment.tokenAddress.toLowerCase()

  const commitment = ByteUtils.hexToBigInt(
    poseidonHex([
      ByteUtils.nToHex(utxo.note.notePublicKey, ByteLength.UINT_256),
      commitmentTokenAddress,
      ByteUtils.nToHex(utxo.note.value, ByteLength.UINT_256)
    ])
  )

  const proofValid = verifyMerkleProof(commitment, utxo.merkleProof)
  if (!proofValid) {
    throw new Error('Merkle proof verification failed')
  }

  // CRITICAL: For the circuit, unshieldAmount must be the FULL UTXO value.
  // The circuit requires valueIn[0] == valueOut[0] for unshield operations.
  // The smart contract will deduct fees and send the remainder to the recipient.
  const unshieldAmount = utxo.note.value

  const { privateInputs, publicInputs } = buildUnshieldProofInputs({
    utxo,
    nullifyingKey: keys.nullifyingKey,
    spendingKeyPair: keys.spendingKeyPair,
    unshieldAmount,
    recipientAddress,
    tokenAddress
  })

  // Step 5: Generate ZK proof (client-side with snarkjs)
  onProgress(30, 'Generating zero-knowledge proof...')
  const proofResult = await generateProofClientSide({
    privateInputs,
    publicInputs,
    spendingPrivateKey: keys.spendingKeyPair.privateKey,
    chainId,
    treeNumber: utxo.tree,
    onProgress: (progress, status) => {
      // Map prover progress (5-95) to our range (30-85)
      const mappedProgress = 30 + ((progress - 5) / 90) * 55
      onProgress(mappedProgress, status)
    }
  })

  // Step 6: Format transaction
  onProgress(85, 'Creating transaction...')
  const tx = buildUnshieldTransaction({
    proofResult,
    treeNumber: utxo.tree,
    tokenAddress,
    recipientAddress,
    unshieldAmount,
    chainId
  })

  // Step 7: Send transaction - let wallet estimate gas automatically
  onProgress(90, 'Sending transaction...')

  const txResponse = await signer.sendTransaction({
    to: tx.to,
    data: tx.data
    // No gasLimit/gasPrice - wallet estimates automatically
  })

  onProgress(95, 'Waiting for confirmation...')
  const receipt = await txResponse.wait()

  onProgress(100, 'Complete!')

  // Note: The actual receive amount will be less than unshieldAmount due to contract fees.
  // The contract deducts fees and sends the remainder to the recipient.
  // For exact receive amount, fee calculation would be needed (see facilitator implementation).
  return {
    hash: receipt?.hash || txResponse.hash,
    hashes: [utxo.nullifier],
    amount, // Requested amount (for user display)
    to: recipientAddress,
    totalReceiveAmountWei: unshieldAmount.toString() // Full UTXO value unshielded (before fees)
  }
}

/**
 * Options for partial unshield
 */
export interface PartialUnshieldOptions {
  amount: string              // Human-readable amount to unshield (e.g., "1.00")
  token: SupportedToken
  recipientAddress: string    // Incognito wallet address
  signer: Signer
  network?: 'mainnet' | 'testnet'
  chainId?: number
  onProgress?: (progress: number, status: string) => void
}

/**
 * Result of partial unshield including change note info
 */
export interface PartialUnshieldResult {
  hash: string
  unshieldedAmount: string    // What user receives (before fees)
  changeNote: ChangeNoteInfo  // NEW UTXO created with remaining balance
}

/**
 * Generate cryptographically secure random bigint (16 bytes / 128 bits)
 * Uses Web Crypto API for security
 *
 * Note: Railgun uses 16-byte randoms for note encryption.
 * This must match the size used in note-encryption.ts for consistency.
 */
function generateSecureRandom(): bigint {
  const randomBytes = new Uint8Array(16)  // 16 bytes = 128 bits (Railgun standard)
  crypto.getRandomValues(randomBytes)
  return ByteUtils.hexToBigInt('0x' + Buffer.from(randomBytes).toString('hex'))
}

/**
 * Partial unshield - unshield a specific amount and keep the rest shielded
 *
 * Uses 01x02 circuit (1 input, 2 outputs):
 * - Output 1: Unshield amount → sent to recipient
 * - Output 2: Change → new shielded UTXO back to self
 *
 * @param options - Partial unshield configuration
 * @returns Transaction result with change note info
 */
export async function partialUnshieldTokens(options: PartialUnshieldOptions): Promise<PartialUnshieldResult> {
  const {
    amount,
    token,
    recipientAddress,
    signer,
    network = 'mainnet',
    onProgress = () => {}
  } = options

  const signerAddress = await signer.getAddress()
  const provider = signer.provider
  if (!provider) {
    throw new Error('Signer must have a provider')
  }

  const chainId = options.chainId || getDefaultChainId()
  const tokenAddress = getTokenAddress(network, token, chainId)
  const tokenDecimals = getTokenDecimals(network, token, chainId)
  const requestedAmountWei = ethers.parseUnits(amount, tokenDecimals)

  // Step 1: Get signature (cached 24h)
  onProgress(0, 'Requesting signature...')
  const signature = await getCachedSignature(signer)

  // Step 2: Derive keys from signature (all client-side)
  onProgress(5, 'Deriving Railgun keys...')
  const keys = await deriveRailgunKeys(signature)

  // Step 3: Fetch spendable UTXOs from API
  onProgress(10, 'Fetching shielded tokens...')
  const utxos = await fetchSpendableUTXOs(
    signerAddress,
    keys.viewingKeyPair.privateKey,
    keys.masterPublicKey,
    keys.nullifyingKey,
    tokenAddress,
    chainId
  )

  if (utxos.length === 0) {
    throw new Error('No spendable shielded tokens found')
  }

  // Check balance
  const balance = getSpendableBalance(utxos, tokenAddress)
  if (balance < requestedAmountWei) {
    throw new Error(`Insufficient shielded balance. Have ${ethers.formatUnits(balance, tokenDecimals)}, need ${amount}`)
  }

  // Find a single UTXO that can cover the requested amount
  // For partial unshield, we need one UTXO with value > requestedAmount
  const suitableUTXO = utxos.find(u => u.note.value >= requestedAmountWei)

  if (!suitableUTXO) {
    throw new Error(`No single UTXO large enough. Largest UTXO is ${ethers.formatUnits(
      Math.max(...utxos.map(u => Number(u.note.value))),
      18
    )}. Consider using full unshield instead.`)
  }

  const utxo = suitableUTXO
  const utxoValue = utxo.note.value
  const changeAmount = utxoValue - requestedAmountWei

  // Debug logging to understand the values

  // If change is 0, use regular full unshield instead
  if (changeAmount === BigInt(0)) {
    onProgress(15, 'No change needed, using full unshield...')
    const result = await unshieldTokens(options)
    return {
      hash: result.hash,
      unshieldedAmount: amount,
      changeNote: {
        commitment: '0x0',
        value: BigInt(0),
        random: BigInt(0),
        npk: BigInt(0),
        tokenAddress
      }
    }
  }

  onProgress(15, `Partial unshield: ${amount} of ${ethers.formatUnits(utxoValue, tokenDecimals)}...`)

  // Step 4: Build proof inputs with 2 outputs
  onProgress(20, 'Building proof inputs for partial unshield...')

  // Verify merkle proof first
  const commitmentTokenAddress = utxo.commitment.tokenAddress.toLowerCase()
  const commitment = ByteUtils.hexToBigInt(
    poseidonHex([
      ByteUtils.nToHex(utxo.note.notePublicKey, ByteLength.UINT_256),
      commitmentTokenAddress,
      ByteUtils.nToHex(utxo.note.value, ByteLength.UINT_256)
    ])
  )

  const proofValid = verifyMerkleProof(commitment, utxo.merkleProof)
  if (!proofValid) {
    throw new Error('Merkle proof verification failed')
  }

  // Generate random for change note
  const changeRandom = generateSecureRandom()

  const { privateInputs, publicInputs, changeNote } = buildPartialUnshieldProofInputs({
    utxo,
    nullifyingKey: keys.nullifyingKey,
    spendingKeyPair: keys.spendingKeyPair,
    unshieldAmount: requestedAmountWei,
    changeAmount,
    recipientAddress,
    changeMasterPublicKey: keys.masterPublicKey,
    changeRandom,
    tokenAddress
  })

  // Step 4b: Generate commitmentCiphertext for the change note
  // This encrypts the change note so the sender can rediscover it later
  onProgress(25, 'Encrypting change note...')

  // Get the token hash for the change note (same format as used in commitments)
  // For ERC20, tokenHash is just the padded token address
  const tokenHash = ByteUtils.formatToByteLength(commitmentTokenAddress, ByteLength.UINT_256, false)

  // Format the random for encryption (16 bytes from the bigint)
  const changeNoteRandom = formatNoteRandomForEncryption(changeRandom)

  // Generate the encrypted ciphertext for the change note
  const commitmentCiphertext = await createChangeNoteCommitmentCiphertext(
    changeNoteRandom,
    changeAmount,
    tokenHash,
    keys.masterPublicKey,
    keys.viewingKeyPair
  )

  // Step 5: Generate ZK proof with 01x02 circuit (2 outputs)
  onProgress(30, 'Generating zero-knowledge proof (01x02 circuit)...')
  const proofResult = await generateProofClientSide({
    privateInputs,
    publicInputs,
    spendingPrivateKey: keys.spendingKeyPair.privateKey,
    chainId,
    treeNumber: utxo.tree,
    outputCount: 2, // Use 01x02 circuit for partial unshield
    commitmentCiphertext, // Include encrypted change note
    onProgress: (progress, status) => {
      const mappedProgress = 30 + ((progress - 5) / 90) * 55
      onProgress(mappedProgress, status)
    }
  })

  // Step 6: Format transaction
  onProgress(85, 'Creating transaction...')
  const tx = buildUnshieldTransaction({
    proofResult,
    treeNumber: utxo.tree,
    tokenAddress,
    recipientAddress,
    unshieldAmount: requestedAmountWei, // Only the unshield amount, not change
    chainId
  })

  // Step 7: Send transaction
  onProgress(90, 'Sending transaction...')

  const txResponse = await signer.sendTransaction({
    to: tx.to,
    data: tx.data
  })

  onProgress(95, 'Waiting for confirmation...')
  const receipt = await txResponse.wait()

  onProgress(100, 'Complete!')

  const finalTxHash = receipt?.hash || txResponse.hash


  // Extract position from the Transact event in the receipt
  // This allows us to avoid calling the backend to look up the commitment position
  let changeNotePosition: string | undefined
  let changeNoteTreeNumber: string | undefined

  if (receipt?.logs) {
    // Transact event signature: Transact(uint256,uint256,bytes32[],(bytes32[4],bytes32,bytes32,bytes,bytes)[])
    // Topic0 = keccak256 of the event signature
    const TRANSACT_EVENT_TOPIC = '0x56a618cda1e34057b7f849a5792f6c8587a2dbe11c83d0254e72cb3daffda7d1'

    for (const log of receipt.logs) {
      if (log.topics[0] === TRANSACT_EVENT_TOPIC) {
        // Transact event params are NOT indexed — decode from log.data, not topics
        // data layout: [uint256 treeNumber][uint256 startPosition][...]
        const treeNumber = BigInt('0x' + log.data.slice(2, 66)).toString()
        const startPosition = BigInt('0x' + log.data.slice(66, 130))

        // The unshield output doesn't go into the tree, only the change note does
        // So the change note position is just startPosition
        const changePosition = startPosition.toString()

        changeNotePosition = changePosition
        changeNoteTreeNumber = treeNumber

        break
      }
    }
  }

  // Store the change note for later discovery
  // This allows us to track the change note without needing to decrypt blockchain events
  // Including position from receipt avoids needing to call backend
  storeChangeNote(signerAddress, {
    txHash: finalTxHash,
    commitmentHash: changeNote.commitment,
    value: changeNote.value.toString(),
    random: changeNote.random.toString(),
    npk: changeNote.npk.toString(),
    tokenAddress,
    signerAddress,
    createdAt: Date.now(),
    position: changeNotePosition,
    treeNumber: changeNoteTreeNumber
  })

  return {
    hash: finalTxHash,
    unshieldedAmount: amount,
    changeNote
  }
}

// NOTE: unshieldChangeNote() was removed.
// After transact, we simply wait for the change note to be indexed, then call
// the existing unshieldTokens() which will fetch the new change note UTXO.
// This is simpler and reuses existing code.
