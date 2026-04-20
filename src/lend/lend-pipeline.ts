/**
 * Private Lend Pipeline — Unshield + deposit into Morpho vault
 *
 * Same 5-step pattern as swap pipeline:
 *   1. Derive smart wallet + Railgun keys
 *   2. Check privacy pool balance, shield if needed
 *   3. Preview deposit (vault shares estimate)
 *   4. Generate ZK proof (full or partial unshield)
 *   5. Build atomic multicall [unshield → approve → deposit], submit UserOp
 */

import { ethers } from 'ethers'
import { deriveWorkerWalletParams, computeSmartWalletAddressOnChain, isWalletDeployed, buildInitCode } from '../wallet/wallet-factory'
import { buildUserOp, computeUserOpHash, signPaymaster } from '../wallet/userop-builder'
import { buildBatchCallData } from '../wallet/batch-calldata'
import { buildPrivateLendCalls, buildPrivateRedeemCalls, buildDirectDepositCalls } from './lend-builder'
import { submitUserOp, resolveRelayerKey } from '../wallet/submit-userop'
import { resolveVault, ERC4626_INTERFACE } from './morpho-vaults'
import { calculateUnshieldAmount, calculateNetAfterUnshieldFee } from '../swap/fee-calculator'
import { shieldTokens, waitForShieldIndexing } from '../privacy/connector'
import { BASE_CONTRACTS, RAILGUN_UNSHIELD_FEE_BPS } from '../types'
import { deriveRailgunKeys } from '../privacy/lib/key-derivation'
import { fetchSpendableUTXOs, fetchSpendableUTXOsLightweight, selectUTXOsForAmount } from '../privacy/lib/utxo-fetcher'
import { buildUnshieldProofInputs, buildPartialUnshieldProofInputs } from '../privacy/lib/proof-inputs'
import { generateProofClientSide } from '../privacy/lib/prover'
import { buildUnshieldTransaction } from '../privacy/lib/transaction-formatter'
import { createChangeNoteCommitmentCiphertext, formatNoteRandomForEncryption } from '../privacy/lib/note-encryption'
import type { TokenInfo, SwapProgress } from '../pipeline'

// ═══════════════ INTERFACES ═══════════════

export interface PrivateLendConfig {
  privateKey: string
  paymasterSignerKey: string
  token: TokenInfo
  /** Human-readable amount, e.g. "100" */
  amount: string
  /** Vault name (e.g. "steakhouse") or address */
  vault: string
  rpcUrl?: string
  chainId?: number
}

export interface PrivateLendResult {
  txHash: string
  blockNumber: number
  smartWallet: string
  ownerEOA: string
  amountDeposited: string
  tokenSymbol: string
  vaultName: string
  vaultAddress: string
  railgunFee: string
  proofTimeSeconds: number
}

// ═══════════════ PIPELINE ═══════════════

const STEPS = 5

