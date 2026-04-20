/**
 * Lend Builder — Builds the unshield+approve+deposit multicall for Morpho
 *
 * Produces 3 calls for the ERC-7579 batch execute:
 *   Call 1: Railgun.transact(proof, ...) → unshield tokens to smart wallet
 *   Call 2: ERC20.approve(vault, netAmount)
 *   Call 3: Vault.deposit(netAmount, smartWallet)
 *
 * Identical pattern to swap-builder.ts — same 3-call batch, different Call 3.
 */

import { ethers } from 'ethers'
import type { Call } from '../wallet/batch-calldata'
import { ERC4626_INTERFACE } from './morpho-vaults'

export interface PrivateLendCallsParams {
  /** Pre-built unshield calldata (from ZK proof pipeline) */
  unshieldCalldata: string
  /** Railgun relay contract address */
  railgunRelay: string
  /** Token being deposited (for approve call) */
  token: string
  /** Amount the wallet receives after unshield (no fee on b402 fork) */
  netAmountAfterFee: bigint
  /** ERC-4626 vault address (e.g. Morpho Steakhouse USDC) */
  vault: string
  /** Smart wallet address (receives vault shares) */
  receiver: string
}

export interface PrivateRedeemCallsParams {
  /** ERC-4626 vault address */
  vault: string
  /** Number of vault shares to redeem */
  shares: bigint
  /** Smart wallet address (receives underlying tokens + owns shares) */
  wallet: string
}

const ERC20_INTERFACE = new ethers.Interface([
  'function approve(address spender, uint256 amount)',
])

/**
 * Build the 3-call array for a private lend (deposit).
 *
 * @returns Array of 3 calls: [unshield, approve, deposit]
 */
export function buildPrivateLendCalls(params: PrivateLendCallsParams): Call[] {
  const { unshieldCalldata, railgunRelay, token, netAmountAfterFee, vault, receiver } = params

  // Call 1: Unshield from Railgun to smart wallet
  const unshieldCall: Call = {
    to: railgunRelay,
    value: '0',
    data: unshieldCalldata,
  }

  // Call 2: Approve vault to spend the unshielded tokens
  const approveCall: Call = {
    to: token,
    value: '0',
    data: ERC20_INTERFACE.encodeFunctionData('approve', [vault, netAmountAfterFee]),
  }

  // Call 3: Deposit into ERC-4626 vault
  const depositCall: Call = {
    to: vault,
    value: '0',
    data: ERC4626_INTERFACE.encodeFunctionData('deposit', [netAmountAfterFee, receiver]),
  }

  return [unshieldCall, approveCall, depositCall]
}

export interface DirectDepositCallsParams {
  /** Token being deposited (for approve call) */
  token: string
  /** Amount to deposit (tokens already on wallet) */
  amount: bigint
  /** ERC-4626 vault address */
  vault: string
  /** Smart wallet address (receives vault shares) */
  receiver: string
}

/**
 * Build the 2-call array for a direct deposit (no ZK proof).
 * Used when tokens are already on the smart wallet (e.g. after a redeem).
 *
 * @returns Array of 2 calls: [approve, deposit]
 */
export function buildDirectDepositCalls(params: DirectDepositCallsParams): Call[] {
  const { token, amount, vault, receiver } = params

  const approveCall: Call = {
    to: token,
    value: '0',
    data: ERC20_INTERFACE.encodeFunctionData('approve', [vault, amount]),
  }

  const depositCall: Call = {
    to: vault,
    value: '0',
    data: ERC4626_INTERFACE.encodeFunctionData('deposit', [amount, receiver]),
  }

  return [approveCall, depositCall]
}

/**
 * Build the call array for a redeem (withdraw from vault).
 *
 * No ZK proof needed — vault shares already sit on the smart wallet.
 *
 * @returns Array of 1 call: [redeem]
 */
export function buildPrivateRedeemCalls(params: PrivateRedeemCallsParams): Call[] {
  const { vault, shares, wallet } = params

  const redeemCall: Call = {
    to: vault,
    value: '0',
    data: ERC4626_INTERFACE.encodeFunctionData('redeem', [shares, wallet, wallet]),
  }

  return [redeemCall]
}
