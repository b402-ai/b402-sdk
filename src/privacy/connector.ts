/**
 * Privacy Connector — Real bridge to cross-chain-atomic-routing privacy lib
 *
 * Connects the worker's SwapDependencies interface to the actual
 * Railgun privacy functions: key derivation, UTXO fetching, proof
 * generation, and transaction building.
 *
 * Also provides the shield function for onboarding (deposit to privacy pool).
 */

import { ethers } from 'ethers'
import type { SwapDependencies } from '../recipes/private-swap'

/** Privacy deps — all SwapDependencies except getQuote (which comes from swap providers) */
export type PrivacyDeps = Omit<SwapDependencies, 'getQuote'>

// Privacy lib — copied into our repo from cross-chain-atomic-routing
import { deriveRailgunKeys, getRailgunAddress } from './lib/key-derivation'
import { fetchSpendableUTXOs, fetchSpendableUTXOsLightweight, getSpendableBalance, selectUTXOsForAmount } from './lib/utxo-fetcher'
import { buildUnshieldProofInputs, buildPartialUnshieldProofInputs } from './lib/proof-inputs'
import { generateProofClientSide } from './lib/prover'
import { buildUnshieldTransaction } from './lib/transaction-formatter'
import { getBackendApiUrl } from '../config/chains'

// Railgun SDK for shielding
const B402_UNIFIED_MESSAGE = 'b402 Incognito EOA Derivation'

/**
 * Create real SwapDependencies connected to the privacy lib.
 */
export function createRealSwapDeps(config: {
  chainId: number
  rpcUrl: string
  entryPoint: string
  privateKey: string
}): PrivacyDeps {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl)

  return {
    deriveKeys: async (privateKey: string) => {
      const wallet = new ethers.Wallet(privateKey)
      const signature = await wallet.signMessage(B402_UNIFIED_MESSAGE)
      return deriveRailgunKeys(signature)
    },

    fetchUTXOs: async (
      signerAddress: string,
      viewingPrivateKey: Uint8Array,
      masterPublicKey: bigint,
      nullifyingKey: bigint,
      tokenAddress: string,
      chainId: number,
    ) => {
      return fetchSpendableUTXOs(
        signerAddress,
        viewingPrivateKey,
        masterPublicKey,
        nullifyingKey,
        tokenAddress,
        chainId,
      )
    },

    getBalance: (utxos: any[], tokenAddress: string) => {
      return getSpendableBalance(utxos, tokenAddress)
    },

    selectUTXOs: (utxos: any[], amount: bigint, tokenAddress: string) => {
      return selectUTXOsForAmount(utxos, amount, tokenAddress)
    },

    buildProofInputs: (params: any) => {
      // Use full unshield (01x01) if amount equals UTXO value
      // Use partial unshield (01x02) if amount < UTXO value
      if (params.changeAmount !== undefined) {
        return buildPartialUnshieldProofInputs(params)
      }
      return buildUnshieldProofInputs(params)
    },

    generateProof: async (params: any) => {
      return generateProofClientSide(params)
    },

    buildUnshieldTx: (params: any) => {
      return buildUnshieldTransaction(params)
    },

    getNonce: async (sender: string) => {
      const entryPoint = new ethers.Contract(
        config.entryPoint,
        ['function getNonce(address sender, uint192 key) view returns (uint256)'],
        provider,
      )
      return entryPoint.getNonce(sender, 0)
    },

    submitUserOp: async (userOp: any) => {
      const signer = new ethers.Wallet(config.privateKey, provider)
      const entryPoint = new ethers.Contract(
        config.entryPoint,
        ['function handleOps(tuple(address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)[] ops, address payable beneficiary)'],
        signer,
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
        signer.address,
      )

      return tx.hash
    },

    waitForTx: async (txHash: string) => {
      const receipt = await provider.waitForTransaction(txHash, 1, 120000)
      return { status: receipt?.status ?? 0 }
    },

    getGasPrice: async () => {
      const feeData = await provider.getFeeData()
      return {
        maxFeePerGas: feeData.maxFeePerGas ?? 1000000n,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 1000000n,
      }
    },
  }
}

/**
 * Shield tokens from EOA into Railgun privacy pool.
 *
 * This is the onboarding step — deposits public tokens into the
 * privacy pool so they can be used for private operations.
 *
 * @returns Shield tx hash and derived railgun address
 */
