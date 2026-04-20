/**
 * Transact Operations (Internal Railgun Transfer)
 *
 * Creates shielded transfers within Railgun - both outputs stay shielded.
 * Used for fee split: send fee to b402's zk-address, keep rest for user.
 *
 * Flow:
 * 1. User signs message → derive keys locally
 * 2. Fetch UTXOs from API (no keys sent)
 * 3. Generate ZK proof with 01x02 circuit (2 shielded outputs)
 * 4. User signs and sends transaction
 * 5. After tx confirms, call backend /unshield API for user's change
 *
 * Key difference from unshield:
 * - unshieldPreimage.npk = 0 (tells contract this is a pure transact)
 * - Both outputs stay shielded in Railgun merkle tree
 */

import { ethers } from 'ethers'
import type { Signer } from 'ethers'
import type { SupportedToken } from './local-config'
import { PRIVACY_CONFIG } from './local-config'
import { getTokenAddress } from './tokens'
import { getDefaultChainId } from '../../config/chains'
import { getCachedSignature } from './signature-cache'
import { ByteUtils, ByteLength } from '@railgun-community/engine'
import { getPublicViewingKey } from '@railgun-community/engine/dist/utils/keys-utils'
import { deriveRailgunKeys } from './key-derivation'
import { fetchSpendableUTXOs, getSpendableBalance } from './utxo-fetcher'
import { buildTransactProofInputs, verifyMerkleProof, type ChangeNoteInfo } from './proof-inputs'
import { generateProofClientSide } from './prover'
import { buildTransactTransaction } from './transaction-formatter'
import { encryptChangeNote, formatNoteRandomForEncryption } from './note-encryption'
import { storeChangeNote } from './change-note-store'
import { poseidonHex } from '@railgun-community/engine/dist/utils/poseidon'

export interface TransactOptions {
  feePercentage?: number          // Fee percentage (e.g., 1 = 1%), default from config
  token: SupportedToken
  signer: Signer
  network?: 'mainnet' | 'testnet'
  chainId?: number
  onProgress?: (progress: number, status: string) => void
}

export interface TransactResult {
  hash: string
  feeAmount: string              // Amount sent to b402 (wei)
  changeAmount: string           // Amount kept by user (wei)
  changeNote: ChangeNoteInfo     // For user to track/spend later
  feeNote: ChangeNoteInfo        // Fee note (for b402 to spend)
  changeNotePosition: string     // Position in merkle tree (from Transact event)
  changeNoteTreeNumber: string   // Tree number (from Transact event)
}

/**
 * Generate cryptographically secure random bigint (16 bytes / 128 bits)
 */
function generateSecureRandom(): bigint {
  const randomBytes = new Uint8Array(16)
  crypto.getRandomValues(randomBytes)
  return ByteUtils.hexToBigInt('0x' + Buffer.from(randomBytes).toString('hex'))
}

/**
 * Calculate fee amount from total value
 */
function calculateFee(totalValue: bigint, feePercentage: number): {
  feeAmount: bigint
  changeAmount: bigint
} {
  // Convert percentage to basis points for precision (e.g., 1% = 100 basis points)
  const basisPoints = BigInt(Math.round(feePercentage * 100))
  const feeAmount = (totalValue * basisPoints) / BigInt(10000)
  const changeAmount = totalValue - feeAmount

  // Ensure minimum fee
  const minFee = BigInt(PRIVACY_CONFIG.FEE_CONFIG.MIN_FEE_WEI)
  if (feeAmount < minFee && totalValue > minFee) {
    return {
      feeAmount: minFee,
      changeAmount: totalValue - minFee
    }
  }

  return { feeAmount, changeAmount }
}

/**
 * Transact tokens within Railgun (internal transfer, no unshield)
 *
 * Splits user's UTXO into:
 * - Fee note sent to b402's zk-address (stays shielded)
 * - Change note back to user's zk-address (stays shielded)
 *
 * After this transaction, the user should call backend /unshield API
 * to have b402 unshield their change note.
 *
 * @param options - Transact configuration
 * @returns Transaction result with both note infos
 */
