/**
 * Wallet Store — ~/.b402/wallet.json
 *
 * Generates, stores, and reads the private key for the MCP server.
 * Priority: WORKER_PRIVATE_KEY env var > ~/.b402/wallet.json > null
 *
 * Overwrite policy: createWallet() and importWallet() refuse to overwrite an
 * existing wallet.json with a different key unless B402_FORCE_WALLET_RESET=1.
 * When forced, the prior file is preserved as wallet.json.bak.<unix-ts> so
 * repeated overwrites cannot destroy history.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, copyFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Resolve paths lazily so HOME-env overrides work in tests.
function getB402Dir(): string { return join(homedir(), '.b402') }
function getWalletFile(): string { return join(getB402Dir(), 'wallet.json') }

export interface WalletConfig {
  privateKey: string
  address: string           // master EOA (not used on-chain)
  incognitoEOA: string      // derived anonymous EOA
  smartWallet: string       // Incognito wallet - Nexus smart wallet (fund this)
  createdAt: string
}

function ensureDir() {
  const dir = getB402Dir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

export function walletExists(): boolean {
  return existsSync(getWalletFile())
}

export function readWallet(): WalletConfig | null {
  const file = getWalletFile()
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
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
 * Guard against silent wallet.json overwrites.
 *
 * - `desiredKey === undefined` (createWallet path): refuse if a wallet exists.
 * - `desiredKey !== undefined` (importWallet path): if the existing wallet's
 *   key matches, return it (idempotent). If it differs (or the file is
 *   unreadable), refuse — unless B402_FORCE_WALLET_RESET=1, in which case the
 *   prior file is copied to wallet.json.bak.<unix-ts> before the caller writes.
 *
 * Returns the existing config when the caller should short-circuit (idempotent
 * import). Throws on any unsafe overwrite. Returns null when it is safe to
 * proceed with a fresh write (no existing file, or forced overwrite + backup
 * already taken).
 */
function assertSafeToWrite(desiredKey?: string): WalletConfig | null {
  const file = getWalletFile()
  if (!existsSync(file)) return null

  const forced = process.env.B402_FORCE_WALLET_RESET === '1'
  let existing: WalletConfig | null = null
  let raw: string | null = null
  try {
    raw = readFileSync(file, 'utf8')
    existing = JSON.parse(raw)
  } catch {
    existing = null
  }

  // Idempotent re-import: caller passed the exact same key already on disk.
  if (
    desiredKey !== undefined &&
    existing &&
    typeof existing.privateKey === 'string' &&
    existing.privateKey.toLowerCase() === desiredKey.toLowerCase()
  ) {
    return existing
  }

  // Anything else is an overwrite; only allowed when explicitly forced.
  if (!forced) {
    const reason = existing
      ? `wallet.json already exists at ${file} with a different private key`
      : `wallet.json at ${file} is unreadable or malformed`
    throw new Error(
      `${reason}. Refusing to overwrite. ` +
      `Back up the file manually, then re-run with B402_FORCE_WALLET_RESET=1 ` +
      `to replace it (a timestamped wallet.json.bak.<unix-ts> will be saved first).`,
    )
  }

  // Forced overwrite: copy existing file to a timestamped backup. Use
  // unix-second resolution; tests may need to wait between calls to get
  // distinct filenames, but production callers never overwrite that fast.
  ensureDir()
  const backup = `${file}.bak.${Math.floor(Date.now() / 1000)}`
  copyFileSync(file, backup)
  try { chmodSync(backup, 0o600) } catch {}
  return null
}

/**
 * Import an existing private key and derive all addresses.
 * Saves to ~/.b402/wallet.json with 0600 permissions.
 *
 * Idempotent: returns the existing wallet if its key matches `privateKey`.
 * Throws if a different wallet is already on disk and B402_FORCE_WALLET_RESET
 * is not set. When forced, the prior file is preserved as a timestamped .bak.
 */
export async function importWallet(privateKey: string): Promise<WalletConfig> {
  const { ethers } = await import('ethers')
  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
  const existing = assertSafeToWrite(key)
  if (existing) return existing
  const masterWallet = new ethers.Wallet(key)
  return deriveAndSave(masterWallet)
}

/**
 * Generate a new wallet and derive all addresses deterministically.
 * Saves to ~/.b402/wallet.json with 0600 permissions.
 *
 * Refuses to run when wallet.json already exists unless
 * B402_FORCE_WALLET_RESET=1 is set.
 */
export async function createWallet(): Promise<WalletConfig> {
  const { ethers } = await import('ethers')
  assertSafeToWrite(undefined)
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
  const file = getWalletFile()
  writeFileSync(file, JSON.stringify(config, null, 2))
  chmodSync(file, 0o600)

  return config
}