export async function shieldTokens(params: {
  privateKey: string
  tokenAddress: string
  amount: bigint
  chainId: number
  rpcUrl: string
  railgunRelay: string
  onProgress?: (msg: string) => void
}): Promise<{ txHash: string; railgunAddress: string }> {
  const { privateKey, tokenAddress, amount, chainId, rpcUrl, railgunRelay, onProgress } = params
  const log = onProgress ?? console.log

  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const signer = new ethers.Wallet(privateKey, provider)
  const signerAddress = signer.address

  // Step 1: Derive Railgun keys and address
  log('[shield] Deriving Railgun keys...')
  const signature = await signer.signMessage(B402_UNIFIED_MESSAGE)
  const keys = await deriveRailgunKeys(signature)
  const railgunAddress = getRailgunAddress(keys)
  log(`[shield] Railgun address: ${railgunAddress}`)

  // Step 2: Check balance
  const token = new ethers.Contract(
    tokenAddress,
    ['function balanceOf(address) view returns (uint256)', 'function approve(address, uint256) returns (bool)', 'function allowance(address, address) view returns (uint256)', 'function decimals() view returns (uint8)'],
    signer,
  )

  const balance = await token.balanceOf(signerAddress)
  if (balance < amount) {
    throw new Error(`Insufficient balance: have ${balance}, need ${amount}`)
  }

  // Step 3: Approve Railgun contract
  const allowance = await token.allowance(signerAddress, railgunRelay)
  if (allowance < amount) {
    log('[shield] Approving Railgun contract...')
    const approveTx = await token.approve(railgunRelay, ethers.MaxUint256)
    await approveTx.wait()
    log('[shield] Approved.')
  }

  // Step 4: Initialize Railgun SDK and build shield calldata
  log('[shield] Initializing Railgun SDK...')
  const sdkWallet = await import('@railgun-community/wallet')
  const { MemoryLevel } = await import('memory-level')
  const sharedModels = await import('@railgun-community/shared-models') as any

  const db = new MemoryLevel()
  const storage = new Map<string, string | Buffer>()
  const artifactStore = new sdkWallet.ArtifactStore(
    async (p: string) => { const i = storage.get(p); if (!i) throw new Error('NF'); return i },
    async (_d: string, p: string, i: string | Uint8Array) => { storage.set(p, typeof i === 'string' ? i : Buffer.from(i)) },
    async (p: string) => storage.has(p),
  )

  await sdkWallet.startRailgunEngine(
    'b402worker',
    db,
    false,        // shouldDebug
    artifactStore,
    false,        // useNativeArtifacts
    true,         // skipMerkletreeScans — shield only needs populateShield, not full tree
    ['https://ppoi-agg.horsewithsixlegs.xyz'],
    [],
    false,
  )

  try {
    // The patch adds NetworkName["Base"] = "Base_Mainnet", so the KEY is "Base"
    const networkName = sharedModels.NetworkName?.Base ?? 'Base_Mainnet'
    await sdkWallet.loadProvider({
      chainId,
      providers: [
        { provider: rpcUrl, priority: 1, weight: 1, stallTimeout: 2500 },
        { provider: rpcUrl, priority: 2, weight: 1, stallTimeout: 2500 },
      ],
    }, networkName, 60000)

    // Generate random shield private key
    const shieldPrivateKey = ethers.hexlify(ethers.randomBytes(32))
    const txidVersion = sharedModels.TXIDVersion?.V2_PoseidonMerkle ?? 'V2_PoseidonMerkle'

    log('[shield] Building shield transaction...')
    const { transaction } = await sdkWallet.populateShield(
      txidVersion,
      networkName,
      shieldPrivateKey,
      [{ tokenAddress, amount, recipientAddress: railgunAddress }],
      [],
    )

    if (!transaction) throw new Error('populateShield returned null')

    // Step 5: Send shield transaction
    log('[shield] Sending shield transaction...')
    const tx = await signer.sendTransaction({
      to: railgunRelay,
      data: transaction.data as string,
      value: transaction.value ? BigInt(transaction.value as any) : 0n,
      gasLimit: 1_200_000n,
    })

    log(`[shield] TX sent: ${tx.hash}`)
    const receipt = await tx.wait()

    if (!receipt || receipt.status === 0) {
      throw new Error(`Shield TX reverted: ${tx.hash}`)
    }

    log(`[shield] Confirmed in block ${receipt.blockNumber}`)
    return { txHash: receipt.hash, railgunAddress }
  } finally {
    await sdkWallet.stopRailgunEngine()
  }
}

/**
 * Wait for the backend to index a shield commitment.
 * Polls every 5 seconds for up to maxWaitMs.
 */
export async function waitForShieldIndexing(params: {
  privateKey: string
  tokenAddress: string
  expectedAmount: bigint
  chainId: number
  maxWaitMs?: number
  onProgress?: (msg: string) => void
}): Promise<boolean> {
  const { privateKey, tokenAddress, expectedAmount, chainId, maxWaitMs = 150000, onProgress } = params
  const log = onProgress ?? console.log

  const wallet = new ethers.Wallet(privateKey)
  const signature = await wallet.signMessage(B402_UNIFIED_MESSAGE)
  const keys = await deriveRailgunKeys(signature)

  log('[indexing] Waiting for backend to index shield...')

  const startTime = Date.now()
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const utxos = await fetchSpendableUTXOsLightweight(
        wallet.address,
        keys.viewingKeyPair.privateKey,
        keys.masterPublicKey,
        keys.nullifyingKey,
        tokenAddress,
        chainId,
      )

      const match = utxos.find((u: any) => u.note.value >= expectedAmount)
      if (match) {
        log(`[indexing] Shield indexed! Found UTXO with value ${match.note.value}`)
        return true
      }

      const elapsed = Math.floor((Date.now() - startTime) / 1000)
      log(`[indexing] Not yet indexed... (${elapsed}s elapsed, checking again in 5s)`)
    } catch (err) {
      // Retry on error
      const elapsed = Math.floor((Date.now() - startTime) / 1000)
      log(`[indexing] Error polling (${elapsed}s): ${err instanceof Error ? err.message : err}`)
    }

    await new Promise(r => setTimeout(r, 5000))
  }

  log('[indexing] Timed out waiting for indexing')
  return false
}
