/**
 * Private Swap Recipe — Full pipeline: unshield → approve → swap
 *
 * Orchestrates the complete private swap:
 *   1. Derive Railgun keys
 *   2. Fetch spendable UTXOs → check balance
 *   3. Get swap quote (0x → Aerodrome fallback)
 *   4. Calculate unshield amount
 *   5. Generate ZK proof (client-side Groth16)
 *   6. Build 3-call multicall: [unshield, approve, swap]
 *   7. Build UserOp with paymaster signature
 *   8. Sign UserOp with owner key
 *   9. Submit to EntryPoint
 *  10. Wait for confirmation
 *  11. Return structured receipt
 */

import { ethers } from 'ethers'
import { BaseRecipe, type RecipeContext } from './base-recipe'
import { buildPrivateSwapCalls } from '../swap/swap-builder'
import { buildBatchCallData } from '../wallet/batch-calldata'
import { buildUserOp, computeUserOpHash, signPaymaster } from '../wallet/userop-builder'
import { buildInitCode } from '../wallet/wallet-factory'
import { calculateUnshieldAmount, calculateNetAfterUnshieldFee } from '../swap/fee-calculator'
import type {
  ExecutionReceipt,
  RecipeConfig,
  SwapRecipeConfig,
  SwapQuote,
  WorkerConfig,
} from '../types'
import { BASE_TOKENS, RAILGUN_UNSHIELD_FEE_BPS } from '../types'

// Privacy lib imports (from cross-chain-atomic-routing via path aliases)
// These will resolve at runtime via tsconfig paths
type PrivacyModules = {
  deriveRailgunKeys: (signature: string) => Promise<any>
  fetchSpendableUTXOs: (...args: any[]) => Promise<any[]>
  getSpendableBalance: (utxos: any[], tokenAddress: string) => bigint
  selectUTXOsForAmount: (utxos: any[], amount: bigint, tokenAddress: string) => any[]
  buildPartialUnshieldProofInputs: (params: any) => any
  generateProofClientSide: (params: any) => Promise<any>
  buildUnshieldTransaction: (params: any) => { to: string; data: string }
}

export interface SwapDependencies {
  /** Get swap quote from a provider */
  getQuote: (params: {
    sellToken: string
    buyToken: string
    sellAmount: bigint
    taker: string
    slippageBps: number
  }) => Promise<SwapQuote>

  /** Derive Railgun keys from owner signature */
  deriveKeys: (privateKey: string) => Promise<{
    viewingKeyPair: { privateKey: Uint8Array }
    spendingKeyPair: { privateKey: Uint8Array; pubkey: bigint[] }
    nullifyingKey: bigint
    masterPublicKey: bigint
  }>

  /** Fetch spendable UTXOs */
  fetchUTXOs: (
    signerAddress: string,
    viewingPrivateKey: Uint8Array,
    masterPublicKey: bigint,
    nullifyingKey: bigint,
    tokenAddress: string,
    chainId: number,
  ) => Promise<any[]>

  /** Get total spendable balance for a token */
  getBalance: (utxos: any[], tokenAddress: string) => bigint

  /** Select UTXOs for a given amount */
  selectUTXOs: (utxos: any[], amount: bigint, tokenAddress: string) => any[]

  /** Build ZK proof inputs for unshield */
  buildProofInputs: (params: any) => any

  /** Generate ZK proof */
  generateProof: (params: any) => Promise<any>

  /** Build unshield transaction calldata */
  buildUnshieldTx: (params: any) => { to: string; data: string }

  /** Get nonce for sender from EntryPoint */
  getNonce: (sender: string) => Promise<bigint>

  /** Submit UserOp to bundler/EntryPoint */
  submitUserOp: (userOp: any) => Promise<string>

  /** Wait for transaction confirmation */
  waitForTx: (txHash: string) => Promise<{ status: number }>

  /** Get current gas price */
  getGasPrice: () => Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
}

function resolveTokenAddress(symbol: string): string {
  const token = BASE_TOKENS[symbol as keyof typeof BASE_TOKENS]
  if (!token) throw new Error(`Unknown token: ${symbol}`)
  return token.address
}

function resolveTokenDecimals(symbol: string): number {
  const token = BASE_TOKENS[symbol as keyof typeof BASE_TOKENS]
  if (!token) throw new Error(`Unknown token: ${symbol}`)
  return token.decimals
}

export class PrivateSwapRecipe extends BaseRecipe {
  readonly name = 'private-swap'

  constructor(private readonly deps: SwapDependencies) {
    super()
  }

