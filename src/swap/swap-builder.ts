/**
 * Swap Builder — Builds the unshield+approve+swap multicall
 *
 * Produces 3 calls for the ERC-7579 batch execute:
 *   Call 1: Railgun.transact(proof, ...) → unshield tokens to smart wallet
 *   Call 2: ERC20.approve(allowanceTarget, netAmount)
 *   Call 3: Router.swap(calldata from quote)
 *
 * The unshield amount equals the desired amount (0% fee on b402 fork).
 * The approve and swap amounts use the net amount.
 */

import { ethers } from 'ethers'
import type { Call } from '../wallet/batch-calldata'
import type { SwapQuote } from '../types'

export interface PrivateSwapCallsParams {
  /** Pre-built unshield calldata (from ZK proof pipeline) */
  unshieldCalldata: string
  /** Railgun relay contract address */
  railgunRelay: string
  /** Token being sold (for approve call) */
  tokenIn: string
  /** Amount the wallet receives after unshield (no fee on b402 fork) */
  netAmountAfterFee: bigint
  /** Swap quote from 0x or Aerodrome */
  swapQuote: SwapQuote
}

const ERC20_INTERFACE = new ethers.Interface([
  'function approve(address spender, uint256 amount)',
])

/**
 * Build the 3-call array for a private swap.
 *
 * @returns Array of 3 calls: [unshield, approve, swap]
 */
export function buildPrivateSwapCalls(params: PrivateSwapCallsParams): Call[] {
  const { unshieldCalldata, railgunRelay, tokenIn, netAmountAfterFee, swapQuote } = params

  // Call 1: Unshield from Railgun to smart wallet
  const unshieldCall: Call = {
    to: railgunRelay,
    value: '0',
    data: unshieldCalldata,
  }

  // Call 2: Approve the swap router to spend the unshielded tokens
  const approveCall: Call = {
    to: tokenIn,
    value: '0',
    data: ERC20_INTERFACE.encodeFunctionData('approve', [
      swapQuote.allowanceTarget,
      netAmountAfterFee,
    ]),
  }

  // Call 3: Execute the swap
  const swapCall: Call = {
    to: swapQuote.to,
    value: swapQuote.value,
    data: swapQuote.data,
  }

  return [unshieldCall, approveCall, swapCall]
}