export async function transactTokens(options: TransactOptions): Promise<TransactResult> {
  const {
    feePercentage = PRIVACY_CONFIG.FEE_CONFIG.DEFAULT_FEE_PERCENTAGE,
    token,
    signer,
    network = 'mainnet',
    onProgress = () => {}
  } = options

  const signerAddress = await signer.getAddress()
  const provider = signer.provider
  if (!provider) {
    throw new Error('Signer must have a provider')
  }

  const tokenAddress = getTokenAddress(network, token)
  const chainId = options.chainId || getDefaultChainId()

  // Step 1: Get signature (cached 24h) - uses unified signature cache
  onProgress(0, 'Requesting signature...')
  const signature = await getCachedSignature(signer)

  // Step 2: Derive keys from signature (all client-side)
  onProgress(5, 'Deriving Railgun keys...')
  const keys = await deriveRailgunKeys(signature)

  // Step 3: Fetch spendable UTXOs
  onProgress(10, 'Fetching shielded tokens...')
  const utxos = await fetchSpendableUTXOs(
    signerAddress,
    keys.viewingKeyPair.privateKey,
    keys.masterPublicKey,
    keys.nullifyingKey,
    tokenAddress
  )

  if (utxos.length === 0) {
    throw new Error('No spendable shielded tokens found')
  }

  // Get total balance and select largest UTXO
  const balance = getSpendableBalance(utxos, tokenAddress)
  const utxo = utxos
    .filter(u => u.note.tokenAddress.toLowerCase() === tokenAddress.toLowerCase())
    .sort((a, b) => Number(b.note.value - a.note.value))[0]

  if (!utxo) {
    throw new Error('No UTXO found for token')
  }

  // Step 4: Calculate fee and change amounts
  const { feeAmount, changeAmount } = calculateFee(utxo.note.value, feePercentage)

  onProgress(15, `Splitting: ${ethers.formatUnits(feeAmount, 18)} fee, ${ethers.formatUnits(changeAmount, 18)} to you...`)

  // Validate b402 keys are configured
  const b402Mpk = PRIVACY_CONFIG.B402_RAILGUN_KEYS.masterPublicKey
  const b402Vpk = PRIVACY_CONFIG.B402_RAILGUN_KEYS.viewingPublicKey
  if (b402Mpk === '0x0000000000000000000000000000000000000000000000000000000000000000') {
    throw new Error('b402 Railgun keys not configured. Please set B402_RAILGUN_MPK and B402_RAILGUN_VPK.')
  }

  // Step 5: Verify merkle proof
  onProgress(20, 'Verifying merkle proof...')
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

  // Step 6: Generate randoms for both notes
  const feeRandom = generateSecureRandom()
  const changeRandom = generateSecureRandom()

  // Step 7: Build proof inputs
  onProgress(25, 'Building proof inputs...')
  const { privateInputs, publicInputs, feeNote, changeNote } = buildTransactProofInputs({
    utxo,
    nullifyingKey: keys.nullifyingKey,
    spendingKeyPair: keys.spendingKeyPair,
    feeAmount,
    feeRecipientMasterPublicKey: BigInt(b402Mpk),
    feeRandom,
    changeAmount,
    userMasterPublicKey: keys.masterPublicKey,
    changeRandom,
    tokenAddress
  })

  // Step 8: Encrypt both notes
  onProgress(28, 'Encrypting notes...')
  const tokenHash = ByteUtils.formatToByteLength(commitmentTokenAddress, ByteLength.UINT_256, false)

  // Encrypt fee note for b402
  const b402ViewingPublicKey = ByteUtils.hexToBytes(b402Vpk.replace('0x', ''))
  const feeCiphertext = await encryptChangeNote({
    noteRandom: formatNoteRandomForEncryption(feeRandom),
    noteValue: feeAmount,
    tokenHash,
    senderMasterPublicKey: keys.masterPublicKey,
    receiverMasterPublicKey: BigInt(b402Mpk),
    senderViewingPrivateKey: keys.viewingKeyPair.privateKey,
    receiverViewingPublicKey: b402ViewingPublicKey
  })

  // Encrypt change note for user (self)
  const userViewingPublicKey = await getPublicViewingKey(keys.viewingKeyPair.privateKey)
  const changeCiphertext = await encryptChangeNote({
    noteRandom: formatNoteRandomForEncryption(changeRandom),
    noteValue: changeAmount,
    tokenHash,
    senderMasterPublicKey: keys.masterPublicKey,
    receiverMasterPublicKey: keys.masterPublicKey,
    senderViewingPrivateKey: keys.viewingKeyPair.privateKey,
    receiverViewingPublicKey: userViewingPublicKey
  })

  // Step 9: Generate ZK proof with 01x02 circuit
  onProgress(30, 'Generating zero-knowledge proof (01x02 circuit)...')
  const proofResult = await generateProofClientSide({
    privateInputs,
    publicInputs,
    spendingPrivateKey: keys.spendingKeyPair.privateKey,
    chainId,
    treeNumber: utxo.tree,
    outputCount: 2,
    commitmentCiphertext: [feeCiphertext, changeCiphertext], // Both ciphertexts for transact
    isTransact: true, // Signal that this is NOT an unshield
    onProgress: (progress, status) => {
      const mappedProgress = 30 + ((progress - 5) / 90) * 55
      onProgress(mappedProgress, status)
    }
  })

  // Step 10: Build and send transaction
  onProgress(85, 'Creating transaction...')
  const tx = buildTransactTransaction({
    proofResult,
    treeNumber: utxo.tree,
    tokenAddress,
    chainId
  })

  onProgress(90, 'Sending transaction...')
  const txResponse = await signer.sendTransaction({
    to: tx.to,
    data: tx.data
  })

  onProgress(95, 'Waiting for confirmation...')
  const receipt = await txResponse.wait()

  const finalTxHash = receipt?.hash || txResponse.hash


  // Extract position from Transact event
  let changeNotePosition: string | undefined
  let changeNoteTreeNumber: string | undefined

  if (receipt?.logs) {
    // Transact event: event Transact(uint256 treeNumber, uint256 startPosition, bytes32[] hash, CommitmentCiphertext[] ciphertext)
    // On BSC, treeNumber and startPosition are NOT indexed - they're in the event data
    const TRANSACT_EVENT_TOPIC = '0x56a618cda1e34057b7f849a5792f6c8587a2dbe11c83d0254e72cb3daffda7d1'

    for (const log of receipt.logs) {
      if (log.topics[0] === TRANSACT_EVENT_TOPIC) {
        try {
          // Decode the event data - treeNumber and startPosition are the first two uint256 values
          // Event data layout: treeNumber (uint256), startPosition (uint256), hash[] offset, ciphertext[] offset, ...
          const data = log.data

          if (data && data.length >= 130) { // At least 2 uint256s (64 hex chars each) + 0x prefix
            // First 32 bytes (64 hex chars after 0x) = treeNumber
            const treeNumberHex = '0x' + data.slice(2, 66)
            // Next 32 bytes = startPosition
            const startPositionHex = '0x' + data.slice(66, 130)

            const treeNumber = BigInt(treeNumberHex).toString()
            const startPosition = BigInt(startPositionHex)

            // For transact with 2 outputs:
            // Output 0 (fee) is at startPosition
            // Output 1 (change) is at startPosition + 1
            changeNotePosition = (startPosition + BigInt(1)).toString()
            changeNoteTreeNumber = treeNumber

          } else {
          }
        } catch (err) {
        }
        break
      }
    }
  }

  // Store the change note for later discovery
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

  onProgress(100, 'Complete!')

  // Ensure we have position info (fallback to '0' if not found in event)
  if (!changeNotePosition || !changeNoteTreeNumber) {
    changeNotePosition = changeNotePosition || '0'
    changeNoteTreeNumber = changeNoteTreeNumber || '0'
  }

  return {
    hash: finalTxHash,
    feeAmount: feeAmount.toString(),
    changeAmount: changeAmount.toString(),
    changeNote,
    feeNote,
    changeNotePosition,
    changeNoteTreeNumber
  }
}