export async function executePrivateLend(
  config: PrivateLendConfig,
  progress: SwapProgress,
): Promise<PrivateLendResult> {
  const {
    privateKey, paymasterSignerKey,
    token, amount, vault: vaultNameOrAddr,
    rpcUrl = 'https://mainnet.base.org',
    chainId = 8453,
  } = config

  const vault = resolveVault(vaultNameOrAddr)
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const signer = new ethers.Wallet(privateKey, provider)
  const tokenAddress = token.address

  // ─── Step 1: Identity ───

  progress.step(1, STEPS, 'Creating private identity')
  progress.spin('Deriving smart wallet + Railgun keys...')

  const walletParams = deriveWorkerWalletParams(privateKey)
  const smartWallet = await computeSmartWalletAddressOnChain(walletParams, provider)
  walletParams.smartWalletAddress = smartWallet

  const signature = await signer.signMessage('b402 Incognito EOA Derivation')
  const keys = await deriveRailgunKeys(signature)

  progress.succeed('Identity ready')
  progress.info('Smart Wallet', smartWallet)

  // ─── Step 2: Private balance ───

  progress.step(2, STEPS, 'Checking private balance')
  progress.spin('Scanning Railgun privacy pool...')

  const desiredAmount = ethers.parseUnits(amount, token.decimals)
  const unshieldGross = calculateUnshieldAmount(desiredAmount, RAILGUN_UNSHIELD_FEE_BPS)
  const netAmount = calculateNetAfterUnshieldFee(unshieldGross, RAILGUN_UNSHIELD_FEE_BPS)
  let hasBalance = false

  try {
    const lightUtxos = await fetchSpendableUTXOsLightweight(
      signer.address, keys.viewingKeyPair.privateKey,
      keys.masterPublicKey, keys.nullifyingKey, tokenAddress, chainId,
    )
    const balance = lightUtxos.reduce((s: bigint, u: any) => s + BigInt(u.note.value), 0n)
    hasBalance = balance >= unshieldGross
    progress.succeed(`${ethers.formatUnits(balance, token.decimals)} ${token.symbol} in privacy pool`)
  } catch {
    progress.succeed('No private balance found')
  }

  if (!hasBalance) {
    const shieldAmount = unshieldGross
    progress.spin(`Shielding ${ethers.formatUnits(shieldAmount, token.decimals)} ${token.symbol} into privacy pool...`)
    const shieldResult = await shieldTokens({
      privateKey, tokenAddress,
      amount: shieldAmount, chainId, rpcUrl,
      railgunRelay: BASE_CONTRACTS.RAILGUN_RELAY,
    })
    progress.succeed(`Shielded: ${shieldResult.txHash}`)

    progress.spin('Waiting for indexing...')
    await waitForShieldIndexing({
      privateKey, tokenAddress,
      expectedAmount: shieldAmount, chainId, maxWaitMs: 180_000,
    })
    progress.succeed('Funds are now private')
  }

  // ─── Step 3: Preview deposit ───

  progress.step(3, STEPS, `Depositing into ${vault.name}`)
  progress.spin('Previewing vault deposit...')

  const vaultContract = new ethers.Contract(vault.address, ERC4626_INTERFACE, provider)
  let previewShares: bigint
  try {
    previewShares = await vaultContract.previewDeposit(netAmount)
    progress.succeed(`${ethers.formatUnits(netAmount, token.decimals)} ${token.symbol} → ${vault.name}`)
  } catch {
    previewShares = 0n
    progress.succeed(`${ethers.formatUnits(netAmount, token.decimals)} ${token.symbol} → ${vault.name}`)
  }

  // ─── Step 4: ZK proof ───

  progress.step(4, STEPS, 'Generating ZK proof')
  progress.spin('Fetching UTXOs...')

  const utxos = await fetchSpendableUTXOs(
    signer.address, keys.viewingKeyPair.privateKey,
    keys.masterPublicKey, keys.nullifyingKey, tokenAddress, chainId,
  )
  const utxo = selectUTXOsForAmount(utxos, unshieldGross, tokenAddress)[0]
  const utxoValue = BigInt(utxo.note.value)
  const isPartial = utxoValue > unshieldGross

  let proofInputs: any
  let outputCount: 1 | 2 = 1
  let commitmentCiphertext: any[] = []

  if (isPartial) {
    const randomBytes = new Uint8Array(16)
    crypto.getRandomValues(randomBytes)
    const changeRandom = BigInt('0x' + Buffer.from(randomBytes).toString('hex'))
    const changeAmount = utxoValue - unshieldGross

    proofInputs = buildPartialUnshieldProofInputs({
      utxo, nullifyingKey: keys.nullifyingKey, spendingKeyPair: keys.spendingKeyPair,
      unshieldAmount: unshieldGross, changeAmount,
      recipientAddress: smartWallet, tokenAddress,
      changeMasterPublicKey: keys.masterPublicKey, changeRandom,
    })
    outputCount = 2

    const { ByteUtils, ByteLength } = await import('@railgun-community/engine')
    const tokenHash = ByteUtils.formatToByteLength(
      utxo.commitment.tokenAddress.toLowerCase(), ByteLength.UINT_256, false,
    )
    commitmentCiphertext = await createChangeNoteCommitmentCiphertext(
      formatNoteRandomForEncryption(changeRandom), changeAmount, tokenHash,
      keys.masterPublicKey, keys.viewingKeyPair,
    )
  } else {
    proofInputs = buildUnshieldProofInputs({
      utxo, nullifyingKey: keys.nullifyingKey, spendingKeyPair: keys.spendingKeyPair,
      unshieldAmount: unshieldGross, recipientAddress: smartWallet, tokenAddress,
    })
  }

  progress.spin('Proving ownership without revealing identity...')
  const proofStart = Date.now()
  const proofResult = await generateProofClientSide({
    ...proofInputs, spendingPrivateKey: keys.spendingKeyPair.privateKey,
    chainId, treeNumber: utxo.tree, outputCount, commitmentCiphertext,
  })
  const proofTimeSeconds = (Date.now() - proofStart) / 1000
  progress.succeed(`ZK proof generated in ${proofTimeSeconds.toFixed(1)}s`)

  // ─── Step 5: Execute ───

  progress.step(5, STEPS, 'Executing private deposit')

  const unshieldTx = buildUnshieldTransaction({
    proofResult, treeNumber: utxo.tree, tokenAddress,
    recipientAddress: smartWallet, unshieldAmount: unshieldGross, chainId,
  })
  const calls = buildPrivateLendCalls({
    unshieldCalldata: unshieldTx.data, railgunRelay: BASE_CONTRACTS.RAILGUN_RELAY,
    token: tokenAddress, netAmountAfterFee: netAmount,
    vault: vault.address, receiver: smartWallet,
  })
  const callData = buildBatchCallData(calls)

  progress.spin('Signing transaction...')
  const deployed = await isWalletDeployed(smartWallet, provider)
  const initCode = deployed ? '0x' : buildInitCode(walletParams)
  const entryPointRead = new ethers.Contract(
    BASE_CONTRACTS.ENTRY_POINT,
    ['function getNonce(address sender, uint192 key) view returns (uint256)'],
    provider,
  )
  const nonce = await entryPointRead.getNonce(smartWallet, 0)
  const feeData = await provider.getFeeData()

  const userOp = buildUserOp({
    sender: smartWallet, nonce, initCode, callData,
    maxFeePerGas: feeData.maxFeePerGas ?? 1_000_000n,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 1_000_000n,
  })

  const { paymasterAndData } = signPaymaster(userOp, paymasterSignerKey, chainId)
  userOp.paymasterAndData = paymasterAndData
  const userOpHash = computeUserOpHash(userOp, chainId)
  userOp.signature = signer.signMessageSync(ethers.getBytes(userOpHash))

  progress.spin('Submitting to Base mainnet...')
  const { txHash, blockNumber } = await submitUserOp(userOp, {
    provider,
    workerKey: privateKey,
    relayerKey: resolveRelayerKey(),
  })
  progress.succeed(`Confirmed in block ${blockNumber.toLocaleString()}`)

  return {
    txHash,
    blockNumber,
    smartWallet,
    ownerEOA: walletParams.ownerEOA,
    amountDeposited: ethers.formatUnits(netAmount, token.decimals),
    tokenSymbol: token.symbol,
    vaultName: vault.name,
    vaultAddress: vault.address,
    railgunFee: ethers.formatUnits(unshieldGross - netAmount, token.decimals),
    proofTimeSeconds,
  }
}

