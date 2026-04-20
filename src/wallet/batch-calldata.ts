/**
 * Batch CallData — ERC-7579 batch execute encoding for Nexus smart wallets
 *
 * Copied from: cross-chain-atomic-routing/scripts/base-volume-loop-gasless-v2.ts:415
 *
 * Encodes: Nexus.execute(bytes32 mode, bytes calldata executionCalldata)
 * Where:
 *   Single mode (0x00...): executionCalldata = abi.encodePacked(target, value, calldata)
 *   Batch mode  (0x01...): executionCalldata = abi.encode(Execution[])
 *   Execution = (address target, uint256 value, bytes callData)
 */

import { ethers } from 'ethers'

/** Single execution mode (mode = 0x00...) */
export const SINGLE_EXEC_MODE = '0x0000000000000000000000000000000000000000000000000000000000000000'

/** Batch execution mode (mode = 0x01...) */
export const BATCH_EXEC_MODE = '0x0100000000000000000000000000000000000000000000000000000000000000'

const NEXUS_INTERFACE = new ethers.Interface([
  'function execute(bytes32 mode, bytes calldata executionCalldata)',
])

export interface Call {
  to: string
  value: string
  data: string
}

export interface DecodedCall {
  to: string
  value: bigint
  data: string
}

/**
 * Build ERC-7579 batch execute callData.
 *
 * For a single call: uses single exec mode (0x00) with packed encoding.
 * For multiple calls: uses batch exec mode (0x01) with ABI-encoded Execution array.
 *
 * @param calls - Array of calls to batch
 * @returns Encoded calldata for Nexus.execute()
 */
export function buildBatchCallData(calls: Call[]): string {
  if (calls.length === 1) {
    // Single call mode
    const executionData = ethers.solidityPacked(
      ['address', 'uint256', 'bytes'],
      [calls[0].to, BigInt(calls[0].value), calls[0].data],
    )
    return NEXUS_INTERFACE.encodeFunctionData('execute', [SINGLE_EXEC_MODE, executionData])
  }

  // Batch mode
  const executions = calls.map(c => ({
    target: c.to,
    value: BigInt(c.value),
    callData: c.data,
  }))

  const executionData = ethers.AbiCoder.defaultAbiCoder().encode(
    ['tuple(address target, uint256 value, bytes callData)[]'],
    [executions],
  )

  return NEXUS_INTERFACE.encodeFunctionData('execute', [BATCH_EXEC_MODE, executionData])
}

/**
 * Decode ERC-7579 batch execute callData back into individual calls.
 *
 * @param callData - Encoded calldata from buildBatchCallData()
 * @returns Array of decoded calls
 */
export function decodeBatchCallData(callData: string): DecodedCall[] {
  const decoded = NEXUS_INTERFACE.decodeFunctionData('execute', callData)
  const mode = decoded[0] as string
  const executionData = decoded[1] as string

  if (mode === SINGLE_EXEC_MODE) {
    // Single mode: packed encoding (address + uint256 + bytes)
    // address = first 20 bytes, uint256 = next 32 bytes, rest = calldata
    const bytes = ethers.getBytes(executionData)
    const to = ethers.getAddress(ethers.hexlify(bytes.slice(0, 20)))
    const value = BigInt(ethers.hexlify(bytes.slice(20, 52)))
    const data = ethers.hexlify(bytes.slice(52))

    return [{ to, value, data }]
  }

  // Batch mode: ABI-encoded tuple array
  const [executions] = ethers.AbiCoder.defaultAbiCoder().decode(
    ['tuple(address target, uint256 value, bytes callData)[]'],
    executionData,
  )

  return (executions as Array<{ target: string; value: bigint; callData: string }>).map(e => ({
    to: e.target,
    value: e.value,
    data: e.callData,
  }))
}
