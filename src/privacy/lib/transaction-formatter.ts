/**
 * Transaction Formatter
 *
 * Formats ZK proof into a transaction for the Railgun contract.
 * Ported from backend: utils/railgun-core/transaction/formatter.ts
 */

import { ethers } from 'ethers'
import type { Proof, ProofResult, BoundParamsV2 } from './prover'
import type { PublicInputsRailgun } from './proof-inputs'
import type { CommitmentCiphertext } from './note-encryption'

// Railgun Smart Wallet contract addresses
const RAILGUN_CONTRACT: Record<number, string> = {
  56: '0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601',   // BSC Mainnet (B402 fork)
  8453: '0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85',  // Base Mainnet (B402 fork)
  42161: '0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601', // Arbitrum (B402 fork, deployed 2026-04-13)
  84532: '0x2D8c0b26C1d7b0E04F2fbBB1b5E4783c3d153902', // Base Sepolia
}

/**
 * Commitment ciphertext structure for the contract
 */
export interface ContractCommitmentCiphertext {
  ciphertext: [string, string, string, string]  // bytes32[4]
  blindedSenderViewingKey: string               // bytes32
  blindedReceiverViewingKey: string             // bytes32
  annotationData: string                        // bytes
  memo: string                                  // bytes
}

export interface RailgunTransactionStruct {
  proof: {
    a: { x: string; y: string }
    b: { x: [string, string]; y: [string, string] }
    c: { x: string; y: string }
  }
  merkleRoot: string
  nullifiers: string[]
  commitments: string[]
  boundParams: {
    treeNumber: number
    minGasPrice: string
    unshield: number
    chainID: string
    adaptContract: string
    adaptParams: string
    commitmentCiphertext: ContractCommitmentCiphertext[]
  }
  unshieldPreimage: {
    npk: string
    token: {
      tokenType: number
      tokenAddress: string
      tokenSubID: number
    }
    value: string
  }
}

export interface FormatUnshieldParams {
  proofResult: ProofResult
  treeNumber: number
  tokenAddress: string
  recipientAddress: string
  unshieldAmount: bigint
  chainId: number
}

/**
 * Format proof and inputs into Railgun contract transaction struct
 */
export function formatUnshieldTransaction(
  params: FormatUnshieldParams
): RailgunTransactionStruct {
  const {
    proofResult,
    treeNumber,
    tokenAddress,
    recipientAddress,
    unshieldAmount,
    chainId
  } = params

  // Format snarkProof for contract
  const snarkProof = {
    a: {
      x: proofResult.proof.pi_a[0],
      y: proofResult.proof.pi_a[1]
    },
    b: {
      x: [proofResult.proof.pi_b[0][0], proofResult.proof.pi_b[0][1]] as [string, string],
      y: [proofResult.proof.pi_b[1][0], proofResult.proof.pi_b[1][1]] as [string, string]
    },
    c: {
      x: proofResult.proof.pi_c[0],
      y: proofResult.proof.pi_c[1]
    }
  }

  // Format public inputs as hex strings
  const merkleRoot = `0x${proofResult.publicInputs.merkleRoot.toString(16).padStart(64, '0')}`
  const nullifiers = proofResult.publicInputs.nullifiers.map(
    n => `0x${n.toString(16).padStart(64, '0')}`
  )
  const commitments = proofResult.publicInputs.commitmentsOut.map(
    c => `0x${c.toString(16).padStart(64, '0')}`
  )

  // Build unshieldPreimage
  // For unshield, npk contains the recipient address
  const recipientAddressBigInt = BigInt(recipientAddress)
  const npkHex = `0x${recipientAddressBigInt.toString(16).padStart(64, '0')}`

  const unshieldPreimage = {
    npk: npkHex,
    token: {
      tokenType: 0, // ERC20
      tokenAddress: ethers.getAddress(tokenAddress),
      tokenSubID: 0
    },
    value: unshieldAmount.toString()
  }

  // Use boundParams from proof result (includes commitmentCiphertext)
  // This ensures the boundParams match what was used to compute boundParamsHash in the ZK proof
  const formattedBoundParams = {
    treeNumber: proofResult.boundParams.treeNumber,
    minGasPrice: proofResult.boundParams.minGasPrice.toString(),
    unshield: proofResult.boundParams.unshield,
    chainID: proofResult.boundParams.chainID,
    adaptContract: proofResult.boundParams.adaptContract,
    adaptParams: proofResult.boundParams.adaptParams,
    commitmentCiphertext: proofResult.boundParams.commitmentCiphertext
  }

  return {
    proof: snarkProof,
    merkleRoot,
    nullifiers,
    commitments,
    boundParams: formattedBoundParams,
    unshieldPreimage
  }
}

/**
 * Encode transaction for Railgun contract call
 * Returns to and data only - let wallet estimate gas
 */
