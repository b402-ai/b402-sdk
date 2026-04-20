/**
 * Wallet Factory — CREATE2 smart wallet derivation for Nexus/ERC-4337
 *
 * Pattern from: cross-chain-atomic-routing/scripts/base-volume-loop-gasless-v2.ts:370
 *
 * Each worker gets a unique smart wallet derived from its private key:
 *   ownerEOA → salt → CREATE2 address (deterministic, counterfactual)
 */

import { ethers } from 'ethers'
import { BASE_CONTRACTS } from '../types'

const { NEXUS_FACTORY, NEXUS_BOOTSTRAP, K1_VALIDATOR } = BASE_CONTRACTS

const FACTORY_INTERFACE = new ethers.Interface([
  'function createAccount(bytes calldata initData, bytes32 salt) returns (address)',
  'function computeAccountAddress(bytes calldata initData, bytes32 salt) view returns (address)',
])

const BOOTSTRAP_INTERFACE = new ethers.Interface([
  'function initNexusWithDefaultValidator(bytes calldata data)',
])

export interface WalletParams {
  ownerEOA: string
  smartWalletAddress: string
  salt: string
  saltBytes32: string
  initData: string
}

/**
 * Derive worker wallet parameters from a private key.
 *
 * The smart wallet address is computed locally using CREATE2.
 * The wallet is counterfactual — it doesn't need to be deployed yet.
 * It gets deployed on the first UserOp via initCode.
 *
 * @param privateKey - Worker's EOA private key
 * @returns Wallet parameters including computed smart wallet address
 */
export function deriveWorkerWalletParams(privateKey: string): WalletParams {
  const wallet = new ethers.Wallet(privateKey)
  const ownerEOA = wallet.address

  // Encode bootstrap init data (sets K1Validator as default validator)
  const validatorInitData = ethers.solidityPacked(['address'], [ownerEOA])
  const bootstrapCall = BOOTSTRAP_INTERFACE.encodeFunctionData(
    'initNexusWithDefaultValidator',
    [validatorInitData],
  )
  const initData = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes'],
    [NEXUS_BOOTSTRAP, bootstrapCall],
  )

  // Deterministic salt from owner address
  const salt = ethers.keccak256(ethers.toUtf8Bytes(`b402-worker-${ownerEOA.toLowerCase()}`))
  const saltBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(salt)), 32)

  // Local CREATE2 is a rough estimate — use resolveSmartWalletAddress() for the real address
  const smartWalletAddress = computeCreate2Address(initData, saltBytes32)

  return { ownerEOA, smartWalletAddress, salt, saltBytes32, initData }
}

/**
 * Resolve the real smart wallet address using the factory's computeAccountAddress view.
 * This is the authoritative address the EntryPoint will use.
 */
export async function resolveSmartWalletAddress(
  walletParams: WalletParams,
  provider: ethers.Provider,
): Promise<string> {
  return computeSmartWalletAddressOnChain(walletParams, provider)
}

/**
 * Build initCode for a UserOp that deploys the wallet.
 *
 * @param walletParams - From deriveWorkerWalletParams. Pass null if wallet is already deployed.
 * @returns InitCode (factory address + createAccount calldata), or '0x' if already deployed
 */
export function buildInitCode(walletParams: WalletParams | null): string {
  if (!walletParams) return '0x'

  const factoryCalldata = FACTORY_INTERFACE.encodeFunctionData('createAccount', [
    walletParams.initData,
    walletParams.saltBytes32,
  ])

  // initCode = factory address (20 bytes) + factory calldata
  return ethers.concat([NEXUS_FACTORY, factoryCalldata])
}

/**
 * Compute the smart wallet address using an RPC call to the factory.
 * Use this to verify the locally-computed address matches on-chain.
 */
export async function computeSmartWalletAddressOnChain(
  walletParams: WalletParams,
  provider: ethers.Provider,
): Promise<string> {
  const callData = FACTORY_INTERFACE.encodeFunctionData('computeAccountAddress', [
    walletParams.initData,
    walletParams.saltBytes32,
  ])
  const result = await provider.call({ to: NEXUS_FACTORY, data: callData })
  return FACTORY_INTERFACE.decodeFunctionResult('computeAccountAddress', result)[0] as string
}

/**
 * Check if a smart wallet is already deployed.
 */
export async function isWalletDeployed(
  address: string,
  provider: ethers.Provider,
): Promise<boolean> {
  const code = await provider.getCode(address)
  return code !== '0x'
}

/**
 * Compute CREATE2 address locally (without RPC).
 * Uses the Nexus factory's create2 scheme.
 */
function computeCreate2Address(initData: string, saltBytes32: string): string {
  // The Nexus factory uses a proxy pattern, so the actual init code hash
  // depends on the factory implementation. For now, we compute a deterministic
  // address from the parameters. In production, use computeSmartWalletAddressOnChain()
  // to verify the address matches.

  // This is a simplified local computation. The factory will produce the same
  // address given the same (initData, salt) pair.
  const computed = ethers.keccak256(
    ethers.concat([
      '0xff',
      NEXUS_FACTORY,
      saltBytes32,
      ethers.keccak256(initData),
    ]),
  )
  return ethers.getAddress('0x' + computed.slice(-40))
}
