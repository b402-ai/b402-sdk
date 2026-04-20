/**
 * Wallet Store — ~/.b402/wallet.json
 *
 * Generates, stores, and reads the private key for the MCP server.
 * Priority: WORKER_PRIVATE_KEY env var > ~/.b402/wallet.json > null
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const B402_DIR = join(homedir(), '.b402')
const WALLET_FILE = join(B402_DIR, 'wallet.json')

export interface WalletConfig {
  privateKey: string
  address: string           // master EOA (not used on-chain)
  incognitoEOA: string      // derived anonymous EOA
  smartWallet: string       // Incognito wallet - Nexus smart wallet (fund this)
  createdAt: string
}

function ensureDir() {
  if (!existsSync(B402_DIR)) {
    mkdirSync(B402_DIR, { recursive: true, mode: 0o700 })
  }
}

export function walletExists(): boolean {
  return existsSync(WALLET_FILE)
}

export function readWallet(): WalletConfig | null {
  if (!existsSync(WALLET_FILE)) return null
  try {
    return JSON.parse(readFileSync(WALLET_FILE, 'utf8'))
  } catch {
    return null
  }
}

export function getPrivateKey(): string | null {
  // Priority: env var > wallet file
  if (process.env.WORKER_PRIVATE_KEY) return process.env.WORKER_PRIVATE_KEY
  const wallet = readWallet()
  return wallet?.privateKey ?? null
}

/**
 * Import an existing private key and derive all addresses.
 * Saves to ~/.b402/wallet.json with 0600 permissions.
 */
export async function importWallet(privateKey: string): Promise<WalletConfig> {
  const { ethers } = await import('ethers')
  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
  const masterWallet = new ethers.Wallet(key)
  return deriveAndSave(masterWallet)
}

/**
 * Generate a new wallet and derive all addresses deterministically.
 * Saves to ~/.b402/wallet.json with 0600 permissions.
 */
export async function createWallet(): Promise<WalletConfig> {
  const { ethers } = await import('ethers')
  const masterWallet = ethers.Wallet.createRandom()
  return deriveAndSave(masterWallet)
}

async function deriveAndSave(masterWallet: import('ethers').HDNodeWallet | import('ethers').Wallet): Promise<WalletConfig> {
  const { ethers } = await import('ethers')
  const privateKey = masterWallet.privateKey

  // Derive incognito EOA (same as B402.init())
  const sig = await masterWallet.signMessage('b402 Incognito EOA Derivation')
  const incognitoKey = ethers.keccak256(sig)
  const incognitoWallet = new ethers.Wallet(incognitoKey)
  const incognitoEOA = incognitoWallet.address

  // Derive smart wallet via Nexus factory (deterministic CREATE2)
  const SALT_PREFIX = 'b402-incognito'
  const salt = ethers.keccak256(ethers.toUtf8Bytes(`${SALT_PREFIX}-${incognitoEOA.toLowerCase()}`))

  const NEXUS_FACTORY = '0x0000006648ED9B2B842552BE63Af870bC74af837'
  const NEXUS_BOOTSTRAP = '0x0000003eDf18913c01cBc482C978bBD3D6E8ffA3'

  const validatorInitData = ethers.solidityPacked(['address'], [incognitoEOA])
  const bootstrapInterface = new ethers.Interface([
    'function initNexusWithDefaultValidator(bytes calldata data)',
  ])
  const bootstrapCall = bootstrapInterface.encodeFunctionData(
    'initNexusWithDefaultValidator',
    [validatorInitData],
  )
  const initData = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'bytes'],
    [NEXUS_BOOTSTRAP, bootstrapCall],
  )
  const saltBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(salt)), 32)

  // Compute counterfactual address via RPC
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const factoryInterface = new ethers.Interface([
    'function computeAccountAddress(bytes calldata initData, bytes32 salt) view returns (address)',
  ])
  const callData = factoryInterface.encodeFunctionData('computeAccountAddress', [initData, saltBytes32])
  const result = await provider.call({ to: NEXUS_FACTORY, data: callData })
  const smartWallet = ethers.AbiCoder.defaultAbiCoder().decode(['address'], result)[0] as string

  const config: WalletConfig = {
    privateKey,
    address: masterWallet.address,
    incognitoEOA,
    smartWallet,
    createdAt: new Date().toISOString(),
  }

  // Write with restricted permissions
  ensureDir()
  writeFileSync(WALLET_FILE, JSON.stringify(config, null, 2))
  chmodSync(WALLET_FILE, 0o600)

  return config
}