export function encodeUnshieldTransaction(
  transactionStruct: RailgunTransactionStruct,
  chainId: number
): { to: string; data: string } {
  const railgunContractAddress = RAILGUN_CONTRACT[chainId]
  if (!railgunContractAddress) {
    throw new Error(`No Railgun contract for chain ${chainId}`)
  }

  // RailgunSmartWallet ABI for transact() function
  const railgunABI = [
    `function transact(
      tuple(
        tuple(
          tuple(uint256 x, uint256 y) a,
          tuple(uint256[2] x, uint256[2] y) b,
          tuple(uint256 x, uint256 y) c
        ) proof,
        bytes32 merkleRoot,
        bytes32[] nullifiers,
        bytes32[] commitments,
        tuple(
          uint16 treeNumber,
          uint72 minGasPrice,
          uint8 unshield,
          uint64 chainID,
          address adaptContract,
          bytes32 adaptParams,
          tuple(
            bytes32[4] ciphertext,
            bytes32 blindedSenderViewingKey,
            bytes32 blindedReceiverViewingKey,
            bytes annotationData,
            bytes memo
          )[] commitmentCiphertext
        ) boundParams,
        tuple(
          bytes32 npk,
          tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token,
          uint120 value
        ) unshieldPreimage
      )[] _transactions
    )`
  ]

  const iface = new ethers.Interface(railgunABI)
  const data = iface.encodeFunctionData('transact', [[transactionStruct]])

  return {
    to: railgunContractAddress,
    data
  }
}

/**
 * Build transaction ready to send
 * No hardcoded gas - wallet will estimate automatically
 */
export function buildUnshieldTransaction(
  params: FormatUnshieldParams
): { to: string; data: string } {
  const transactionStruct = formatUnshieldTransaction(params)
  return encodeUnshieldTransaction(transactionStruct, params.chainId)
}

/**
 * Parameters for formatting a transact transaction (no unshield)
 */
export interface FormatTransactParams {
  proofResult: ProofResult
  treeNumber: number
  tokenAddress: string
  chainId: number
}

/**
 * Format proof and inputs into Railgun transaction struct for transact (no unshield)
 *
 * Key difference from unshield:
 * - unshieldPreimage.npk = 0 (tells contract this is a pure transact)
 * - Both outputs stay shielded in Railgun
 */
export function formatTransactTransaction(
  params: FormatTransactParams
): RailgunTransactionStruct {
  const {
    proofResult,
    treeNumber,
    tokenAddress,
    chainId
  } = params

  // Format snarkProof for contract
  const snarkProof = {
    a: {
      x: proofResult.proof.pi_a[0],
      y: proofResult.proof.pi_a[1]
    },
    b: {
      x: [proofResult.proof.pi_b[0][0], proofResult.proof.pi_b[0][1]] as [string, string],
      y: [proofResult.proof.pi_b[1][0], proofResult.proof.pi_b[1][1]] as [string, string]
    },
    c: {
      x: proofResult.proof.pi_c[0],
      y: proofResult.proof.pi_c[1]
    }
  }

  // Format public inputs as hex strings
  const merkleRoot = `0x${proofResult.publicInputs.merkleRoot.toString(16).padStart(64, '0')}`
  const nullifiers = proofResult.publicInputs.nullifiers.map(
    n => `0x${n.toString(16).padStart(64, '0')}`
  )
  const commitments = proofResult.publicInputs.commitmentsOut.map(
    c => `0x${c.toString(16).padStart(64, '0')}`
  )

  // CRITICAL: For transact (no unshield), set unshieldPreimage to null/zero
  // This tells the contract that both outputs stay shielded
  const unshieldPreimage = {
    npk: '0x0000000000000000000000000000000000000000000000000000000000000000',
    token: {
      tokenType: 0,
      tokenAddress: '0x0000000000000000000000000000000000000000',
      tokenSubID: 0
    },
    value: '0'
  }

  // Use boundParams from proof result (includes commitmentCiphertext)
  const formattedBoundParams = {
    treeNumber: proofResult.boundParams.treeNumber,
    minGasPrice: proofResult.boundParams.minGasPrice.toString(),
    unshield: 0, // NO unshield for transact
    chainID: proofResult.boundParams.chainID,
    adaptContract: proofResult.boundParams.adaptContract,
    adaptParams: proofResult.boundParams.adaptParams,
    commitmentCiphertext: proofResult.boundParams.commitmentCiphertext
  }

  return {
    proof: snarkProof,
    merkleRoot,
    nullifiers,
    commitments,
    boundParams: formattedBoundParams,
    unshieldPreimage
  }
}

/**
 * Build transact transaction ready to send
 * No hardcoded gas - wallet will estimate automatically
 */
export function buildTransactTransaction(
  params: FormatTransactParams
): { to: string; data: string } {
  const transactionStruct = formatTransactTransaction(params)
  return encodeUnshieldTransaction(transactionStruct, params.chainId) // Same encoding, different struct
}
