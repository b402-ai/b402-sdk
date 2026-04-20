/**
 * Private Swap Pipeline — Core execution engine
 *
 * Single function that does everything:
 *   1. Derive smart wallet + Railgun keys
 *   2. Check privacy pool balance, shield if needed
 *   3. Get best swap quote (0x + Aerodrome fallback)
 *   4. Generate ZK proof (full or partial unshield)
 *   5. Build atomic multicall [unshield → approve → swap], submit UserOp
 *
 * Used by both `pnpm run agent` and `pnpm run swap`.
 */

import { ethers } from 'ethers'
import { deriveWorkerWalletParams, computeSmartWalletAddressOnChain, isWalletDeployed, buildInitCode } from './wallet/wallet-factory'
import { buildUserOp, computeUserOpHash, signPaymaster } from './wallet/userop-builder'
import { submitUserOp, resolveRelayerKey } from './wallet/submit-userop'
import { buildBatchCallData } from './wallet/batch-calldata'
import { buildPrivateSwapCalls } from './swap/swap-builder'
import { calculateUnshieldAmount, calculateNetAfterUnshieldFee } from './swap/fee-calculator'
import { shieldTokens, waitForShieldIndexing } from './privacy/connector'
import { ZeroXProvider } from './swap/zero-x-provider'
import { AerodromeProvider } from './swap/aerodrome-provider'
import { getQuoteWithFallback } from './swap/swap-provider'
import { BASE_CONTRACTS, RAILGUN_UNSHIELD_FEE_BPS } from './types'
import { deriveRailgunKeys } from './privacy/lib/key-derivation'
import { fetchSpendableUTXOs, fetchSpendableUTXOsLightweight, selectUTXOsForAmount } from './privacy/lib/utxo-fetcher'
import { buildUnshieldProofInputs, buildPartialUnshieldProofInputs } from './privacy/lib/proof-inputs'
import { generateProofClientSide } from './privacy/lib/prover'
import { buildUnshieldTransaction } from './privacy/lib/transaction-formatter'
import { createChangeNoteCommitmentCiphertext, formatNoteRandomForEncryption } from './privacy/lib/note-encryption'

// ═══════════════ INTERFACES ═══════════════

export interface TokenInfo {
  address: string
  symbol: string
  decimals: number
}

export interface PrivateSwapConfig {
  privateKey: string
  paymasterSignerKey: string
  zeroXApiKey: string
  tokenIn: TokenInfo
  tokenOut: TokenInfo
  /** Human-readable amount, e.g. "1" */
  amount: string
  /** Max slippage in basis points, e.g. 100 = 1% */
  slippageBps: number
  rpcUrl?: string
  chainId?: number
}

export interface SwapProgress {
  step(n: number, total: number, title: string): void
  spin(msg: string): void
  succeed(msg: string): void
  info(key: string, value: string): void
}

export interface PrivateSwapResult {
  txHash: string
  blockNumber: number
  smartWallet: string
  ownerEOA: string
  amountIn: string
  amountOut: string
  tokenIn: string
  tokenOut: string
  provider: string
  unshieldGross: bigint
  netAmount: bigint
  railgunFee: string
  proofTimeSeconds: number
}

// ═══════════════ PIPELINE ═══════════════

const STEPS = 5

