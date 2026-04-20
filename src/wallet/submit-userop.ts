/**
 * UserOp Submission — handles sending signed UserOps to the chain.
 *
 * Two modes:
 *   1. Self-relay: WORKER_PRIVATE_KEY calls handleOps (needs ETH)
 *   2. Relayer:    RELAYER_PRIVATE_KEY calls handleOps (worker needs no ETH)
 *
 * The relayer pattern matches b402-facilitator's walletIncognitoSettle —
 * a separate funded wallet submits the TX and receives gas refund.
 */

import { ethers } from 'ethers'
import { BASE_CONTRACTS } from '../types'
import type { PackedUserOp } from './userop-builder'

const ENTRY_POINT_ABI = [
  'function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address payable beneficiary)',
]

export interface SubmitConfig {
  /** The provider to use */
  provider: ethers.JsonRpcProvider
  /** Worker's private key (signs UserOps, may also submit if no relayer) */
  workerKey: string
  /** Separate relayer key for gas-free submission. If set, worker needs no ETH. */
  relayerKey?: string
  /** Gas limit for the outer handleOps call */
  gasLimit?: bigint
}

/**
 * Submit a signed UserOp via EntryPoint.handleOps().
 *
 * If relayerKey is provided, the relayer wallet calls handleOps (worker needs no ETH).
 * Otherwise, the worker wallet calls handleOps (worker needs ETH for gas).
 */
export async function submitUserOp(
  userOp: PackedUserOp,
  config: SubmitConfig,
): Promise<{ txHash: string; blockNumber: number }> {
  const { provider, workerKey, relayerKey, gasLimit = 3_000_000n } = config

  // Use relayer if available, otherwise self-relay
  const submitterKey = relayerKey || workerKey
  const submitter = new ethers.Wallet(submitterKey, provider)

  const entryPoint = new ethers.Contract(
    BASE_CONTRACTS.ENTRY_POINT,
    ENTRY_POINT_ABI,
    submitter,
  )

  const tx = await entryPoint.handleOps(
    [{
      sender: userOp.sender,
      nonce: userOp.nonce,
      initCode: userOp.initCode,
      callData: userOp.callData,
      accountGasLimits: userOp.accountGasLimits,
      preVerificationGas: userOp.preVerificationGas,
      gasFees: userOp.gasFees,
      paymasterAndData: userOp.paymasterAndData,
      signature: userOp.signature,
    }],
    submitter.address, // beneficiary — receives gas refund
    { gasLimit },
  )

  const receipt = await tx.wait()
  return {
    txHash: tx.hash,
    blockNumber: receipt!.blockNumber,
  }
}

/**
 * Resolve the relayer key from env or config.
 * Falls back to worker key if no relayer is configured.
 */
export function resolveRelayerKey(): string | undefined {
  return process.env.RELAYER_PRIVATE_KEY || undefined
}