  async execute(
    recipeConfig: RecipeConfig,
    context: RecipeContext,
  ): Promise<ExecutionReceipt> {
    const startTime = Date.now()
    const { config: workerConfig } = context
    const receiptId = `r-${workerConfig.workerId}-${Date.now()}`

    try {
      if (recipeConfig.type !== 'swap') {
        throw new Error(`PrivateSwapRecipe received wrong config type: ${recipeConfig.type}`)
      }

      const config = recipeConfig as SwapRecipeConfig
      const { smartWalletAddress, nonce, isWalletDeployed } = context

      const tokenInAddress = resolveTokenAddress(config.tokenIn)
      const tokenOutAddress = resolveTokenAddress(config.tokenOut)
      const tokenInDecimals = resolveTokenDecimals(config.tokenIn)

      // Parse human-readable amount to wei
      const desiredSwapAmount = ethers.parseUnits(config.amount, tokenInDecimals)

      // Step 1: Derive Railgun keys
      const keys = await this.deps.deriveKeys(workerConfig.privateKey)

      // Step 2: Fetch spendable UTXOs
      const ownerEOA = new ethers.Wallet(workerConfig.privateKey).address
      const utxos = await this.deps.fetchUTXOs(
        ownerEOA,
        keys.viewingKeyPair.privateKey,
        keys.masterPublicKey,
        keys.nullifyingKey,
        tokenInAddress,
        workerConfig.chainId,
      )

      // Check shielded balance
      const balance = this.deps.getBalance(utxos, tokenInAddress)
      const unshieldGross = calculateUnshieldAmount(desiredSwapAmount, RAILGUN_UNSHIELD_FEE_BPS)

      if (balance < unshieldGross) {
        throw new Error(
          `Insufficient shielded balance: have ${ethers.formatUnits(balance, tokenInDecimals)} ${config.tokenIn}, need ${ethers.formatUnits(unshieldGross, tokenInDecimals)}`,
        )
      }

      // Step 3: Get swap quote
      const netAmount = calculateNetAfterUnshieldFee(unshieldGross, RAILGUN_UNSHIELD_FEE_BPS)
      const quote = await this.deps.getQuote({
        sellToken: tokenInAddress,
        buyToken: tokenOutAddress,
        sellAmount: netAmount,
        taker: smartWalletAddress,
        slippageBps: config.slippageBps,
      })

      // Step 4: Select UTXO and build proof inputs
      const selectedUTXOs = this.deps.selectUTXOs(utxos, unshieldGross, tokenInAddress)
      if (selectedUTXOs.length === 0) {
        throw new Error('No UTXOs available for the requested amount')
      }

      // Use the first selected UTXO (01x01 circuit for full unshield, 01x02 for partial)
      const utxo = selectedUTXOs[0]
      const proofInputs = this.deps.buildProofInputs({
        utxo,
        nullifyingKey: keys.nullifyingKey,
        spendingKeyPair: keys.spendingKeyPair,
        unshieldAmount: unshieldGross,
        recipientAddress: smartWalletAddress,
        tokenAddress: tokenInAddress,
      })

      // Step 5: Generate ZK proof
      const proofResult = await this.deps.generateProof({
        ...proofInputs,
        spendingPrivateKey: keys.spendingKeyPair.privateKey,
        chainId: workerConfig.chainId,
        treeNumber: utxo.tree,
      })

      // Step 6: Build unshield transaction calldata
      const unshieldTx = this.deps.buildUnshieldTx({
        proofResult,
        treeNumber: utxo.tree,
        tokenAddress: tokenInAddress,
        recipientAddress: smartWalletAddress,
        unshieldAmount: unshieldGross,
        chainId: workerConfig.chainId,
      })

      // Step 7: Build 3-call multicall: [unshield, approve, swap]
      const calls = buildPrivateSwapCalls({
        unshieldCalldata: unshieldTx.data,
        railgunRelay: workerConfig.railgunRelay,
        tokenIn: tokenInAddress,
        netAmountAfterFee: netAmount,
        swapQuote: quote,
      })

      const callData = buildBatchCallData(calls)

      // Step 8: Build UserOp
      const gasPrice = await this.deps.getGasPrice()

      const initCode = isWalletDeployed ? '0x' : buildInitCode(null) // TODO: pass wallet params for first deploy
      const userOp = buildUserOp({
        sender: smartWalletAddress,
        nonce,
        initCode,
        callData,
        ...gasPrice,
      })

      // Step 9: Sign with paymaster
      const { paymasterAndData } = signPaymaster(
        userOp,
        workerConfig.paymasterSignerKey,
        workerConfig.chainId,
      )
      userOp.paymasterAndData = paymasterAndData

      // Compute hash and sign with owner
      const userOpHash = computeUserOpHash(userOp, workerConfig.chainId)
      const ownerWallet = new ethers.Wallet(workerConfig.privateKey)
      userOp.signature = ownerWallet.signMessageSync(ethers.getBytes(userOpHash))

      // Step 10: Submit UserOp
      const txHash = await this.deps.submitUserOp(userOp)

      // Step 11: Wait for confirmation
      const receipt = await this.deps.waitForTx(txHash)

      const duration = Date.now() - startTime
      const railgunFee = unshieldGross - netAmount

      return {
        receiptId,
        workerId: workerConfig.workerId,
        recipeType: 'swap',
        timestamp: Date.now(),
        tokenIn: config.tokenIn,
        tokenOut: config.tokenOut,
        amountIn: config.amount,
        amountOut: ethers.formatUnits(quote.buyAmount, resolveTokenDecimals(config.tokenOut)),
        txHashes: {
          userOp: txHash,
        },
        fees: {
          railgunFee: ethers.formatUnits(railgunFee, tokenInDecimals),
          gasCost: '0.00', // Paymaster covers gas
          b402Fee: '0.00', // TODO: calculate B402 fee
        },
        policy: {
          policyHash: '0x0', // TODO: compute from policy engine
          withinLimits: true,
        },
        status: receipt.status === 1 ? 'success' : 'failed',
        duration,
      }
    } catch (error) {
      const duration = Date.now() - startTime
      const swapCfg = recipeConfig.type === 'swap' ? recipeConfig as SwapRecipeConfig : null
      return {
        receiptId,
        workerId: workerConfig.workerId,
        recipeType: 'swap',
        timestamp: Date.now(),
        tokenIn: swapCfg?.tokenIn ?? 'unknown',
        tokenOut: swapCfg?.tokenOut ?? 'unknown',
        amountIn: swapCfg?.amount ?? '0',
        amountOut: '0',
        txHashes: {},
        fees: {
          railgunFee: '0',
          gasCost: '0',
          b402Fee: '0',
        },
        policy: {
          policyHash: '0x0',
          withinLimits: true,
        },
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        duration,
      }
    }
  }
}
