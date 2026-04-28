/**
 * RelayAdapt Cross-Contract Call Helpers
 *
 * Builds relay() transactions for private DeFi operations.
 * RelayAdapt atomically: unshield → execute calls → shield output.
 *
 * On-chain observer sees: "RelayAdapt called a DEX" — zero link to user.
 */

import { ethers } from 'ethers'
import type { RailgunTransactionStruct } from './transaction-formatter'

// RelayAdapt contract on Base (from B402 Railgun fork deployment)
export const RELAY_ADAPT_ADDRESS = '0xB0BC6d50098519c2a030661338F82a8792b85404'

// RelayAdapt ABI — relay() and shield() functions
const RELAY_ADAPT_ABI = [
  `function relay(
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
    )[] _transactions,
    tuple(
      bytes31 random,
      bool requireSuccess,
      uint256 minGasLimit,
      tuple(address to, bytes data, uint256 value)[] calls
    ) _actionData
  ) payable`,
  `function shield(
    tuple(
      tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage,
      tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext
    )[] _shieldRequests
  )`
]

const relayAdaptInterface = new ethers.Interface(RELAY_ADAPT_ABI)

export interface ActionData {
  random: Uint8Array  // 31 bytes
  requireSuccess: boolean
  minGasLimit: bigint
  calls: Array<{ to: string; data: string; value: bigint }>
}

/**
 * Generate shield requests for output tokens using RelayAdaptHelper from the engine.
 *
 * Each shield request tells RelayAdapt to shield a token back into the privacy pool
 * for the given Railgun address (0zk...).
 */
export async function buildRelayShieldRequests(
  railgunAddress: string,
  shieldTokens: Array<{ tokenAddress: string; recipientAddress?: string }>,
): Promise<{ shieldRequests: any[]; shieldCallData: string }> {
  const { RelayAdaptHelper } = await import(
    '@railgun-community/engine/dist/contracts/relay-adapt/relay-adapt-helper'
  )

  const shieldRandom = ethers.hexlify(ethers.randomBytes(16))

  const shieldERC20Recipients = shieldTokens.map(t => ({
    tokenAddress: t.tokenAddress,
    recipientAddress: t.recipientAddress || railgunAddress,
  }))

  const shieldRequests = await RelayAdaptHelper.generateRelayShieldRequests(
    shieldRandom,
    shieldERC20Recipients,
    [], // no NFTs
  )

  const shieldCallData = relayAdaptInterface.encodeFunctionData('shield', [shieldRequests])

  return { shieldRequests, shieldCallData }
}

/**
 * Compute adaptParams — hash of nullifiers + transaction count + action data.
 *
 * This is verified by the contract to ensure the transaction wasn't modified by MITM.
 * Must be computed BEFORE the ZK proof since it goes into boundParamsHash.
 */
export function computeAdaptParams(
  nullifiers: string[],
  actionData: ActionData,
): string {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder()

  const adaptParamsPreimage = abiCoder.encode(
    [
      'bytes32[][] nullifiers',
      'uint256 transactionsLength',
      'tuple(bytes31 random, bool requireSuccess, uint256 minGasLimit, tuple(address to, bytes data, uint256 value)[] calls) actionData',
    ],
    [
      [[...nullifiers]], // [[nullifier1]] — one transaction with one nullifier
      1,                  // transactionsLength = 1
      actionData,
    ],
  )

  return ethers.keccak256(adaptParamsPreimage)
}

/**
 * Build the relay() calldata for RelayAdapt.
 *
 * Takes the formatted transaction struct (same as transact()) and wraps it
 * in relay() with the action data.
 */
export function buildRelayCalldata(
  transactionStruct: RailgunTransactionStruct,
  actionData: ActionData,
  relayAdaptAddress: string = RELAY_ADAPT_ADDRESS,
): { to: string; data: string } {
  const data = relayAdaptInterface.encodeFunctionData('relay', [
    [transactionStruct],  // _transactions array (1 transaction)
    actionData,           // _actionData (random + calls)
  ])

  return {
    to: relayAdaptAddress,
    data,
  }
}

/**
 * Build the full ordered calls array for a cross-contract operation.
 *
 * Appends the shield() call at the end so output tokens are shielded
 * back into the privacy pool after the DeFi operation completes.
 */
export function buildOrderedCalls(
  userCalls: Array<{ to: string; data: string; value?: string }>,
  shieldCallData: string,
  inputTokenAddress: string,
  shieldTokens: Array<{ tokenAddress: string }>,
  relayAdaptAddress: string = RELAY_ADAPT_ADDRESS,
): Array<{ to: string; data: string; value: bigint }> {
  const orderedCalls = [
    ...userCalls.map(c => ({
      to: c.to,
      data: c.data,
      value: c.value ? BigInt(c.value) : 0n,
    })),
    // Shield call at the end — shields all output tokens back to pool
    { to: relayAdaptAddress, data: shieldCallData, value: 0n },
  ]

  return orderedCalls
}