export async function executePrivateSwap(
  config: PrivateSwapConfig,
  progress: SwapProgress,
): Promise<PrivateSwapResult> {
  const {
    privateKey, paymasterSignerKey, zeroXApiKey,
    tokenIn, tokenOut,
    amount, slippageBps,
    rpcUrl = 'https://mainnet.base.org',
    chainId = 8453,
  } = config

  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const signer = new ethers.Wallet(privateKey, provider)
  const tokenInAddress = tokenIn.address
  const tokenOutAddress = tokenOut.address

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

  const desiredSwapAmount = ethers.parseUnits(amount, tokenIn.decimals)
  const unshieldGross = calculateUnshieldAmount(desiredSwapAmount, RAILGUN_UNSHIELD_FEE_BPS)
  const netAmount = calculateNetAfterUnshieldFee(unshieldGross, RAILGUN_UNSHIELD_FEE_BPS)
  let hasBalance = false

  try {
    const lightUtxos = await fetchSpendableUTXOsLightweight(
      signer.address, keys.viewingKeyPair.privateKey,
      keys.masterPublicKey, keys.nullifyingKey, tokenInAddress, chainId,
    )
    const balance = lightUtxos.reduce((s: bigint, u: any) => s + BigInt(u.note.value), 0n)
    hasBalance = balance >= unshieldGross
    progress.succeed(`${ethers.formatUnits(balance, tokenIn.decimals)} ${tokenIn.symbol} in privacy pool`)
  } catch {
    progress.succeed('No private balance found')
  }

  if (!hasBalance) {
    const shieldAmount = unshieldGross
    progress.spin(`Shielding ${ethers.formatUnits(shieldAmount, tokenIn.decimals)} ${tokenIn.symbol} into privacy pool...`)
    const shieldResult = await shieldTokens({
      privateKey, tokenAddress: tokenInAddress,
      amount: shieldAmount, chainId, rpcUrl,
      railgunRelay: BASE_CONTRACTS.RAILGUN_RELAY,
    })
    progress.succeed(`Shielded: ${shieldResult.txHash}`)

    progress.spin('Waiting for indexing...')
    await waitForShieldIndexing({
      privateKey, tokenAddress: tokenInAddress,
      expectedAmount: shieldAmount, chainId, maxWaitMs: 180_000,
    })
    progress.succeed('Funds are now private')
  }

  // ─── Step 3: Best price ───

  progress.step(3, STEPS, 'Finding best swap price')
  progress.spin('Querying 0x + Aerodrome...')

  const zeroX = new ZeroXProvider(zeroXApiKey, chainId)
  const aerodrome = new AerodromeProvider(BASE_CONTRACTS.AERODROME_ROUTER, provider)
  const quote = await getQuoteWithFallback([zeroX, aerodrome], {
    sellToken: tokenInAddress, buyToken: tokenOutAddress,
    sellAmount: netAmount, taker: smartWallet, slippageBps,
  })
  const outAmount = ethers.formatUnits(quote.buyAmount, tokenOut.decimals)

  progress.succeed(`${quote.provider}: ${ethers.formatUnits(netAmount, tokenIn.decimals)} ${tokenIn.symbol} → ${outAmount} ${tokenOut.symbol}`)

  // ─── Step 4: ZK proof ───

  progress.step(4, STEPS, 'Generating ZK proof')
  progress.spin('Fetching UTXOs...')

  const utxos = await fetchSpendableUTXOs(
    signer.address, keys.viewingKeyPair.privateKey,
    keys.masterPublicKey, keys.nullifyingKey, tokenInAddress, chainId,
  )
  const utxo = selectUTXOsForAmount(utxos, unshieldGross, tokenInAddress)[0]
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
      recipientAddress: smartWallet, tokenAddress: tokenInAddress,
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
      unshieldAmount: unshieldGross, recipientAddress: smartWallet, tokenAddress: tokenInAddress,
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

  progress.step(5, STEPS, 'Executing private swap')

  const unshieldTx = buildUnshieldTransaction({
    proofResult, treeNumber: utxo.tree, tokenAddress: tokenInAddress,
    recipientAddress: smartWallet, unshieldAmount: unshieldGross, chainId,
  })
  const calls = buildPrivateSwapCalls({
    unshieldCalldata: unshieldTx.data, railgunRelay: BASE_CONTRACTS.RAILGUN_RELAY,
    tokenIn: tokenInAddress, netAmountAfterFee: netAmount, swapQuote: quote,
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
    amountIn: ethers.formatUnits(netAmount, tokenIn.decimals),
    amountOut: outAmount,
    tokenIn: tokenIn.symbol,
    tokenOut: tokenOut.symbol,
    provider: quote.provider,
    unshieldGross,
    netAmount,
    railgunFee: ethers.formatUnits(unshieldGross - netAmount, tokenIn.decimals),
    proofTimeSeconds,
  }
}