// ═══════════════ REDEEM PIPELINE ═══════════════

export interface RedeemConfig {
  privateKey: string
  paymasterSignerKey: string
  token: TokenInfo
  /** Vault name or address */
  vault: string
  /** 'all' or specific share amount */
  shares?: string
  rpcUrl?: string
  chainId?: number
}

export interface RedeemResult {
  txHash: string
  blockNumber: number
  smartWallet: string
  vaultName: string
  vaultAddress: string
  sharesRedeemed: string
  assetsReceived: string
  tokenSymbol: string
}

/**
 * Redeem (withdraw) from a Morpho vault.
 * No ZK proof needed — vault shares already sit on the smart wallet.
 */
export async function executeRedeem(
  config: RedeemConfig,
  progress: SwapProgress,
): Promise<RedeemResult> {
  const {
    privateKey, paymasterSignerKey,
    token, vault: vaultNameOrAddr,
    rpcUrl = 'https://mainnet.base.org',
    chainId = 8453,
  } = config

  const vault = resolveVault(vaultNameOrAddr)
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const signer = new ethers.Wallet(privateKey, provider)

  // ─── Step 1: Identity ───

  progress.step(1, 3, 'Resolving wallet')
  progress.spin('Deriving smart wallet...')

  const walletParams = deriveWorkerWalletParams(privateKey)
  const smartWallet = await computeSmartWalletAddressOnChain(walletParams, provider)
  walletParams.smartWalletAddress = smartWallet

  progress.succeed('Wallet ready')
  progress.info('Smart Wallet', smartWallet)

  // ─── Step 2: Check vault shares ───

  progress.step(2, 3, 'Checking vault position')
  progress.spin('Reading vault shares...')

  const vaultContract = new ethers.Contract(vault.address, ERC4626_INTERFACE, provider)
  let shares: bigint

  if (config.shares && config.shares !== 'all') {
    shares = ethers.parseUnits(config.shares, vault.decimals)
  } else {
    shares = await vaultContract.balanceOf(smartWallet)
  }

  if (shares === 0n) {
    throw new Error(`No vault shares found for ${smartWallet} in ${vault.name}`)
  }

  const assetsOut = await vaultContract.convertToAssets(shares)
  progress.succeed(`${ethers.formatUnits(shares, vault.decimals)} shares → ~${ethers.formatUnits(assetsOut, token.decimals)} ${token.symbol}`)

  // ─── Step 3: Execute redeem ───

  progress.step(3, 3, 'Redeeming from vault')

  const calls = buildPrivateRedeemCalls({
    vault: vault.address,
    shares,
    wallet: smartWallet,
  })
  const callData = buildBatchCallData(calls)

  progress.spin('Signing transaction...')
  const deployed = await isWalletDeployed(smartWallet, provider)
  const initCode = deployed ? '0x' : buildInitCode(walletParams)
  const entryPointRead = new ethers.Contract(
    BASE_CONTRACTS.ENTRY_POINT,
    ['function getNonce(address sender, uint192 key) view returns (uint256)'],
    provider,
  )
  const nonce = await entryPointRead.getNonce(smartWallet, 0)
  const feeData = await provider.getFeeData()

  const userOp = buildUserOp({
    sender: smartWallet, nonce, initCode, callData,
    maxFeePerGas: feeData.maxFeePerGas ?? 1_000_000n,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 1_000_000n,
  })

  const { paymasterAndData } = signPaymaster(userOp, paymasterSignerKey, chainId)
  userOp.paymasterAndData = paymasterAndData
  const userOpHash = computeUserOpHash(userOp, chainId)
  userOp.signature = signer.signMessageSync(ethers.getBytes(userOpHash))

  progress.spin('Submitting to Base mainnet...')
  const { txHash, blockNumber } = await submitUserOp(userOp, {
    provider,
    workerKey: privateKey,
    relayerKey: resolveRelayerKey(),
  })
  progress.succeed(`Confirmed in block ${blockNumber.toLocaleString()}`)

  return {
    txHash,
    blockNumber,
    smartWallet,
    vaultName: vault.name,
    vaultAddress: vault.address,
    sharesRedeemed: ethers.formatUnits(shares, 18),
    assetsReceived: ethers.formatUnits(assetsOut, token.decimals),
    tokenSymbol: token.symbol,
  }
}

