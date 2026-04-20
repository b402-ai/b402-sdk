/**
 * UserOp Builder — ERC-4337 v0.7 packed UserOp construction
 *
 * Pattern from: cross-chain-atomic-routing/scripts/base-volume-loop-gasless-v2.ts:462
 *
 * Builds the packed UserOp format for ERC-4337 v0.7:
 *   - accountGasLimits = bytes32(verificationGasLimit(16) | callGasLimit(16))
 *   - gasFees = bytes32(maxPriorityFeePerGas(16) | maxFeePerGas(16))
 *   - paymasterAndData = paymaster(20) + pmVerificationGas(16) + pmPostOpGas(16) + timeEncoding + signature
 */

import { ethers } from 'ethers'
import { BASE_CONTRACTS } from '../types'

// ═══════════════ GAS LIMITS ═══════════════

export const GAS_LIMITS = {
  /** Gas for the main execution (approve + swap via AA) */
  CALL_GAS_LIMIT: 1500000n,
  /** Gas for signature verification */
  VERIFICATION_GAS_LIMIT: 500000n,
  /** Pre-verification gas (covers calldata cost) */
  PRE_VERIFICATION_GAS: 150000n,
  /** Paymaster verification gas */
  PM_VERIFICATION_GAS_LIMIT: 300000n,
  /** Paymaster post-op gas */
  PM_POST_OP_GAS_LIMIT: 150000n,
} as const

// ═══════════════ TYPES ═══════════════

export interface PackedUserOp {
  sender: string
  nonce: bigint
  initCode: string
  callData: string
  accountGasLimits: string // bytes32
  preVerificationGas: bigint
  gasFees: string // bytes32
  paymasterAndData: string
  signature: string
}

export interface BuildUserOpParams {
  sender: string
  nonce: bigint
  initCode: string
  callData: string
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
}

// ═══════════════ BUILD USER OP ═══════════════

/**
 * Build a packed UserOp (ERC-4337 v0.7 format).
 *
 * Gas limits use proven defaults from the volume loop.
 * paymasterAndData and signature are empty — fill with signPaymaster() and owner sign.
 */
export function buildUserOp(params: BuildUserOpParams): PackedUserOp {
  const {
    sender,
    nonce,
    initCode,
    callData,
    maxFeePerGas = 1000000n,
    maxPriorityFeePerGas = 1000000n,
  } = params

  // accountGasLimits = bytes32(verificationGasLimit(16) | callGasLimit(16))
  const accountGasLimits = ethers.zeroPadValue(
    ethers.toBeHex(
      (GAS_LIMITS.VERIFICATION_GAS_LIMIT << 128n) | GAS_LIMITS.CALL_GAS_LIMIT,
    ),
    32,
  )

  // gasFees = bytes32(maxPriorityFeePerGas(16) | maxFeePerGas(16))
  const gasFees = ethers.zeroPadValue(
    ethers.toBeHex(
      (maxPriorityFeePerGas << 128n) | maxFeePerGas,
    ),
    32,
  )

  return {
    sender,
    nonce,
    initCode: initCode || '0x',
    callData,
    accountGasLimits,
    preVerificationGas: GAS_LIMITS.PRE_VERIFICATION_GAS,
    gasFees,
    paymasterAndData: '0x',
    signature: '0x',
  }
}

// ═══════════════ COMPUTE HASH ═══════════════

/**
 * Compute the UserOp hash per ERC-4337 v0.7 packed format.
 *
 * hash = keccak256(abi.encode(
 *   keccak256(packedUserOp),
 *   entryPoint,
 *   chainId
 * ))
 */
export function computeUserOpHash(userOp: PackedUserOp, chainId: number): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder()

  const packedUserOp = abiCoder.encode(
    ['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
    [
      userOp.sender,
      userOp.nonce,
      ethers.keccak256(userOp.initCode || '0x'),
      ethers.keccak256(userOp.callData),
      userOp.accountGasLimits,
      userOp.preVerificationGas,
      userOp.gasFees,
      ethers.keccak256(userOp.paymasterAndData || '0x'),
    ],
  )

  const userOpHash = ethers.keccak256(packedUserOp)
  return ethers.keccak256(
    abiCoder.encode(
      ['bytes32', 'address', 'uint256'],
      [userOpHash, BASE_CONTRACTS.ENTRY_POINT, BigInt(chainId)],
    ),
  )
}

// ═══════════════ PAYMASTER SIGNING ═══════════════

/**
 * Sign UserOp with the VerifyingPaymaster.
 *
 * Produces paymasterAndData with layout:
 *   [0:20]    paymaster address
 *   [20:36]   pmVerificationGasLimit (uint128)
 *   [36:52]   pmPostOpGasLimit (uint128)
 *   [52:116]  abi.encode(validUntil, validAfter) (64 bytes)
 *   [116:181] ECDSA signature (65 bytes)
 */
export function signPaymaster(
  userOp: PackedUserOp,
  paymasterSignerKey: string,
  chainId: number,
): { paymasterAndData: string } {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder()
  const paymasterSigner = new ethers.Wallet(paymasterSignerKey)

  const now = Math.floor(Date.now() / 1000)
  const validAfter = now - 3600           // 1 hour ago
  const validUntil = now + 48 * 60 * 60   // 48 hours from now

  // pmGasLimits = bytes32(pmVerificationGas(16) | pmPostOpGas(16)) as uint256
  const pmGasLimits =
    (GAS_LIMITS.PM_VERIFICATION_GAS_LIMIT << 128n) | GAS_LIMITS.PM_POST_OP_GAS_LIMIT

  // Build paymaster-specific hash (matches VerifyingPaymaster.getHash() exactly)
  const pmHash = ethers.keccak256(
    abiCoder.encode(
      [
        'address', 'uint256', 'bytes32', 'bytes32', 'bytes32',
        'uint256', 'uint256', 'bytes32', 'uint256', 'address',
        'uint48', 'uint48',
      ],
      [
        userOp.sender,
        userOp.nonce,
        ethers.keccak256(userOp.initCode || '0x'),
        ethers.keccak256(userOp.callData),
        userOp.accountGasLimits,
        pmGasLimits,
        userOp.preVerificationGas,
        userOp.gasFees,
        BigInt(chainId),
        BASE_CONTRACTS.PAYMASTER,
        validUntil,
        validAfter,
      ],
    ),
  )

  // EIP-191 personal sign
  const signature = paymasterSigner.signMessageSync(ethers.getBytes(pmHash))

  // Build paymasterAndData
  const timeEncoding = abiCoder.encode(['uint48', 'uint48'], [validUntil, validAfter])
  const paymasterData = ethers.concat([timeEncoding, signature])

  const paymasterAndData = ethers.concat([
    BASE_CONTRACTS.PAYMASTER,
    ethers.zeroPadValue(ethers.toBeHex(GAS_LIMITS.PM_VERIFICATION_GAS_LIMIT), 16),
    ethers.zeroPadValue(ethers.toBeHex(GAS_LIMITS.PM_POST_OP_GAS_LIMIT), 16),
    paymasterData,
  ])

  return { paymasterAndData: ethers.hexlify(paymasterAndData) }
}