// ═══════════════ DIRECT DEPOSIT PIPELINE ═══════════════

export interface DirectDepositConfig {
  privateKey: string
  paymasterSignerKey: string
  token: { address: string; symbol: string; decimals: number }
  /** Human-readable amount (tokens must already be on smart wallet) */
  amount: string
  vault: string
  rpcUrl?: string
  chainId?: number
}

export interface DirectDepositResult {
  txHash: string
  blockNumber: number
  smartWallet: string
  amountDeposited: string
  tokenSymbol: string
  vaultName: string
  vaultAddress: string
}

/**
 * Deposit tokens that are already on the smart wallet into a vault.
 * No ZK proof needed — just [approve, deposit] via UserOp.
 * Used after a redeem (rebalance flow).
 */
export async function executeDirectDeposit(
  config: DirectDepositConfig,
  progress: SwapProgress,
): Promise<DirectDepositResult> {
  const {
    privateKey, paymasterSignerKey,
    token, amount, vault: vaultNameOrAddr,
    rpcUrl = 'https://mainnet.base.org',
    chainId = 8453,
  } = config

  const vault = resolveVault(vaultNameOrAddr)
  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const signer = new ethers.Wallet(privateKey, provider)
  const depositAmount = ethers.parseUnits(amount, token.decimals)

  // ─── Step 1: Resolve wallet ───

  progress.step(1, 2, 'Preparing deposit')
  progress.spin('Deriving smart wallet...')

  const walletParams = deriveWorkerWalletParams(privateKey)
  const smartWallet = await computeSmartWalletAddressOnChain(walletParams, provider)
  walletParams.smartWalletAddress = smartWallet

  progress.succeed('Wallet ready')
  progress.info('Deposit', `${amount} ${token.symbol} → ${vault.name}`)

  // ─── Step 2: Execute deposit ───

  progress.step(2, 2, `Depositing into ${vault.name}`)

  const calls = buildDirectDepositCalls({
    token: token.address,
    amount: depositAmount,
    vault: vault.address,
    receiver: smartWallet,
  })
  const callData = buildBatchCallData(calls)

  progress.spin('Signing transaction...')
  const deployed = await isWalletDeployed(smartWallet, provider)
  const initCode = deployed ? '0x' : buildInitCode(walletParams)
  const entryPointRead = new ethers.Contract(
    BASE_CONTRACTS.ENTRY_POINT,
    ['function getNonce(address sender, uint192 key) view returns (uint256)'],
    provider,
  )
  const nonce = await entryPointRead.getNonce(smartWallet, 0)
  const feeData = await provider.getFeeData()

  const userOp = buildUserOp({
    sender: smartWallet, nonce, initCode, callData,
    maxFeePerGas: feeData.maxFeePerGas ?? 1_000_000n,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 1_000_000n,
  })

  const { paymasterAndData } = signPaymaster(userOp, paymasterSignerKey, chainId)
  userOp.paymasterAndData = paymasterAndData
  const userOpHash = computeUserOpHash(userOp, chainId)
  userOp.signature = signer.signMessageSync(ethers.getBytes(userOpHash))

  progress.spin('Submitting to Base mainnet...')
  const { txHash, blockNumber } = await submitUserOp(userOp, {
    provider,
    workerKey: privateKey,
    relayerKey: resolveRelayerKey(),
  })
  progress.succeed(`Confirmed in block ${blockNumber.toLocaleString()}`)

  return {
    txHash,
    blockNumber,
    smartWallet,
    amountDeposited: amount,
    tokenSymbol: token.symbol,
    vaultName: vault.name,
    vaultAddress: vault.address,
  }
}
