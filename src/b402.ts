/**
 * @b402ai/sdk — Private DeFi execution for agents
 *
 * Usage:
 *   import { B402 } from '@b402ai/sdk'
 *
 *   const b402 = new B402({ privateKey: '0x...' })
 *
 *   await b402.swap({ from: 'USDC', to: 'WETH', amount: '10' })
 *   await b402.lend({ token: 'USDC', amount: '100', vault: 'steakhouse' })
 *   await b402.redeem({ vault: 'steakhouse' })
 *   const info = await b402.status()
 *
 * Gasless — b402 facilitator handles gas. User only needs a private key.
 */

import { ethers } from 'ethers'
import { isWalletDeployed } from './wallet/wallet-factory'
import { MORPHO_VAULTS, MORPHO_VAULTS_BY_CHAIN, getMorphoVaults, resolveVault, ERC4626_INTERFACE } from './lend/morpho-vaults'
import { AERODROME_POOLS } from './lp/aerodrome-pools'
import { PERPS_MARKETS } from './trade/synthetix-perps'
import { BASE_TOKENS, BASE_CONTRACTS } from './types'
import {
  B402_CHAINS,
  getContractsForChain,
  getRailgunNetworkName,
  getRelayAdaptAddress,
  type ChainContracts,
} from './config/chains'

// ── Constants ──────────────────────────────────────────────────────────
const DEFAULT_RPC = process.env.BASE_RPC_URL || 'https://base-mainnet.g.alchemy.com/v2/CygH7Y6PEyNCuKF6NFcG6DxYRXqI4zE2'
const DEFAULT_FACILITATOR = 'https://b402-facilitator-base-62092339396.us-central1.run.app'
const INCOGNITO_MESSAGE = 'b402 Incognito EOA Derivation'
const SALT_PREFIX = 'b402-incognito'

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
]

// ── Types ──────────────────────────────────────────────────────────────

export interface B402Config {
  /** Operator private key — derives anonymous smart wallet. Provide this OR signer. */
  privateKey?: string
  /** Ethers signer — alternative to privateKey. Any signer that can signMessage(). */
  signer?: ethers.Signer
  /** 0x API key for swap quotes (required for swap only) */
  zeroXApiKey?: string
  /** Chain ID (default: 8453 / Base). Supported: 8453 (Base), 56 (BSC), 42161 (Arbitrum). */
  chainId?: number
  /** RPC URL (default: chain-specific RPC from B402_CHAINS) */
  rpcUrl?: string
  /** b402 facilitator URL (default: production) */
  facilitatorUrl?: string
  /**
   * Backend API URL for UTXO/merkle-proof queries.
   * Resolution order: this option → env `B402_BACKEND_API_URL` /
   * `{BASE,BSC,ARB}_BACKEND_API_URL` → chain-specific production default.
   * Use to point at a replica or self-hosted indexer.
   */
  backendApiUrl?: string
  /** Progress callback — receives step updates */
  onProgress?: (event: ProgressEvent) => void
}

export interface ProgressEvent {
  type: 'step' | 'done' | 'info'
  step?: number
  totalSteps?: number
  title: string
  message: string
}

export interface SwapParams {
  from: string
  to: string
  amount: string
  slippageBps?: number
}

export interface SwapResult {
  txHash: string
  amountIn: string
  amountOut: string
  tokenIn: string
  tokenOut: string
}

export interface LendParams {
  token: string
  amount: string
  vault?: string
}

export interface LendResult {
  txHash: string
  amount: string
  vault: string
}

export interface RedeemParams {
  vault?: string
  shares?: string
}

export interface RedeemResult {
  txHash: string
  assetsReceived: string
  vault: string
}

export interface UnshieldParams {
  /** Token to unshield from privacy pool (USDC, WETH, DAI) */
  token: string
  /** Amount to unshield (human-readable) */
  amount: string
  /** Recipient address. If provided, unshields directly to this address instead of smart wallet. */
  to?: string
}

export interface UnshieldResult {
  txHash: string
  /** Time spent generating ZK proof in seconds */
  proofTimeSeconds: number
}

export interface FundIncognitoParams {
  /** Token to fund with (default: USDC) */
  token: string
  /** Amount to unshield to incognito EOA (human-readable, e.g. '5.00') */
  amount: string
}

export interface FundIncognitoResult {
  /** On-chain transaction hash */
  txHash: string
  /** Time spent generating ZK proof */
  proofTimeSeconds: number
  /** Amount funded (human-readable) */
  amount: string
  /** Incognito EOA address that received the tokens */
  incognitoAddress: string
}

export interface ShieldParams {
  token: string
  amount: string
  /**
   * Optional — pull USDC from this address (EOA or smart wallet) instead of master EOA.
   * When set, `auth` must also be provided. Used for "shield on behalf of buyer" flows
   * (e.g. ACP private_transfer) where the buyer signs an EIP-3009 authorization off-chain
   * and the seller atomically submits pull+shield as one b402-facilitator-sponsored userOp.
   */
  from?: string
  /**
   * Optional — pre-signed EIP-3009 TransferWithAuthorization payload from `from`
   * authorizing transfer to the b402 shield wallet. Required when `from` is set.
   */
  auth?: {
    validAfter: number
    validBefore: number
    nonce: string
    v: number
    r: string
    s: string
  }
}

export interface ShieldResult {
  txHash: string
  indexed: boolean
}

export interface StatusResult {
  ownerEOA: string
  smartWallet: string
  deployed: boolean
  /** Chain name e.g. "base", "arbitrum", "bsc" */
  chain: string
  /** Chain ID (8453 = Base, 42161 = Arbitrum, 56 = BSC) */
  chainId: number
  balances: { token: string; balance: string }[]
  shieldedBalances: { token: string; balance: string }[]
  positions: { vault: string; shares: string; assets: string; apyEstimate: string; tvl?: string }[]
  lpPositions: LPPosition[]
}

export interface ConsolidateResult {
  /** Final shield TX hash */
  txHash: string
  /** Number of UTXOs consumed */
  utxosConsumed: number
  /** Total amount consolidated (human-readable) */
  amount: string
}

export interface RebalanceResult {
  action: 'rebalanced' | 'no-change'
  currentVault?: string
  bestVault?: string
  txHash?: string
}

export interface PrivateSwapParams {
  /** Token to swap from (symbol or address) */
  from: string
  /** Token to swap to (symbol or address) */
  to: string
  /** Amount to swap (human-readable) */
  amount: string
  /** Slippage tolerance in basis points (default 50 = 0.5%) */
  slippageBps?: number
}

export interface PrivateSwapResult {
  txHash: string
  amountIn: string
  amountOut: string
  tokenIn: string
  tokenOut: string
}

export interface PrivateLendParams {
  /** Token to deposit (default: USDC) */
  token?: string
  /** Amount to deposit (human-readable) */
  amount: string
  /** Vault name or address (default: steakhouse) */
  vault?: string
}

export interface PrivateLendResult {
  txHash: string
  amount: string
  vault: string
}

export interface PrivateRedeemParams {
  /** Vault name or address (default: steakhouse) */
  vault?: string
  /** Shares to redeem (human-readable). Omit to redeem all. */
  shares?: string
}

export interface PrivateRedeemResult {
  txHash: string
  assetsReceived: string
  vault: string
}

export interface PrivateCrossChainParams {
  /** Destination chain (ID or alias: 'arbitrum', 'base', 'bsc') */
  toChain: number | string
  /** Source token (symbol or address) on current chain */
  fromToken: string
  /** Destination token (symbol or address); same as fromToken for pure bridge */
  toToken: string
  /** Amount to send (human-readable, in fromToken decimals) */
  amount: string
  /** Destination recipient address (EOA on destination chain). Funds land here; user shields later with b402.shieldFromEOA on dest chain. */
  destinationAddress: string
  /** Slippage tolerance in basis points (default 50 = 0.5%) */
  slippageBps?: number
  /** Optional LI.FI API key (higher rate limit) */
  lifiApiKey?: string
}

export interface PrivateCrossChainResult {
  txHash: string
  tool: string
  fromChain: string
  toChain: string
  fromToken: string
  toToken: string
  amountIn: string
  /** Expected amount arriving on destination (after fees + slippage floor) */
  expectedAmountOut: string
  minAmountOut: string
  destinationAddress: string
  estimatedDurationSec: number
}

// ── LP Types ──────────────────────────────────────────────────────────

export interface AddLiquidityParams {
  /** Pool name (default: 'weth-usdc') */
  pool?: string
  /** Amount in USDC terms — SDK splits and swaps half automatically */
  amount: string
  /** Slippage tolerance in basis points (default: 300 = 3%) */
  slippageBps?: number
}

export interface AddLiquidityResult {
  txHash: string
  amount: string
  pool: string
}

export interface RemoveLiquidityParams {
  pool?: string
  slippageBps?: number
}

export interface RemoveLiquidityResult {
  txHash: string
  pool: string
  amountWETH: string
  amountUSDC: string
}

export interface ClaimRewardsParams {
  pool?: string
}

export interface ClaimRewardsResult {
  txHash: string
  pool: string
}

export interface LPPosition {
  pool: string
  lpTokens: string
  staked: boolean
  usdValue: string
  pendingRewards: string
  apyEstimate: string
  tvl?: string
}

// ── Trading types ─────────────────────────────────────────────────────

export interface SpeedMarketParams {
  /** Asset to bet on: ETH or BTC */
  asset: string
  /** Price direction: 'up' or 'down' */
  direction: 'up' | 'down'
  /** Bet amount in USDC (min $5, max $200) */
  amount: string
  /** Duration: '10m', '30m', '1h', '4h' (default: '10m') */
  duration?: string
}

export interface SpeedMarketResult {
  txHash: string
  asset: string
  direction: string
  amount: string
  strikeTime: number
  duration: string
}

export interface OpenPerpParams {
  /** Market: ETH, BTC, SOL, DOGE, etc. */
  market: string
  /** Long or short */
  side: 'long' | 'short'
  /** Position size in base asset (e.g. '0.1' = 0.1 ETH) */
  size: string
  /** USDC margin to deposit */
  margin: string
  /** Slippage tolerance in basis points (default: 100 = 1%) */
  slippageBps?: number
}

export interface OpenPerpResult {
  txHash: string
  market: string
  side: string
  size: string
  margin: string
}

export interface ClosePerpParams {
  /** Market to close position in */
  market: string
  /** Synthetix perps account ID */
  accountId: string
  /** Slippage in basis points (default: 100) */
  slippageBps?: number
}

export interface ClosePerpResult {
  txHash: string
  market: string
}

export interface SynFuturesTradeParams {
  /** Instrument: LINK, PYTH, EMG, DEXV2, or contract address */
  instrument: string
  /** Long or short */
  side: 'long' | 'short'
  /** Trade size in USDC notional (e.g. '20' = $20 notional) */
  notional: string
  /** USDC margin to deposit (e.g. '10' for ~2x leverage) */
  margin: string
  /** Slippage in basis points (default: 300 = 3%) */
  slippageBps?: number
}

export interface SynFuturesTradeResult {
  txHash: string
  instrument: string
  side: string
  notional: string
  margin: string
  size: string
  priceUsd: string
}

export interface SynFuturesCloseParams {
  /** Instrument to close position in */
  instrument: string
  /** Whether to also withdraw margin from Gate (default: true) */
  withdrawMargin?: boolean
}

export interface SynFuturesCloseResult {
  txHash: string
  instrument: string
}

// ── Call type (public — used by transact()) ───────────────────────────

export interface Call {
  /** Contract address to call */
  to: string
  /** ETH value in wei (use '0' for non-payable calls) */
  value: string
  /** ABI-encoded calldata */
  data: string
}

// ── Internal types ─────────────────────────────────────────────────────

interface VerifyResponse {
  isValid: boolean
  userOp?: Record<string, string>
  userOpHash?: string
  needsDeployment?: boolean
  invalidReason?: string
}

interface SettleResponse {
  success: boolean
  userOpHash?: string
  txHash?: string
  errorReason?: string
}

// ── Fallback APY estimates (used when Morpho API is unreachable) ──────
const FALLBACK_APY: Record<string, { range: string; mid: number }> = {
  steakhouse: { range: '3-4%', mid: 3.5 },
  moonwell: { range: '3-4%', mid: 3.8 },
  gauntlet: { range: '3-4%', mid: 3.5 },
  'steakhouse-hy': { range: '3-4%', mid: 3.5 },
}

// ── B402 SDK ───────────────────────────────────────────────────────────

export class B402 {
  private config: B402Config
  private provider: ethers.JsonRpcProvider
  private facilitatorUrl: string

  /** Active chain ID (8453 = Base, 56 = BSC, 42161 = Arbitrum). */
  readonly chainId: number
  /** Resolved RPC URL (from config or chain default). */
  readonly rpcUrl: string
  /** Chain-specific contract addresses (Railgun relay, ERC-4337, paymaster). */
  readonly contracts: ChainContracts
  /** Railgun SDK network name for this chain (e.g. 'Base_Mainnet', 'Arbitrum'). */
  readonly railgunNetworkName: string
  /** Resolved backend API URL used for UTXO/merkle queries. */
  readonly backendApiUrl: string

  private incognitoKey!: string
  private incognitoWallet!: ethers.Wallet
  private incognitoEOA!: string
  private wallet!: string
  private salt!: string
  private _initialized = false

  constructor(config: B402Config) {
    if (!config.privateKey && !config.signer) throw new Error('privateKey or signer is required')
    this.config = config
    this.chainId = config.chainId ?? 8453
    if (!B402_CHAINS[this.chainId]) {
      throw new Error(
        `Unsupported chainId: ${this.chainId}. Supported: ${Object.keys(B402_CHAINS).join(', ')}`,
      )
    }
    this.rpcUrl = config.rpcUrl || B402_CHAINS[this.chainId].rpc
    this.contracts = getContractsForChain(this.chainId)
    this.railgunNetworkName = getRailgunNetworkName(this.chainId)
    this.provider = new ethers.JsonRpcProvider(this.rpcUrl)
    this.facilitatorUrl = config.facilitatorUrl || DEFAULT_FACILITATOR
    this.backendApiUrl = config.backendApiUrl || B402_CHAINS[this.chainId].backendApiUrl
    // Propagate to env so downstream modules that read env see it.
    // Constructor option wins over any pre-existing env value for this process.
    if (config.backendApiUrl) process.env.B402_BACKEND_API_URL = config.backendApiUrl
  }

  // ── Core: facilitator verify → sign → settle ──────────────────────

  private async submitUserOp(calls: Call[]): Promise<{ txHash: string }> {
    await this.init()

    // Step 1: Verify — facilitator builds UserOp + paymaster signature
    this.emit({ type: 'step', step: 1, totalSteps: 3, title: 'Building UserOp', message: 'Requesting UserOp from facilitator' })

    const verifyRes = await fetch(`${this.facilitatorUrl}/api/v1/wallet/incognito/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerEOA: this.incognitoEOA,
        walletAddress: this.wallet,
        salt: this.salt,
        calls,
      }),
    })

    if (!verifyRes.ok) {
      const text = await verifyRes.text()
      throw new Error(`Facilitator verify failed (${verifyRes.status}): ${text}`)
    }

    const verify = (await verifyRes.json()) as VerifyResponse
    if (!verify.isValid || !verify.userOp || !verify.userOpHash) {
      throw new Error(`UserOp rejected: ${verify.invalidReason || 'unknown'}`)
    }

    if (verify.needsDeployment) {
      this.emit({ type: 'info', title: 'Wallet', message: 'Will deploy smart wallet' })
    }

    // Step 2: Sign UserOp hash with incognito wallet
    this.emit({ type: 'step', step: 2, totalSteps: 3, title: 'Signing', message: 'Signing UserOp' })

    const signature = await this.incognitoWallet.signMessage(
      ethers.getBytes(verify.userOpHash)
    )
    const signedUserOp = { ...verify.userOp, signature }

    // Step 3: Settle — facilitator submits to bundler, relayer pays gas
    this.emit({ type: 'step', step: 3, totalSteps: 3, title: 'Submitting', message: 'Submitting to Base' })

    const settleRes = await fetch(`${this.facilitatorUrl}/api/v1/wallet/incognito/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userOp: signedUserOp }),
    })

    if (!settleRes.ok) {
      const text = await settleRes.text()
      throw new Error(`Facilitator settle failed (${settleRes.status}): ${text}`)
    }

    const settle = (await settleRes.json()) as SettleResponse
    if (!settle.success) {
      const detail = settle.userOpHash ? ` (userOpHash: ${settle.userOpHash})` : ''
      // Debug: dump the full UserOp so we can simulate offline
      if (process.env.B402_DEBUG_USEROP) {
        console.error('[b402] UserOp that failed:', JSON.stringify(signedUserOp, null, 2))
        console.error('[b402] chainId:', this.chainId)
        console.error('[b402] entryPoint:', this.contracts.ENTRY_POINT)
      }
      throw new Error(`Transaction failed: ${settle.errorReason || 'unknown'}${detail}`)
    }

    this.emit({ type: 'done', title: 'Confirmed', message: `TX: ${settle.txHash}` })
    return { txHash: settle.txHash! }
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Throw a clear error if the caller invokes a Base-only DeFi method from a
   * non-Base chain. Currently Morpho (lend/redeem), Aerodrome (LP/swap/rebalance),
   * 0x aggregator routing, and SynFutures are Base-only in this SDK.
   * Privacy primitives (shield/unshield/transact) are chain-aware and not gated here.
   */
  private requireBase(method: string): void {
    if (this.chainId !== 8453) {
      throw new Error(
        `${method}() is only supported on Base (chainId 8453). ` +
        `This instance is on chainId ${this.chainId}. ` +
        `Privacy operations (shield/unshield) work on all supported chains.`,
      )
    }
  }

  /** Swap tokens via 0x aggregator. Requires zeroXApiKey. Base only. */
  async swap(params: SwapParams): Promise<SwapResult> {
    this.requireBase('swap')
    if (!this.config.zeroXApiKey) throw new Error('zeroXApiKey required for swaps')
    const tokenIn = this.resolveToken(params.from)
    const tokenOut = this.resolveToken(params.to)
    await this.init()
    const amount = ethers.parseUnits(params.amount, tokenIn.decimals)
    const slippage = (params.slippageBps ?? 100) / 10000

    // Get 0x quote
    const url = new URL('https://base.api.0x.org/swap/v1/quote')
    url.searchParams.set('sellToken', tokenIn.address)
    url.searchParams.set('buyToken', tokenOut.address)
    url.searchParams.set('sellAmount', amount.toString())
    url.searchParams.set('takerAddress', this.wallet)
    url.searchParams.set('slippagePercentage', slippage.toString())

    const quoteRes = await fetch(url.toString(), {
      headers: { '0x-api-key': this.config.zeroXApiKey },
    })
    if (!quoteRes.ok) throw new Error(`0x quote failed: ${await quoteRes.text()}`)

    const quote = (await quoteRes.json()) as {
      to: string; data: string; value: string
      allowanceTarget: string; buyAmount: string
    }

    const erc20 = new ethers.Interface(ERC20_ABI)
    const calls: Call[] = [
      { to: tokenIn.address, value: '0', data: erc20.encodeFunctionData('approve', [quote.allowanceTarget, amount]) },
      { to: quote.to, value: quote.value || '0', data: quote.data },
    ]

    const result = await this.submitUserOp(calls)
    return {
      txHash: result.txHash,
      amountIn: params.amount,
      amountOut: ethers.formatUnits(quote.buyAmount, tokenOut.decimals),
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
    }
  }

  /** Deposit tokens into a Morpho ERC-4626 vault. Supported on Base + Arbitrum. */
  async lend(params: LendParams): Promise<LendResult> {
    const token = this.resolveToken(params.token)
    const vault = resolveVault(params.vault || 'steakhouse', this.chainId)
    await this.init()
    const amount = ethers.parseUnits(params.amount, token.decimals)

    const erc20 = new ethers.Interface(ERC20_ABI)
    const calls: Call[] = [
      { to: token.address, value: '0', data: erc20.encodeFunctionData('approve', [vault.address, amount]) },
      { to: vault.address, value: '0', data: ERC4626_INTERFACE.encodeFunctionData('deposit', [amount, this.wallet]) },
    ]

    const result = await this.submitUserOp(calls)
    return { txHash: result.txHash, amount: params.amount, vault: vault.name }
  }

  /** Withdraw from a Morpho vault. Omit shares to redeem all. Supported on Base + Arbitrum. */
  async redeem(params: RedeemParams = {}): Promise<RedeemResult> {
    const vault = resolveVault(params.vault || 'steakhouse', this.chainId)
    await this.init()
    const vaultContract = new ethers.Contract(vault.address, ERC4626_INTERFACE, this.provider)

    let shares: bigint
    if (params.shares) {
      shares = ethers.parseUnits(params.shares, vault.decimals)
    } else {
      shares = await vaultContract.balanceOf(this.wallet)
      if (shares === 0n) throw new Error(`No shares in ${vault.name}`)
    }

    const assets = await vaultContract.convertToAssets(shares)

    const calls: Call[] = [
      { to: vault.address, value: '0', data: ERC4626_INTERFACE.encodeFunctionData('redeem', [shares, this.wallet, this.wallet]) },
    ]

    const result = await this.submitUserOp(calls)
    return {
      txHash: result.txHash,
      assetsReceived: ethers.formatUnits(assets, 6),
      vault: vault.name,
    }
  }

  /** Execute arbitrary calls through the smart wallet. Gasless via facilitator. */
  async transact(calls: Call[]): Promise<{ txHash: string }> {
    if (!calls || calls.length === 0) throw new Error('calls array is required and must not be empty')
    return this.submitUserOp(calls)
  }

  /** Unshield tokens from Railgun privacy pool to smart wallet. Generates ZK proof client-side.
   *  Pass amount: 'all' to drain all UTXOs for this token. */
  async unshield(params: UnshieldParams): Promise<UnshieldResult> {
    const token = this.resolveToken(params.token)
    await this.init()

    // Lazy-import privacy libs (heavy deps)
    const { deriveRailgunKeys } = await import('./privacy/lib/key-derivation')
    const { fetchSpendableUTXOs } = await import('./privacy/lib/utxo-fetcher')
    const { buildUnshieldProofInputs, buildPartialUnshieldProofInputs } = await import('./privacy/lib/proof-inputs')
    const { generateProofClientSide } = await import('./privacy/lib/prover')
    const { buildUnshieldTransaction } = await import('./privacy/lib/transaction-formatter')
    const { calculateUnshieldAmount } = await import('./swap/fee-calculator')
    const { createChangeNoteCommitmentCiphertext, formatNoteRandomForEncryption } = await import('./privacy/lib/note-encryption')
    const { RAILGUN_UNSHIELD_FEE_BPS } = await import('./types')

    const chainId = this.chainId

    // Step 1: Derive Railgun keys from master key/signer
    this.emit({ type: 'step', step: 1, totalSteps: 4, title: 'Deriving keys', message: 'Deriving Railgun identity' })
    const masterSigner = this.config.signer ?? new ethers.Wallet(this.config.privateKey!)
    const signature = await masterSigner.signMessage(INCOGNITO_MESSAGE)
    const keys = await deriveRailgunKeys(signature)

    // Step 2: Fetch UTXOs
    this.emit({ type: 'step', step: 2, totalSteps: 4, title: 'Scanning pool', message: 'Fetching spendable UTXOs' })
    const masterEOA = await masterSigner.getAddress()

    const [swUtxos, eoaUtxos] = await Promise.all([
      fetchSpendableUTXOs(this.wallet, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, token.address, chainId).catch(() => []),
      fetchSpendableUTXOs(masterEOA, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, token.address, chainId).catch(() => []),
    ])

    // Deduplicate by position+tree
    const seen = new Set<string>()
    const utxos: typeof swUtxos = []
    for (const u of [...swUtxos, ...eoaUtxos]) {
      const key = `${u.tree}-${u.position}`
      if (!seen.has(key)) {
        seen.add(key)
        utxos.push(u)
      }
    }

    if (utxos.length === 0) {
      throw new Error(`No shielded balance for ${token.symbol}. Shield tokens first with b402.shield()`)
    }

    const tokenUTXOs = utxos
      .filter(u => u.note.tokenAddress.toLowerCase() === token.address.toLowerCase())
      .sort((a, b) => Number(b.note.value - a.note.value))

    if (tokenUTXOs.length === 0) {
      throw new Error(`Insufficient shielded balance for ${token.symbol}`)
    }

    // "all" mode: unshield every UTXO sequentially (full unshield each, no change notes)
    if (params.amount === 'all') {
      this.emit({ type: 'info', title: 'Unshield', message: `Draining ${tokenUTXOs.length} UTXOs` })
      let lastResult: UnshieldResult = { txHash: '', proofTimeSeconds: 0 }
      for (let i = 0; i < tokenUTXOs.length; i++) {
        const u = tokenUTXOs[i]
        const utxoHuman = ethers.formatUnits(u.note.value, token.decimals)
        this.emit({ type: 'info', title: `UTXO ${i + 1}/${tokenUTXOs.length}`, message: `${utxoHuman} ${token.symbol}` })
        lastResult = await this._unshieldSingleUTXO(u, keys, token, chainId, generateProofClientSide, buildUnshieldProofInputs, buildUnshieldTransaction)
      }
      return lastResult
    }

    const desiredAmount = ethers.parseUnits(params.amount, token.decimals)
    const unshieldGross = calculateUnshieldAmount(desiredAmount, RAILGUN_UNSHIELD_FEE_BPS)

    // Auto-consolidate if no single UTXO covers the amount
    let matchingUtxo = tokenUTXOs.find(u => u.note.value >= unshieldGross)
    if (!matchingUtxo && tokenUTXOs.length > 1) {
      const total = tokenUTXOs.reduce((s, u) => s + u.note.value, 0n)
      if (total >= unshieldGross) {
        this.emit({ type: 'info', title: 'Auto-consolidate', message: `No single UTXO covers amount. Merging ${tokenUTXOs.length} UTXOs first.` })
        await this.consolidate({ token: token.symbol.startsWith('0x') ? token.address : token.symbol })

        // Re-fetch after consolidation with retry
        for (let retry = 0; retry < 6; retry++) {
          if (retry > 0) {
            this.emit({ type: 'info', title: 'Indexing', message: `Waiting for consolidation... (${retry * 5}s)` })
            await new Promise(r => setTimeout(r, 5000))
          }
          const [sw2, eoa2] = await Promise.all([
            fetchSpendableUTXOs(this.wallet, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, token.address, chainId).catch(() => []),
            fetchSpendableUTXOs(masterEOA, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, token.address, chainId).catch(() => []),
          ])
          const seen2 = new Set<string>()
          const refreshed: typeof sw2 = []
          for (const u of [...sw2, ...eoa2]) {
            const k = `${u.tree}-${u.position}`
            if (!seen2.has(k)) { seen2.add(k); refreshed.push(u) }
          }
          matchingUtxo = refreshed
            .filter(u => u.note.tokenAddress.toLowerCase() === token.address.toLowerCase())
            .sort((a, b) => Number(b.note.value - a.note.value))
            .find(u => u.note.value >= unshieldGross)
          if (matchingUtxo) break
        }
        if (!matchingUtxo) throw new Error('Consolidation complete but UTXO not yet indexed. Try again in 30 seconds.')
      }
    }

    const utxo = matchingUtxo ?? tokenUTXOs[0]
    const utxoValue = BigInt(utxo.note.value)
    const isPartial = utxoValue > unshieldGross

    // Step 3: Build proof inputs and generate ZK proof
    this.emit({ type: 'step', step: 3, totalSteps: 4, title: 'ZK proof', message: 'Generating Groth16 proof (client-side)' })

    let proofInputs: any
    let outputCount: 1 | 2 = 1
    let commitmentCiphertext: any[] = []

    // Track change note info for storage after TX confirms
    let changeNoteInfo: { changeAmount: bigint; changeRandom: bigint } | null = null

    if (isPartial) {
      // Partial unshield: 01x02 circuit — creates change note
      const randomBytes = new Uint8Array(16)
      crypto.getRandomValues(randomBytes)
      const changeRandom = BigInt('0x' + Buffer.from(randomBytes).toString('hex'))
      const changeAmount = utxoValue - unshieldGross
      changeNoteInfo = { changeAmount, changeRandom }

      const partialResult = buildPartialUnshieldProofInputs({
        utxo,
        nullifyingKey: keys.nullifyingKey,
        spendingKeyPair: keys.spendingKeyPair,
        unshieldAmount: unshieldGross,
        changeAmount,
        recipientAddress: params.to || this.wallet,
        tokenAddress: token.address,
        changeMasterPublicKey: keys.masterPublicKey,
        changeRandom,
      })
      proofInputs = partialResult
      outputCount = 2

      this.emit({ type: 'info', title: 'Partial', message: `Unshielding ${params.amount}, keeping ${ethers.formatUnits(changeAmount, token.decimals)} ${token.symbol} as change` })

      const { ByteUtils, ByteLength } = await import('@railgun-community/engine')
      const tokenHash = ByteUtils.formatToByteLength(
        utxo.commitment.tokenAddress.toLowerCase(),
        ByteLength.UINT_256,
        false,
      )
      commitmentCiphertext = await createChangeNoteCommitmentCiphertext(
        formatNoteRandomForEncryption(changeRandom),
        changeAmount,
        tokenHash,
        keys.masterPublicKey,
        keys.viewingKeyPair,
      )
    } else {
      // Full unshield: 01x01 circuit
      proofInputs = buildUnshieldProofInputs({
        utxo,
        nullifyingKey: keys.nullifyingKey,
        spendingKeyPair: keys.spendingKeyPair,
        unshieldAmount: unshieldGross,
        recipientAddress: params.to || this.wallet,
        tokenAddress: token.address,
      })
    }

    const proofStart = Date.now()
    const proofResult = await generateProofClientSide({
      ...proofInputs,
      spendingPrivateKey: keys.spendingKeyPair.privateKey,
      chainId,
      treeNumber: utxo.tree,
      outputCount,
      commitmentCiphertext,
    })
    const proofTimeSeconds = (Date.now() - proofStart) / 1000
    this.emit({ type: 'info', title: 'Proof', message: `Generated in ${proofTimeSeconds.toFixed(1)}s` })

    // Step 4: Build unshield tx and execute via facilitator
    this.emit({ type: 'step', step: 4, totalSteps: 4, title: 'Executing', message: 'Submitting unshield transaction' })

    const unshieldTx = buildUnshieldTransaction({
      proofResult,
      treeNumber: utxo.tree,
      tokenAddress: token.address,
      recipientAddress: params.to || this.wallet,
      unshieldAmount: unshieldGross,
      chainId,
    })

    // The unshield tx is a single call to the Railgun relay contract
    const calls: Call[] = [
      { to: unshieldTx.to, value: '0', data: unshieldTx.data },
    ]

    const result = await this.submitUserOp(calls)

    // Store change note if this was a partial unshield
    if (changeNoteInfo && isPartial) {
      const { storeChangeNote } = await import('./privacy/lib/change-note-store')
      const masterEOA = await masterSigner.getAddress()
      const partialResult = buildPartialUnshieldProofInputs({
        utxo,
        nullifyingKey: keys.nullifyingKey,
        spendingKeyPair: keys.spendingKeyPair,
        unshieldAmount: unshieldGross,
        changeAmount: changeNoteInfo.changeAmount,
        recipientAddress: this.wallet,
        tokenAddress: token.address,
        changeMasterPublicKey: keys.masterPublicKey,
        changeRandom: changeNoteInfo.changeRandom,
      })

      // Extract position from Transact event in receipt
      let position: string | undefined
      let treeNumber: string | undefined
      try {
        const receipt = await this.provider.getTransactionReceipt(result.txHash)
        if (receipt?.logs) {
          const TRANSACT_TOPIC = '0x56a618cda1e34057b7f849a5792f6c8587a2dbe11c83d0254e72cb3daffda7d1'
          for (const log of receipt.logs) {
            if (log.topics[0] === TRANSACT_TOPIC && log.data.length >= 130) {
              treeNumber = BigInt('0x' + log.data.slice(2, 66)).toString()
              position = BigInt('0x' + log.data.slice(66, 130)).toString()
              break
            }
          }
        }
      } catch { /* best effort */ }

      storeChangeNote(masterEOA, {
        txHash: result.txHash,
        commitmentHash: partialResult.changeNote.commitment,
        value: partialResult.changeNote.value.toString(),
        random: partialResult.changeNote.random.toString(),
        npk: partialResult.changeNote.npk.toString(),
        tokenAddress: token.address,
        signerAddress: masterEOA,
        createdAt: Date.now(),
        position,
        treeNumber,
      })
      this.emit({ type: 'info', title: 'Change note', message: `Stored ${ethers.formatUnits(changeNoteInfo.changeAmount, token.decimals)} ${token.symbol} change note` })
    }

    return { txHash: result.txHash, proofTimeSeconds }
  }

  /** Unshield a single UTXO fully (no change note). Used by unshield('all'). */
  private async _unshieldSingleUTXO(
    utxo: any, keys: any, token: any, chainId: number,
    generateProofClientSide: any, buildUnshieldProofInputs: any, buildUnshieldTransaction: any,
  ): Promise<UnshieldResult> {
    const proofInputs = buildUnshieldProofInputs({
      utxo,
      nullifyingKey: keys.nullifyingKey,
      spendingKeyPair: keys.spendingKeyPair,
      unshieldAmount: utxo.note.value,
      recipientAddress: this.wallet,
      tokenAddress: token.address,
    })

    const proofStart = Date.now()
    const proofResult = await generateProofClientSide({
      ...proofInputs,
      spendingPrivateKey: keys.spendingKeyPair.privateKey,
      chainId,
      treeNumber: utxo.tree,
      outputCount: 1 as const,
    })
    const proofTimeSeconds = (Date.now() - proofStart) / 1000
    this.emit({ type: 'info', title: 'Proof', message: `Generated in ${proofTimeSeconds.toFixed(1)}s` })

    const unshieldTx = buildUnshieldTransaction({
      proofResult,
      treeNumber: utxo.tree,
      tokenAddress: token.address,
      recipientAddress: this.wallet,
      unshieldAmount: utxo.note.value,
      chainId,
    })

    const result = await this.submitUserOp([{ to: unshieldTx.to, value: '0', data: unshieldTx.data }])
    return { txHash: result.txHash, proofTimeSeconds }
  }

  // ── x402 Private Payments ──────────────────────────────────────────────

  /** Get the incognito EOA address (deterministic, anonymous, no on-chain link to master key).
   *  This address can sign EIP-3009 authorizations for x402 payments. */
  async getIncognitoAddress(): Promise<string> {
    await this.initIncognito()
    return this.incognitoEOA
  }

  /** Get the incognito ethers.Wallet for x402 signing.
   *  Has `address` and `signTypedData()` — exactly what x402 ClientEvmSigner needs. */
  async getIncognitoSigner(): Promise<ethers.Wallet> {
    await this.initIncognito()
    return this.incognitoWallet
  }

  /** Fund the incognito EOA from Railgun privacy pool via ZK proof.
   *  Unshields tokens directly to the incognito EOA (NOT the smart wallet).
   *  On-chain: Railgun Relay → Incognito EOA. No link to agent's real wallet.
   *  The funded incognito EOA can then sign x402 EIP-3009 payments. */
  async fundIncognito(params: FundIncognitoParams): Promise<FundIncognitoResult> {
    const token = this.resolveToken(params.token)
    const parsedAmount = parseFloat(params.amount)
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new Error('Amount must be greater than zero')
    }

    await this.init()

    // Lazy-import privacy libs (heavy deps)
    const { deriveRailgunKeys } = await import('./privacy/lib/key-derivation')
    const { fetchSpendableUTXOs } = await import('./privacy/lib/utxo-fetcher')
    const { buildUnshieldProofInputs, buildPartialUnshieldProofInputs } = await import('./privacy/lib/proof-inputs')
    const { generateProofClientSide } = await import('./privacy/lib/prover')
    const { buildUnshieldTransaction } = await import('./privacy/lib/transaction-formatter')
    const { calculateUnshieldAmount } = await import('./swap/fee-calculator')
    const { createChangeNoteCommitmentCiphertext, formatNoteRandomForEncryption } = await import('./privacy/lib/note-encryption')
    const { RAILGUN_UNSHIELD_FEE_BPS } = await import('./types')

    const chainId = this.chainId
    const recipientAddress = this.incognitoEOA  // KEY: unshield to incognito EOA, NOT smart wallet

    // Step 1: Derive Railgun keys
    this.emit({ type: 'step', step: 1, totalSteps: 4, title: 'Deriving keys', message: 'Deriving Railgun identity' })
    const masterSigner = this.config.signer ?? new ethers.Wallet(this.config.privateKey!)
    const signature = await masterSigner.signMessage(INCOGNITO_MESSAGE)
    const keys = await deriveRailgunKeys(signature)

    // Step 2: Fetch UTXOs
    this.emit({ type: 'step', step: 2, totalSteps: 4, title: 'Scanning pool', message: 'Fetching spendable UTXOs' })
    const masterEOA = await masterSigner.getAddress()
    const [swUtxos, eoaUtxos] = await Promise.all([
      fetchSpendableUTXOs(this.wallet, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, token.address, chainId).catch(() => []),
      fetchSpendableUTXOs(masterEOA, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, token.address, chainId).catch(() => []),
    ])

    // Deduplicate by position+tree
    const seen = new Set<string>()
    const utxos: typeof swUtxos = []
    for (const u of [...swUtxos, ...eoaUtxos]) {
      const key = `${u.tree}-${u.position}`
      if (!seen.has(key)) { seen.add(key); utxos.push(u) }
    }

    if (utxos.length === 0) {
      throw new Error(`No shielded balance for ${token.symbol}. Shield tokens first with b402.shield()`)
    }

    const tokenUTXOs = utxos
      .filter(u => u.note.tokenAddress.toLowerCase() === token.address.toLowerCase())
      .sort((a, b) => Number(b.note.value - a.note.value))

    if (tokenUTXOs.length === 0) {
      throw new Error(`Insufficient shielded balance for ${token.symbol}`)
    }

    const desiredAmount = ethers.parseUnits(params.amount, token.decimals)
    const unshieldGross = calculateUnshieldAmount(desiredAmount, RAILGUN_UNSHIELD_FEE_BPS)
    const utxo = tokenUTXOs.find(u => u.note.value >= unshieldGross) ?? tokenUTXOs[0]
    const utxoValue = BigInt(utxo.note.value)
    const isPartial = utxoValue > unshieldGross

    // Step 3: ZK proof
    this.emit({ type: 'step', step: 3, totalSteps: 4, title: 'ZK proof', message: 'Generating Groth16 proof (client-side)' })

    let proofInputs: any
    let outputCount: 1 | 2 = 1
    let commitmentCiphertext: any[] = []
    let changeNoteInfo: { changeAmount: bigint; changeRandom: bigint } | null = null

    if (isPartial) {
      const randomBytes = new Uint8Array(16)
      crypto.getRandomValues(randomBytes)
      const changeRandom = BigInt('0x' + Buffer.from(randomBytes).toString('hex'))
      const changeAmount = utxoValue - unshieldGross
      changeNoteInfo = { changeAmount, changeRandom }

      const partialResult = buildPartialUnshieldProofInputs({
        utxo,
        nullifyingKey: keys.nullifyingKey,
        spendingKeyPair: keys.spendingKeyPair,
        unshieldAmount: unshieldGross,
        changeAmount,
        recipientAddress,
        tokenAddress: token.address,
        changeMasterPublicKey: keys.masterPublicKey,
        changeRandom,
      })
      proofInputs = partialResult
      outputCount = 2

      this.emit({ type: 'info', title: 'Partial', message: `Funding ${params.amount}, keeping ${ethers.formatUnits(changeAmount, token.decimals)} ${token.symbol} as change` })

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
        utxo,
        nullifyingKey: keys.nullifyingKey,
        spendingKeyPair: keys.spendingKeyPair,
        unshieldAmount: unshieldGross,
        recipientAddress,
        tokenAddress: token.address,
      })
    }

    const proofStart = Date.now()
    const proofResult = await generateProofClientSide({
      ...proofInputs,
      spendingPrivateKey: keys.spendingKeyPair.privateKey,
      chainId,
      treeNumber: utxo.tree,
      outputCount,
      commitmentCiphertext,
    })
    const proofTimeSeconds = (Date.now() - proofStart) / 1000
    this.emit({ type: 'info', title: 'Proof', message: `Generated in ${proofTimeSeconds.toFixed(1)}s` })

    // Step 4: Execute via facilitator (gasless)
    this.emit({ type: 'step', step: 4, totalSteps: 4, title: 'Funding', message: `Sending ${params.amount} ${token.symbol} to incognito EOA` })

    const unshieldTx = buildUnshieldTransaction({
      proofResult,
      treeNumber: utxo.tree,
      tokenAddress: token.address,
      recipientAddress,
      unshieldAmount: unshieldGross,
      chainId,
    })

    const calls: Call[] = [{ to: unshieldTx.to, value: '0', data: unshieldTx.data }]
    const result = await this.submitUserOp(calls)

    // Store change note if partial (same logic as unshield)
    if (changeNoteInfo && isPartial) {
      const { storeChangeNote } = await import('./privacy/lib/change-note-store')
      const partialResult = buildPartialUnshieldProofInputs({
        utxo,
        nullifyingKey: keys.nullifyingKey,
        spendingKeyPair: keys.spendingKeyPair,
        unshieldAmount: unshieldGross,
        changeAmount: changeNoteInfo.changeAmount,
        recipientAddress,
        tokenAddress: token.address,
        changeMasterPublicKey: keys.masterPublicKey,
        changeRandom: changeNoteInfo.changeRandom,
      })

      let position: string | undefined
      let treeNumber: string | undefined
      try {
        const receipt = await this.provider.getTransactionReceipt(result.txHash)
        if (receipt?.logs) {
          const TRANSACT_TOPIC = '0x56a618cda1e34057b7f849a5792f6c8587a2dbe11c83d0254e72cb3daffda7d1'
          for (const log of receipt.logs) {
            if (log.topics[0] === TRANSACT_TOPIC && log.data.length >= 130) {
              treeNumber = BigInt('0x' + log.data.slice(2, 66)).toString()
              position = BigInt('0x' + log.data.slice(66, 130)).toString()
              break
            }
          }
        }
      } catch { /* best effort */ }

      storeChangeNote(masterEOA, {
        txHash: result.txHash,
        commitmentHash: partialResult.changeNote.commitment,
        value: partialResult.changeNote.value.toString(),
        random: partialResult.changeNote.random.toString(),
        npk: partialResult.changeNote.npk.toString(),
        tokenAddress: token.address,
        signerAddress: masterEOA,
        createdAt: Date.now(),
        position,
        treeNumber,
      })
      this.emit({ type: 'info', title: 'Change note', message: `Stored ${ethers.formatUnits(changeNoteInfo.changeAmount, token.decimals)} ${token.symbol} change note` })
    }

    this.emit({ type: 'done', title: 'Funded', message: `${params.amount} ${token.symbol} → ${recipientAddress}` })

    return {
      txHash: result.txHash,
      proofTimeSeconds,
      amount: params.amount,
      incognitoAddress: recipientAddress,
    }
  }

  /** Initialize only the incognito wallet derivation (no network call needed for smart wallet address). */
  private async initIncognito(): Promise<void> {
    if (this.incognitoWallet) return
    const masterSigner = this.config.signer ?? new ethers.Wallet(this.config.privateKey!)
    const sig = await masterSigner.signMessage(INCOGNITO_MESSAGE)
    this.incognitoKey = ethers.keccak256(sig)
    this.incognitoWallet = new ethers.Wallet(this.incognitoKey, this.provider)
    this.incognitoEOA = this.incognitoWallet.address
  }

  /**
   * Consolidate multiple shielded UTXOs into a single UTXO.
   *
   * When you shield tokens multiple times, each creates a separate UTXO.
   * Private operations use single-input ZK circuits, so they can only spend
   * one UTXO per proof. Consolidation merges all UTXOs into one large UTXO
   * so any private operation can access the full balance in a single proof.
   *
   * Flow: unshield all UTXOs → smart wallet → re-shield total as one UTXO.
   * The smart wallet is anonymous (derived from incognito key), so no identity leak.
   *
   * @param params - Token to consolidate (default: USDC)
   */
  async consolidate(params: { token?: string } = {}): Promise<ConsolidateResult> {
    const token = this.resolveToken(params.token || 'USDC')
    await this.init()

    // Step 1: Derive keys & fetch UTXOs
    this.emit({ type: 'step', step: 1, totalSteps: 5, title: 'Scanning', message: 'Fetching shielded UTXOs' })

    const { deriveRailgunKeys } = await import('./privacy/lib/key-derivation')
    const { fetchSpendableUTXOs } = await import('./privacy/lib/utxo-fetcher')
    const { buildUnshieldProofInputs } = await import('./privacy/lib/proof-inputs')
    const { generateProofClientSide } = await import('./privacy/lib/prover')
    const { buildUnshieldTransaction } = await import('./privacy/lib/transaction-formatter')

    const chainId = this.chainId
    const masterSigner = this.config.signer ?? new ethers.Wallet(this.config.privateKey!)
    const signature = await masterSigner.signMessage(INCOGNITO_MESSAGE)
    const keys = await deriveRailgunKeys(signature)
    const masterEOA = await masterSigner.getAddress()

    const [swUtxos, eoaUtxos, incognitoUtxos] = await Promise.all([
      fetchSpendableUTXOs(this.wallet, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, token.address, chainId).catch(() => []),
      fetchSpendableUTXOs(masterEOA, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, token.address, chainId).catch(() => []),
      fetchSpendableUTXOs(this.incognitoEOA, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, token.address, chainId).catch(() => []),
    ])

    // Deduplicate
    const seen = new Set<string>()
    const tokenUTXOs: typeof swUtxos = []
    for (const u of [...swUtxos, ...eoaUtxos, ...incognitoUtxos]) {
      const key = `${u.tree}-${u.position}`
      if (!seen.has(key) && u.note.tokenAddress.toLowerCase() === token.address.toLowerCase()) {
        seen.add(key)
        tokenUTXOs.push(u)
      }
    }

    if (tokenUTXOs.length <= 1) {
      const bal = tokenUTXOs.length === 1 ? ethers.formatUnits(tokenUTXOs[0].note.value, token.decimals) : '0'
      this.emit({ type: 'info', title: 'Skip', message: `Already consolidated (${tokenUTXOs.length} UTXO, ${bal} ${token.symbol})` })
      return { txHash: '', utxosConsumed: tokenUTXOs.length, amount: bal }
    }

    const totalValue = tokenUTXOs.reduce((sum, u) => sum + u.note.value, 0n)
    const totalHuman = ethers.formatUnits(totalValue, token.decimals)
    const count = tokenUTXOs.length

    this.emit({ type: 'info', title: 'Consolidate', message: `Merging ${count} UTXOs (${totalHuman} ${token.symbol}) into 1` })

    // Sort largest first
    tokenUTXOs.sort((a, b) => Number(b.note.value - a.note.value))

    // Step 2: Unshield each UTXO to smart wallet (sequential proofs)
    this.emit({ type: 'step', step: 2, totalSteps: 5, title: 'Unshielding', message: `Processing ${count} UTXOs` })

    for (let i = 0; i < tokenUTXOs.length; i++) {
      const u = tokenUTXOs[i]
      const utxoHuman = ethers.formatUnits(u.note.value, token.decimals)
      this.emit({ type: 'info', title: `UTXO ${i + 1}/${count}`, message: `Unshielding ${utxoHuman} ${token.symbol}` })

      await this._unshieldSingleUTXO(u, keys, token, chainId, generateProofClientSide, buildUnshieldProofInputs, buildUnshieldTransaction)
    }

    // Step 3: Check the total on smart wallet
    this.emit({ type: 'step', step: 3, totalSteps: 5, title: 'Verifying', message: 'Checking smart wallet balance' })

    const erc20 = new ethers.Contract(token.address, ['function balanceOf(address) view returns (uint256)'], this.provider)
    const walletBalance = await erc20.balanceOf(this.wallet)

    // Step 4: Re-shield the full balance as one UTXO
    this.emit({ type: 'step', step: 4, totalSteps: 5, title: 'Re-shielding', message: `Shielding ${ethers.formatUnits(walletBalance, token.decimals)} ${token.symbol}` })

    const shieldResult = await this.shield({ token: token.address, amount: ethers.formatUnits(walletBalance, token.decimals) })

    // Step 5: Done
    this.emit({ type: 'step', step: 5, totalSteps: 5, title: 'Done', message: `${count} UTXOs → 1 UTXO (${totalHuman} ${token.symbol})` })

    return {
      txHash: shieldResult.txHash,
      utxosConsumed: count,
      amount: totalHuman,
    }
  }

  /**
   * Deterministically derive the b402 shield wallet address (CREATE2 smart wallet
   * owned by the incognito EOA, distinct from the incognito wallet itself).
   *
   * External callers (e.g. an ACP buyer) need this address as the `to` field
   * when signing an EIP-3009 TransferWithAuthorization that will later be
   * consumed by `shieldFromEOA({ from, auth })`.
   */
  async computeShieldWallet(): Promise<{ address: string; salt: string }> {
    await this.init()
    const SHIELD_SALT_PREFIX = 'b402-shield'
    const salt = ethers.keccak256(ethers.toUtf8Bytes(`${SHIELD_SALT_PREFIX}-${this.incognitoEOA.toLowerCase()}`))
    const saltBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(salt)), 32)

    const validatorInitData = ethers.solidityPacked(['address'], [this.incognitoEOA])
    const bootstrapInterface = new ethers.Interface(['function initNexusWithDefaultValidator(bytes calldata data)'])
    const bootstrapCall = bootstrapInterface.encodeFunctionData('initNexusWithDefaultValidator', [validatorInitData])
    const shieldInitData = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'bytes'], [this.contracts.NEXUS_BOOTSTRAP, bootstrapCall])

    const factoryInterface = new ethers.Interface(['function computeAccountAddress(bytes calldata initData, bytes32 salt) view returns (address)'])
    const callData = factoryInterface.encodeFunctionData('computeAccountAddress', [shieldInitData, saltBytes32])
    const result = await this.provider.call({ to: this.contracts.NEXUS_FACTORY, data: callData })
    const address = factoryInterface.decodeFunctionResult('computeAccountAddress', result)[0] as string
    return { address, salt }
  }

  /** Shield tokens directly from the owner EOA into Railgun privacy pool.
   *  Gasless — EOA signs EIP-2612 permit, smart wallet pulls tokens + shields via facilitator.
   *  Useful for bootstrapping: fund EOA with USDC, shieldFromEOA, then operate privately. */
  async shieldFromEOA(params: ShieldParams): Promise<ShieldResult> {
    const token = this.resolveToken(params.token)
    await this.init()
    const amount = ethers.parseUnits(params.amount, token.decimals)
    const masterSigner = this.config.signer ?? new ethers.Wallet(this.config.privateKey!, this.provider)
    // When the caller supplies `from`+`auth`, the USDC is pulled from that address using
    // their pre-signed EIP-3009. Master signer still signs the userOp (owner of shieldWallet)
    // and b402-facilitator sponsors gas — master is just the smart-wallet owner, not the payer.
    const externalAuth = params.from && params.auth
    if (params.from && !params.auth) throw new Error('shieldFromEOA: `from` requires `auth`')
    if (params.auth && !params.from) throw new Error('shieldFromEOA: `auth` requires `from`')
    const ownerEOA = externalAuth ? params.from! : await masterSigner.getAddress()

    // Derive ephemeral shield wallet (different salt from incognito wallet — no on-chain link)
    const { address: shieldWallet, salt: shieldSalt } = await this.computeShieldWallet()

    // Step 1: Pull tokens from EOA → shieldWallet
    // EIP-3009 tokens (USDC): fully gasless off-chain signature
    // Standard ERC-20 (USDT, DAI, WETH): on-chain approve then gasless transferFrom
    // USDC supports EIP-3009 (transferWithAuthorization) on every chain it's deployed to
    const EIP_3009_TOKENS = new Set([
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC on Base
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC on Arbitrum
    ])
    const isEIP3009 = EIP_3009_TOKENS.has(token.address.toLowerCase())

    let pullCall: Call

    if (isEIP3009) {
      const TRANSFER_AUTH_ABI = [
        'function name() view returns (string)',
        'function version() view returns (string)',
        'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
      ]

      let validAfter: number, validBefore: number, nonce: string, v: number, r: string, s: string

      if (externalAuth) {
        this.emit({ type: 'step', step: 1, totalSteps: 4, title: 'Using buyer authorization', message: `EIP-3009 pre-signed by ${ownerEOA}` })
        ;({ validAfter, validBefore, nonce, v, r, s } = params.auth!)
      } else {
        this.emit({ type: 'step', step: 1, totalSteps: 4, title: 'Signing authorization', message: `EIP-3009 gasless transfer` })
        const tokenContract = new ethers.Contract(token.address, TRANSFER_AUTH_ABI, this.provider)
        const [name, version] = await Promise.all([
          tokenContract.name(),
          tokenContract.version().catch(() => '2'),
        ])

        validAfter = 0
        validBefore = Math.floor(Date.now() / 1000) + 3600
        nonce = ethers.hexlify(ethers.randomBytes(32))

        const sig = await masterSigner.signTypedData(
          { name, version, chainId: this.chainId, verifyingContract: token.address },
          { TransferWithAuthorization: [
            { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
          ] },
          { from: ownerEOA, to: shieldWallet, value: amount, validAfter, validBefore, nonce },
        )
        ;({ v, r, s } = ethers.Signature.from(sig))
      }

      const iface = new ethers.Interface(TRANSFER_AUTH_ABI)
      pullCall = { to: token.address, value: '0', data: iface.encodeFunctionData('transferWithAuthorization', [ownerEOA, shieldWallet, amount, validAfter, validBefore, nonce, v, r, s]) }
    } else {
      // Standard ERC-20: approve shieldWallet on-chain, then transferFrom in UserOp
      this.emit({ type: 'step', step: 1, totalSteps: 4, title: 'Approving', message: `Approve ${token.symbol} for shield wallet` })

      const tokenContract = new ethers.Contract(token.address, ERC20_ABI, masterSigner)
      const allowance = await tokenContract.allowance(ownerEOA, shieldWallet)
      if (allowance < amount) {
        const approveTx = await tokenContract.approve(shieldWallet, amount)
        await approveTx.wait()
        this.emit({ type: 'info', title: 'Approved', message: `TX: ${approveTx.hash}` })
      }

      const erc20Iface = new ethers.Interface(ERC20_ABI)
      pullCall = { to: token.address, value: '0', data: erc20Iface.encodeFunctionData('transferFrom', [ownerEOA, shieldWallet, amount]) }
    }

    // Step 2: Build shield calldata
    this.emit({ type: 'step', step: 2, totalSteps: 4, title: 'Building shield', message: 'Initializing Railgun SDK' })
    const shieldCalldata = await this.buildShieldCalldata(token.address, amount)

    // Step 3: Execute [pull + approve + shield] through SHIELD WALLET (not incognito wallet)
    // On-chain: EOA → shieldWallet → Railgun. No link to incognito wallet.
    this.emit({ type: 'step', step: 3, totalSteps: 4, title: 'Shielding', message: 'Pull + approve + shield in one TX' })
    const erc20 = new ethers.Interface(ERC20_ABI)
    const calls: Call[] = [
      pullCall,
      { to: token.address, value: '0', data: erc20.encodeFunctionData('approve', [this.contracts.RAILGUN_RELAY, amount]) },
      { to: this.contracts.RAILGUN_RELAY, value: '0', data: shieldCalldata },
    ]

    // Execute via facilitator using shieldWallet (same owner as incognito wallet, different salt)
    const verifyRes = await fetch(`${this.facilitatorUrl}/api/v1/wallet/incognito/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerEOA: this.incognitoEOA,
        walletAddress: shieldWallet,
        salt: shieldSalt,
        calls,
      }),
    })
    if (!verifyRes.ok) throw new Error(`Facilitator verify failed: ${await verifyRes.text()}`)
    const verify = (await verifyRes.json()) as any
    if (!verify.isValid) throw new Error(`UserOp rejected: ${verify.invalidReason || 'unknown'}`)

    this.emit({ type: 'step', step: 3, totalSteps: 4, title: 'Signing', message: 'Signing UserOp' })
    const userOpSig = await this.incognitoWallet.signMessage(ethers.getBytes(verify.userOpHash))

    this.emit({ type: 'step', step: 3, totalSteps: 4, title: 'Submitting', message: 'Submitting to Base' })
    const settleRes = await fetch(`${this.facilitatorUrl}/api/v1/wallet/incognito/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userOp: { ...verify.userOp, signature: userOpSig } }),
    })
    if (!settleRes.ok) throw new Error(`Facilitator settle failed: ${await settleRes.text()}`)
    const settle = (await settleRes.json()) as any
    if (!settle.success) throw new Error(`TX failed: ${settle.errorReason || 'unknown'}`)
    const result = { txHash: settle.txHash }

    // Step 4: Cache + index
    this.emit({ type: 'step', step: 4, totalSteps: 4, title: 'Indexing', message: 'Caching shield commitment' })
    const receipt = await this.provider.getTransactionReceipt(result.txHash)
    if (receipt) {
      await this.cacheShieldFromReceipt(result.txHash, receipt)
    }
    const indexed = await this.waitForShieldIndexing(token.address, amount)

    this.emit({ type: 'done', title: 'Shielded', message: `${params.amount} ${token.symbol} → privacy pool (from EOA, gasless)` })
    return { txHash: result.txHash, indexed }
  }

  /** Shield tokens into Railgun privacy pool. Gasless — routes through smart wallet. */
  async shield(params: ShieldParams): Promise<ShieldResult> {
    const token = this.resolveToken(params.token)
    await this.init()
    const amount = ethers.parseUnits(params.amount, token.decimals)

    // Step 1: Build shield calldata using Railgun SDK
    this.emit({ type: 'step', step: 1, totalSteps: 3, title: 'Building shield', message: 'Initializing Railgun SDK' })
    const shieldCalldata = await this.buildShieldCalldata(token.address, amount)

    // Step 2: Execute [approve, shield] through smart wallet (gasless)
    this.emit({ type: 'step', step: 2, totalSteps: 3, title: 'Shielding', message: 'Sending gasless shield TX' })
    const erc20 = new ethers.Interface(ERC20_ABI)
    const calls: Call[] = [
      { to: token.address, value: '0', data: erc20.encodeFunctionData('approve', [this.contracts.RAILGUN_RELAY, amount]) },
      { to: this.contracts.RAILGUN_RELAY, value: '0', data: shieldCalldata },
    ]
    const result = await this.submitUserOp(calls)

    // Step 3: Cache shield from TX receipt + wait for backend indexing
    // Parse Shield events from receipt to cache locally (immediate availability)
    // Backend indexes by tx.from (relayer), so we can't rely on it alone
    this.emit({ type: 'step', step: 3, totalSteps: 3, title: 'Indexing', message: 'Caching shield commitment' })

    const receipt = await this.provider.getTransactionReceipt(result.txHash)

    // Parse Shield events and cache locally for immediate balance availability
    if (receipt) {
      await this.cacheShieldFromReceipt(result.txHash, receipt)
    }

    // Poll backend for indexing (backend indexes UserOp shields by smart wallet address)
    const indexed = await this.waitForShieldIndexing(token.address, amount)

    this.emit({ type: 'done', title: 'Shielded', message: `${params.amount} ${token.symbol} → privacy pool` })
    return { txHash: result.txHash, indexed }
  }

  /** Build shield calldata via Railgun SDK (heavy — starts engine, calls populateShield, stops engine). */
  private async buildShieldCalldata(tokenAddress: string, amount: bigint): Promise<string> {
    const { deriveRailgunKeys, getRailgunAddress } = await import('./privacy/lib/key-derivation')
    const masterSigner = this.config.signer ?? new ethers.Wallet(this.config.privateKey!)
    const signature = await masterSigner.signMessage(INCOGNITO_MESSAGE)
    const keys = await deriveRailgunKeys(signature)
    const railgunAddress = getRailgunAddress(keys)

    this.emit({ type: 'info', title: 'Shield', message: `Railgun address: ${railgunAddress.slice(0, 20)}...` })

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

    await sdkWallet.startRailgunEngine('b402shield', db, false, artifactStore, false, true,
      ['https://ppoi-agg.horsewithsixlegs.xyz'], [], false)

    try {
      // Look up the Railgun NetworkName from the shared-models enum using our chain mapping
      const networkName = sharedModels.NetworkName?.[this.railgunNetworkName] ?? this.railgunNetworkName
      const rpcUrl = this.rpcUrl
      await sdkWallet.loadProvider({
        chainId: this.chainId,
        providers: [
          { provider: rpcUrl, priority: 1, weight: 1, stallTimeout: 2500 },
          { provider: rpcUrl, priority: 2, weight: 1, stallTimeout: 2500 },
        ],
      }, networkName, 60000)

      const shieldPrivateKey = ethers.hexlify(ethers.randomBytes(32))
      const txidVersion = sharedModels.TXIDVersion?.V2_PoseidonMerkle ?? 'V2_PoseidonMerkle'

      const { transaction } = await sdkWallet.populateShield(
        txidVersion, networkName, shieldPrivateKey,
        [{ tokenAddress, amount, recipientAddress: railgunAddress }], [],
      )

      if (!transaction) throw new Error('populateShield returned null')
      return transaction.data as string
    } finally {
      await sdkWallet.stopRailgunEngine()
    }
  }

  /** Parse Shield events from TX receipt and cache locally for immediate balance availability. */
  private async cacheShieldFromReceipt(txHash: string, receipt: ethers.TransactionReceipt): Promise<void> {
    try {
      const { setCachedShield } = await import('./privacy/lib/shield-cache')
      const { poseidon } = await import('@railgun-community/engine/dist/utils/poseidon')

      // Shield event topic: keccak256("Shield(uint256,uint256,(bytes32,(uint8,address,uint256),uint120)[],(bytes32[3],bytes32)[],uint256[])")
      const SHIELD_EVENT_TOPIC = '0x3a5b9dc26075a3801a6ddccf95fec485bb7500a91b44cec1add984c21ee6db3b'

      for (const log of receipt.logs) {
        if (log.topics[0]?.toLowerCase() !== SHIELD_EVENT_TOPIC.toLowerCase()) continue

        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          [
            'uint256',  // treeNumber
            'uint256',  // startPosition
            'tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value)[]',
            'tuple(bytes32[3] encryptedBundle, bytes32 shieldKey)[]',
            'uint256[]', // fees
          ],
          log.data,
        )

        const treeNumber = decoded[0].toString()
        const startPosition = BigInt(decoded[1])
        const commitments = decoded[2]
        const ciphertexts = decoded[3]

        for (let i = 0; i < commitments.length; i++) {
          const commitment = commitments[i]
          const ciphertext = ciphertexts[i]
          const position = (startPosition + BigInt(i)).toString()
          const tokenAddress = commitment.token.tokenAddress

          // Compute commitment hash: poseidon(npk, tokenID, value)
          const addr = tokenAddress.replace(/^0x/, '').toLowerCase()
          const tokenID = `0x${addr.padStart(64, '0')}`
          const valueHex = `0x${BigInt(commitment.value).toString(16).padStart(64, '0')}`

          let commitmentHash: string
          try {
            const hash = poseidon([BigInt(commitment.npk), BigInt(tokenID), BigInt(valueHex)])
            commitmentHash = `0x${hash.toString(16).padStart(64, '0')}`
          } catch {
            // Fallback if poseidon fails
            commitmentHash = ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32', 'uint256'], [commitment.npk, tokenID, commitment.value]))
          }

          // Cache under the smart wallet address so getShieldedBalances() finds it
          setCachedShield(this.wallet.toLowerCase(), {
            txHash,
            tokenAddress,
            amount: commitment.value.toString(),
            indexed: false,
            timestamp: Date.now(),
            commitmentHash,
            treeNumber,
            position,
            npk: commitment.npk,
            encryptedBundle0: ciphertext.encryptedBundle[0],
            encryptedBundle1: ciphertext.encryptedBundle[1],
            encryptedBundle2: ciphertext.encryptedBundle[2],
            shieldKey: ciphertext.shieldKey,
          })
        }
      }
    } catch {
      // Shield caching is best-effort — balance still works via relayer query
    }
  }

  /** Poll for shield indexing. Backend indexes UserOp shields by smart wallet address. */
  private async waitForShieldIndexing(tokenAddress: string, expectedAmount: bigint): Promise<boolean> {
    const { deriveRailgunKeys } = await import('./privacy/lib/key-derivation')
    const { fetchSpendableUTXOsLightweight } = await import('./privacy/lib/utxo-fetcher')

    const masterSigner = this.config.signer ?? new ethers.Wallet(this.config.privateKey!)
    const signature = await masterSigner.signMessage(INCOGNITO_MESSAGE)
    const keys = await deriveRailgunKeys(signature)

    const startTime = Date.now()
    const POLL_INTERVAL = 5000
    const MAX_WAIT = 120_000

    while (Date.now() - startTime < MAX_WAIT) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL))
      try {
        // Query smart wallet — backend indexes UserOp shields here (PR #29)
        // Also merges in-memory cached shields from cacheShieldFromReceipt
        const utxos = await fetchSpendableUTXOsLightweight(
          this.wallet, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, tokenAddress, this.chainId
        ).catch(() => [])

        const match = utxos.find((u: any) => u.note.value >= expectedAmount)
        if (match) {
          this.emit({ type: 'info', title: 'Indexed', message: 'Shield commitment found' })
          return true
        }
      } catch {}

      const elapsed = Math.floor((Date.now() - startTime) / 1000)
      this.emit({ type: 'info', title: 'Indexing', message: `Waiting... (${elapsed}s)` })
    }

    return false
  }

  /** Check wallet balances and vault positions. */
  async status(): Promise<StatusResult> {
    await this.init()

    const deployed = await isWalletDeployed(this.wallet, this.provider)

    // Read token balances in parallel (chain-aware)
    const chainTokens = B402_CHAINS[this.chainId]?.tokens ?? {}
    const balancePromises = Object.entries(chainTokens).map(async ([symbol, token]) => {
      try {
        const contract = new ethers.Contract(token.address, ERC20_ABI, this.provider)
        const bal: bigint = await contract.balanceOf(this.wallet)
        return bal > 0n ? { token: symbol, balance: ethers.formatUnits(bal, token.decimals) } : null
      } catch { return null }
    })

    // Morpho lending positions — chain-aware (Base + Arbitrum supported).
    const chainVaults = getMorphoVaults(this.chainId)
    const hasMorpho = Object.keys(chainVaults).length > 0
    const { fetchAllVaultMetrics, formatAPY, formatTVL } = await import('./lend/morpho-api')

    const positionPromises = hasMorpho
      ? Object.entries(chainVaults).map(async ([name, vault]) => {
          try {
            const contract = new ethers.Contract(vault.address, ERC4626_INTERFACE, this.provider)
            const shares: bigint = await contract.balanceOf(this.wallet)
            if (shares === 0n) return null
            const assets: bigint = await contract.convertToAssets(shares)
            return { name, shares, assets, decimals: vault.decimals }
          } catch { return null }
        })
      : []

    const [balances, rawPositions, shieldedBalances, vaultMetrics] = await Promise.all([
      Promise.all(balancePromises),
      Promise.all(positionPromises),
      this.getShieldedBalances(),
      hasMorpho ? fetchAllVaultMetrics(this.chainId).catch(() => ({} as Record<string, any>)) : Promise.resolve({} as Record<string, any>),
    ])

    const positions = rawPositions
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map(p => {
        const metrics = vaultMetrics?.[p.name]
        const fallback = FALLBACK_APY[p.name]
        return {
          vault: p.name,
          shares: ethers.formatUnits(p.shares, p.decimals),
          assets: ethers.formatUnits(p.assets, 6) + ' USDC',
          apyEstimate: metrics ? formatAPY(metrics.netApy) : (fallback?.range || 'unknown'),
          tvl: metrics ? formatTVL(metrics.totalAssetsUsd) : undefined,
        }
      })

    // Read LP positions (Aerodrome is Base-only)
    const isBase = this.chainId === 8453
    const { AERODROME_POOLS, GAUGE_ABI: G_ABI, POOL_ABI: P_ABI, AERO_TOKEN } = await import('./lp/aerodrome-pools')
    const { fetchAllPoolMetrics, formatAPY: fmtAPY, formatTVL: fmtTVL } = await import('./lp/aerodrome-api')

    const lpPositionPromises = isBase
      ? Object.entries(AERODROME_POOLS).map(async ([key, pool]) => {
      try {
        const gaugeContract = new ethers.Contract(pool.gaugeAddress, G_ABI, this.provider)
        const poolContract = new ethers.Contract(pool.poolAddress, P_ABI, this.provider)

        const [stakedLP, unstakedLP, pendingAero, totalSupply, reserves] = await Promise.all([
          gaugeContract.balanceOf(this.wallet) as Promise<bigint>,
          poolContract.balanceOf(this.wallet) as Promise<bigint>,
          gaugeContract.earned(this.wallet).catch(() => 0n) as Promise<bigint>,
          poolContract.totalSupply() as Promise<bigint>,
          poolContract.getReserves() as Promise<[bigint, bigint, bigint]>,
        ])

        const totalLP = stakedLP + unstakedLP
        if (totalLP === 0n) return null

        // Estimate USD value: (userLP / totalSupply) * total pool value
        // reserve1 is USDC (6 decimals), multiply by 2 for both sides
        const shareOfPool = Number(totalLP) / Number(totalSupply)
        const usdcReserve = Number(ethers.formatUnits(reserves[1], 6))
        const usdValue = (shareOfPool * usdcReserve * 2).toFixed(2)

        return {
          pool: key,
          lpTokens: ethers.formatUnits(totalLP, 18),
          staked: stakedLP > 0n,
          usdValue,
          pendingRewards: ethers.formatUnits(pendingAero, 18) + ' AERO',
        } as { pool: string; lpTokens: string; staked: boolean; usdValue: string; pendingRewards: string }
      } catch { return null }
    })
      : []

    const [rawLPPositions, poolMetrics] = await Promise.all([
      Promise.all(lpPositionPromises),
      isBase ? fetchAllPoolMetrics(this.provider) : Promise.resolve({} as Record<string, any>),
    ])

    const lpPositions: LPPosition[] = rawLPPositions
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map(p => {
        const pm = poolMetrics?.[p.pool]
        const fallbackLP = { range: '6-10%', midpoint: 7.6 }
        return {
          ...p,
          apyEstimate: pm ? fmtAPY(pm.apy) : fallbackLP.range,
          tvl: pm ? fmtTVL(pm.tvlUsd) : undefined,
        }
      })

    return {
      ownerEOA: this.incognitoEOA,
      smartWallet: this.wallet,
      deployed,
      chain: (B402_CHAINS[this.chainId]?.name || 'unknown').toLowerCase(),
      chainId: this.chainId,
      balances: balances.filter((b): b is NonNullable<typeof b> => b !== null),
      shieldedBalances,
      positions,
      lpPositions,
    }
  }

  /**
   * Move capital to the highest-yield source across Morpho vaults AND Aerodrome LP.
   * Compares all yield sources and moves capital if the APY difference exceeds minApyDiff.
   */
  async rebalance(minApyDiff = 0.5): Promise<RebalanceResult> {
    this.requireBase('rebalance')
    const { fetchAllVaultMetrics } = await import('./lend/morpho-api')
    const { fetchAllPoolMetrics, getFallbackAPY: getFallbackLPAPY } = await import('./lp/aerodrome-api')

    const [morphoMetrics, poolMetrics] = await Promise.all([
      fetchAllVaultMetrics(8453),
      fetchAllPoolMetrics(this.provider),
    ])

    const status = await this.status()
    if (status.positions.length === 0 && status.lpPositions.length === 0) {
      return { action: 'no-change' }
    }

    // Find current position (Morpho or LP)
    let currentSource = ''
    let currentApy = 0
    let currentType: 'morpho' | 'lp' = 'morpho'

    if (status.positions.length > 0) {
      const p = status.positions[0]
      currentSource = p.vault
      currentApy = morphoMetrics?.[p.vault]?.netApy ?? (FALLBACK_APY[p.vault]?.mid ?? 0) / 100
      currentType = 'morpho'
    } else if (status.lpPositions.length > 0) {
      const lp = status.lpPositions[0]
      currentSource = lp.pool
      currentApy = poolMetrics?.[lp.pool]?.apy ?? getFallbackLPAPY(lp.pool).midpoint / 100
      currentType = 'lp'
    }

    // Find best across ALL yield sources
    let bestSource = currentSource
    let bestApy = currentApy
    let bestType: 'morpho' | 'lp' = currentType

    for (const key of Object.keys(MORPHO_VAULTS)) {
      const netApy = morphoMetrics?.[key]?.netApy ?? (FALLBACK_APY[key]?.mid ?? 0) / 100
      if (netApy > bestApy) { bestSource = key; bestApy = netApy; bestType = 'morpho' }
    }

    const { AERODROME_POOLS } = await import('./lp/aerodrome-pools')
    for (const key of Object.keys(AERODROME_POOLS)) {
      const apy = poolMetrics?.[key]?.apy ?? getFallbackLPAPY(key).midpoint / 100
      if (apy > bestApy) { bestSource = key; bestApy = apy; bestType = 'lp' }
    }

    const apyDiffPct = (bestApy - currentApy) * 100
    if (bestSource === currentSource || apyDiffPct < minApyDiff) {
      return { action: 'no-change', currentVault: currentSource, bestVault: bestSource }
    }

    this.emit({ type: 'info', title: 'Rebalance', message: `${currentSource} (${(currentApy * 100).toFixed(1)}%) → ${bestSource} (${(bestApy * 100).toFixed(1)}%)` })

    // Exit current position
    if (currentType === 'morpho') {
      await this.redeem({ vault: currentSource })
    } else {
      await this.removeLiquidity({ pool: currentSource })
      // Swap WETH back to USDC if moving to Morpho
      // The removeLiquidity returns WETH + USDC, need to consolidate
    }

    // Get USDC balance for redeployment
    const usdcContract = new ethers.Contract(BASE_TOKENS.USDC.address, ERC20_ABI, this.provider)
    const usdcBal: bigint = await usdcContract.balanceOf(this.wallet)
    const usdcAmount = ethers.formatUnits(usdcBal, 6)

    // Enter best position
    let txHash = ''
    if (bestType === 'morpho') {
      const result = await this.lend({ token: 'USDC', amount: usdcAmount, vault: bestSource })
      txHash = result.txHash
    } else {
      const result = await this.addLiquidity({ pool: bestSource, amount: usdcAmount })
      txHash = result.txHash
    }

    return { action: 'rebalanced', currentVault: currentSource, bestVault: bestSource, txHash }
  }

  // ── Aerodrome LP ───────────────────────────────────────────────────────

  /**
   * Add liquidity to an Aerodrome pool from USDC on the smart wallet.
   *
   * SDK handles the split: swaps half USDC → WETH, then adds both as liquidity.
   * LP tokens are staked in the gauge to earn AERO emissions (~7.6% APY).
   * All calls execute in one gasless UserOp.
   */
  async addLiquidity(params: AddLiquidityParams): Promise<AddLiquidityResult> {
    this.requireBase('addLiquidity')
    await this.init()

    const { resolvePool, applySlippage: applySlip } = await import('./lp/aerodrome-pools')
    const { buildAddLiquidityCalls } = await import('./lp/lp-builder')
    const { AerodromeProvider } = await import('./swap/aerodrome-provider')

    const pool = resolvePool(params.pool || 'weth-usdc')
    const amount = ethers.parseUnits(params.amount, pool.tokenB.decimals) // USDC
    const slippageBps = params.slippageBps ?? 300

    this.emit({ type: 'step', step: 1, totalSteps: 3, title: 'Quote', message: 'Getting swap quote for USDC → WETH' })

    // Split: swap half to WETH
    const halfUsdc = amount / 2n
    const usdcForLiquidity = amount - halfUsdc

    const aerodrome = new AerodromeProvider(BASE_CONTRACTS.AERODROME_ROUTER, this.provider)
    const quote = await aerodrome.getQuote({
      sellToken: pool.tokenB.address,
      buyToken: pool.tokenA.address,
      sellAmount: halfUsdc,
      taker: this.wallet,
      slippageBps,
    })

    // Build swap calldata targeting the wallet
    const swapCalldata = aerodrome.buildSwapCalldata({
      tokenIn: pool.tokenB.address,
      tokenOut: pool.tokenA.address,
      amountIn: halfUsdc,
      amountOutMin: aerodrome.applySlippage(quote.buyAmount, slippageBps),
      to: this.wallet,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
    })

    this.emit({ type: 'step', step: 2, totalSteps: 3, title: 'Build', message: 'Building LP calls' })

    const calls = buildAddLiquidityCalls({
      pool,
      usdcAmount: amount,
      swapCalldata,
      expectedWethOut: quote.buyAmount,
      usdcForLiquidity,
      amountAMin: applySlip(quote.buyAmount, slippageBps),
      amountBMin: applySlip(usdcForLiquidity, slippageBps),
      recipient: this.wallet,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
    })

    this.emit({ type: 'step', step: 3, totalSteps: 3, title: 'Execute', message: 'Submitting LP transaction' })

    const result = await this.submitUserOp(calls)
    this.emit({ type: 'done', title: 'LP Added', message: `${params.amount} USDC → ${pool.name}` })

    return { txHash: result.txHash, amount: params.amount, pool: pool.name }
  }

  /**
   * Remove all liquidity from an Aerodrome pool.
   * Claims AERO rewards, unstakes from gauge, removes liquidity.
   * Returns WETH + USDC to the smart wallet.
   */
  async removeLiquidity(params: RemoveLiquidityParams = {}): Promise<RemoveLiquidityResult> {
    this.requireBase('removeLiquidity')
    await this.init()

    const { resolvePool, GAUGE_ABI: G_ABI, POOL_ABI: P_ABI, applySlippage: applySlip } = await import('./lp/aerodrome-pools')
    const { ROUTER_LP_ABI: R_ABI, AERODROME_FACTORY: FACTORY } = await import('./lp/aerodrome-pools')
    const { buildRemoveLiquidityCalls } = await import('./lp/lp-builder')

    const pool = resolvePool(params.pool || 'weth-usdc')
    const slippageBps = params.slippageBps ?? 300

    const gaugeContract = new ethers.Contract(pool.gaugeAddress, G_ABI, this.provider)
    const poolContract = new ethers.Contract(pool.poolAddress, P_ABI, this.provider)

    const [stakedLP, unstakedLP] = await Promise.all([
      gaugeContract.balanceOf(this.wallet) as Promise<bigint>,
      poolContract.balanceOf(this.wallet) as Promise<bigint>,
    ])

    const totalLP = stakedLP + unstakedLP
    if (totalLP === 0n) throw new Error(`No LP position in ${pool.name}`)

    // Quote expected output
    const quoteData = R_ABI.encodeFunctionData('quoteRemoveLiquidity', [
      pool.tokenA.address, pool.tokenB.address, pool.stable, FACTORY, totalLP,
    ])
    const quoteResult = await this.provider.call({ to: BASE_CONTRACTS.AERODROME_ROUTER, data: quoteData })
    const [quoteAmounts] = R_ABI.decodeFunctionResult('quoteRemoveLiquidity', quoteResult)

    const calls = buildRemoveLiquidityCalls({
      pool,
      stakedAmount: stakedLP,
      unstakedAmount: unstakedLP,
      amountAMin: applySlip(quoteAmounts[0] as bigint, slippageBps),
      amountBMin: applySlip(quoteAmounts[1] as bigint, slippageBps),
      wallet: this.wallet,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
    })

    const result = await this.submitUserOp(calls)

    return {
      txHash: result.txHash,
      pool: pool.name,
      amountWETH: ethers.formatUnits(quoteAmounts[0] as bigint, 18),
      amountUSDC: ethers.formatUnits(quoteAmounts[1] as bigint, 6),
    }
  }

  /** Claim AERO rewards from gauge without removing liquidity. */
  async claimRewards(params: ClaimRewardsParams = {}): Promise<ClaimRewardsResult> {
    this.requireBase('claimRewards')
    await this.init()

    const { resolvePool } = await import('./lp/aerodrome-pools')
    const { buildClaimRewardsCalls } = await import('./lp/lp-builder')

    const pool = resolvePool(params.pool || 'weth-usdc')
    const calls = buildClaimRewardsCalls(pool.gaugeAddress, this.wallet)
    const result = await this.submitUserOp(calls)

    return { txHash: result.txHash, pool: pool.name }
  }

  // ── Trading: Speed Markets (Thales) ────────────────────────────────────

  /**
   * Place a speed market bet (binary option) — predict UP or DOWN.
   *
   * Uses USDC from the smart wallet. Min $5, max $200.
   * Payout: ~2x minus fees. Auto-settled by Pyth oracle keepers.
   */
  async speedMarket(params: SpeedMarketParams): Promise<SpeedMarketResult> {
    await this.init()

    this.emit({ type: 'step', step: 1, totalSteps: 3, title: 'Building', message: `Speed market: ${params.asset} ${params.direction}` })

    const { buildSpeedMarketCalls } = await import('./trade/speed-markets')

    const { calls, strikeTime, delta } = await buildSpeedMarketCalls(
      {
        asset: params.asset as any,
        direction: params.direction,
        amount: params.amount,
        duration: params.duration,
      },
      this.wallet,
      this.provider,
    )

    this.emit({ type: 'step', step: 2, totalSteps: 3, title: 'Executing', message: 'Placing bet via SpeedMarketsAMMCreator' })

    const result = await this.submitUserOp(calls)

    this.emit({ type: 'done', title: 'Done', message: `${params.asset} ${params.direction} bet placed — settles in ${params.duration || '10m'}` })

    return {
      txHash: result.txHash,
      asset: params.asset.toUpperCase(),
      direction: params.direction,
      amount: params.amount,
      strikeTime,
      duration: params.duration || '10m',
    }
  }

  /**
   * Place a PRIVATE speed market bet — bet from the privacy pool.
   *
   * Flow: Pool USDC → unshield → approve + bet → shield remainder → Pool
   * On-chain: observer sees RelayAdapt placed a bet — no link to user.
   */
  async privateSpeedMarket(params: SpeedMarketParams): Promise<SpeedMarketResult> {
    await this.init()

    this.emit({ type: 'step', step: 1, totalSteps: 6, title: 'Building', message: `Private speed market: ${params.asset} ${params.direction}` })

    const { buildSpeedMarketCalls } = await import('./trade/speed-markets')

    const { calls, collateralAddress, buyinAmount, strikeTime } = await buildSpeedMarketCalls(
      {
        asset: params.asset as any,
        direction: params.direction,
        amount: params.amount,
        duration: params.duration,
      },
      this.wallet,
      this.provider,
    )

    const userCalls = calls.map(c => ({ to: c.to, data: c.data, value: c.value || '0' }))

    const result = await this.executeCrossContractCall({
      tokenAddress: collateralAddress,
      amount: buyinAmount,
      userCalls,
      shieldTokens: [], // Payout arrives later via keeper settlement
      stepOffset: 1,
      totalSteps: 6,
    })

    return {
      txHash: result.txHash,
      asset: params.asset.toUpperCase(),
      direction: params.direction,
      amount: params.amount,
      strikeTime,
      duration: params.duration || '10m',
    }
  }

  // ── Trading: Synthetix Perps V3 ─────────────────────────────────────

  /**
   * Open a perpetual futures position via Synthetix V3.
   *
   * Creates account (if needed), wraps USDC → sUSDC, deposits margin, commits order.
   * Settlement happens automatically after ~2 blocks via Pyth keepers.
   */
  async openPerp(params: OpenPerpParams): Promise<OpenPerpResult> {
    await this.init()

    const {
      buildCreateAccountCall,
      buildDepositMarginCalls,
      buildCommitOrderCall,
      getIndexPrice,
      SYNTHETIX_CONTRACTS,
      PERPS_MARKET_ABI,
    } = await import('./trade/synthetix-perps')

    this.emit({ type: 'step', step: 1, totalSteps: 4, title: 'Setup', message: 'Creating perps account + wrapping USDC' })

    const usdcAmount = ethers.parseUnits(params.margin, 6) // 6 decimals
    // Use a deterministic account ID derived from wallet to reuse across calls
    const accountId = BigInt('0x' + ethers.keccak256(ethers.toUtf8Bytes(this.wallet)).slice(2, 18))

    // Check if account already exists
    const perps = new ethers.Contract(SYNTHETIX_CONTRACTS.PERPS_MARKET_PROXY, PERPS_MARKET_ABI, this.provider)
    let needsAccount = true
    try {
      const owner = await perps.getAccountOwner(accountId)
      if (owner.toLowerCase() === this.wallet.toLowerCase()) needsAccount = false
    } catch {
      // Account doesn't exist
    }

    const calls: Call[] = []

    if (needsAccount) {
      const createCall = buildCreateAccountCall()
      calls.push({ to: createCall.to, value: createCall.value, data: createCall.data })
    }

    this.emit({ type: 'step', step: 2, totalSteps: 4, title: 'Margin', message: `Depositing ${params.margin} USDC as margin` })

    const depositCalls = buildDepositMarginCalls(usdcAmount, accountId)
    for (const c of depositCalls) {
      calls.push({ to: c.to, value: c.value, data: c.data })
    }

    this.emit({ type: 'step', step: 3, totalSteps: 4, title: 'Order', message: `${params.side} ${params.size} ${params.market}` })

    const indexPrice = await getIndexPrice(params.market, this.provider)
    const orderCall = buildCommitOrderCall(
      { market: params.market, side: params.side, size: params.size, margin: params.margin, slippageBps: params.slippageBps },
      accountId,
      indexPrice,
    )
    calls.push({ to: orderCall.to, value: orderCall.value, data: orderCall.data })

    this.emit({ type: 'step', step: 4, totalSteps: 4, title: 'Executing', message: 'Submitting to Base' })

    const result = await this.submitUserOp(calls)

    this.emit({ type: 'info', title: 'Account', message: accountId.toString() })
    this.emit({ type: 'done', title: 'Done', message: `${params.side} ${params.size} ${params.market} — settles in ~2 blocks` })

    return {
      txHash: result.txHash,
      market: params.market.toUpperCase(),
      side: params.side,
      size: params.size,
      margin: params.margin,
    }
  }

  /**
   * Close a perp position by committing an opposite-side order.
   */
  async closePerp(params: ClosePerpParams): Promise<ClosePerpResult> {
    await this.init()

    const {
      buildCommitOrderCall,
      getIndexPrice,
      getAccountInfo,
    } = await import('./trade/synthetix-perps')

    this.emit({ type: 'step', step: 1, totalSteps: 2, title: 'Reading', message: 'Fetching position' })

    const accountId = BigInt(params.accountId)
    const info = await getAccountInfo(accountId, this.provider)
    const marketKey = params.market.toUpperCase()
    const position = info.positions.find(p => p.market === marketKey)

    if (!position || position.size === '0.0') {
      throw new Error(`No open position in ${marketKey}`)
    }

    // Close by submitting opposite sizeDelta
    const currentSize = parseFloat(position.size)
    const closeSize = Math.abs(currentSize).toString()
    const closeSide = currentSize > 0 ? 'short' : 'long' // opposite side to close

    this.emit({ type: 'step', step: 2, totalSteps: 2, title: 'Closing', message: `Closing ${position.size} ${marketKey}` })

    const indexPrice = await getIndexPrice(params.market, this.provider)
    const orderCall = buildCommitOrderCall(
      { market: params.market, side: closeSide, size: closeSize, margin: '0', slippageBps: params.slippageBps },
      accountId,
      indexPrice,
    )

    const result = await this.submitUserOp([{ to: orderCall.to, value: orderCall.value, data: orderCall.data }])

    return { txHash: result.txHash, market: marketKey }
  }

  /**
   * Open a PRIVATE perp position — fund margin from privacy pool.
   *
   * Flow: Pool USDC → unshield → wrap sUSDC → deposit margin → commit order → shield remainder
   * The perps account lives on the anonymous smart wallet.
   */
  async privateOpenPerp(params: OpenPerpParams): Promise<OpenPerpResult> {
    await this.init()

    const {
      buildCreateAccountCall,
      buildDepositMarginCalls,
      buildCommitOrderCall,
      getIndexPrice,
      SYNTHETIX_CONTRACTS,
      PERPS_MARKET_ABI,
    } = await import('./trade/synthetix-perps')

    this.emit({ type: 'step', step: 1, totalSteps: 6, title: 'Building', message: `Private perp: ${params.side} ${params.size} ${params.market}` })

    const usdcAmount = ethers.parseUnits(params.margin, 6)
    const accountId = BigInt('0x' + ethers.keccak256(ethers.toUtf8Bytes(this.wallet)).slice(2, 18))

    const perps = new ethers.Contract(SYNTHETIX_CONTRACTS.PERPS_MARKET_PROXY, PERPS_MARKET_ABI, this.provider)
    let needsAccount = true
    try {
      const owner = await perps.getAccountOwner(accountId)
      if (owner.toLowerCase() === this.wallet.toLowerCase()) needsAccount = false
    } catch { /* doesn't exist */ }

    const userCalls: Array<{ to: string; data: string; value: string }> = []

    if (needsAccount) {
      const createCall = buildCreateAccountCall()
      userCalls.push(createCall)
    }

    const depositCalls = buildDepositMarginCalls(usdcAmount, accountId)
    userCalls.push(...depositCalls)

    const indexPrice = await getIndexPrice(params.market, this.provider)
    const orderCall = buildCommitOrderCall(
      { market: params.market, side: params.side, size: params.size, margin: params.margin, slippageBps: params.slippageBps },
      accountId,
      indexPrice,
    )
    userCalls.push(orderCall)

    const result = await this.executeCrossContractCall({
      tokenAddress: BASE_TOKENS.USDC.address,
      amount: usdcAmount,
      userCalls,
      shieldTokens: [], // Margin is locked in Synthetix, nothing to shield back now
      stepOffset: 1,
      totalSteps: 6,
    })

    return {
      txHash: result.txHash,
      market: params.market.toUpperCase(),
      side: params.side,
      size: params.size,
      margin: params.margin,
    }
  }

  // ── Trading: SynFutures V3 ──────────────────────────────────────────

  /**
   * Open a perp position on SynFutures V3.
   *
   * Deposits USDC margin into Gate, then trades on the instrument.
   * SynFutures has 65+ instruments with real volume on Base.
   *
   * @example
   * await b402.synfuturesTrade({ instrument: 'LINK', side: 'long', notional: '20', margin: '10' })
   */
  async synfuturesTrade(params: SynFuturesTradeParams): Promise<SynFuturesTradeResult> {
    this.requireBase('synfuturesTrade')
    await this.init()

    const {
      buildOpenPositionCalls,
      getQuote,
      getAmmState,
      SYNFUTURES_INSTRUMENTS,
    } = await import('./trade/synfutures')

    this.emit({ type: 'step', step: 1, totalSteps: 4, title: 'Quote', message: `Getting quote for ${params.notional} USDC ${params.side} on ${params.instrument}` })

    // Get current price
    const amm = await getAmmState(params.instrument, this.provider)
    this.emit({ type: 'info', title: 'Price', message: `$${Number(amm.priceUsd).toFixed(4)}` })

    // Get trade quote
    const quote = await getQuote(params.instrument, params.notional, params.side, this.provider)

    this.emit({ type: 'step', step: 2, totalSteps: 4, title: 'Building', message: `Deposit ${params.margin} USDC margin + trade` })

    const calls = buildOpenPositionCalls(
      { instrument: params.instrument, side: params.side, notional: params.notional, margin: params.margin, slippageBps: params.slippageBps },
      { size: quote.size, minAmount: quote.minAmount, tick: quote.tick },
    )

    this.emit({ type: 'step', step: 3, totalSteps: 4, title: 'Executing', message: 'Submitting to Base' })

    const result = await this.submitUserOp(calls.map(c => ({ to: c.to, value: c.value, data: c.data })))

    this.emit({ type: 'done', title: 'Done', message: `${params.side} ${params.notional} USDC notional on ${params.instrument}` })

    return {
      txHash: result.txHash,
      instrument: params.instrument.toUpperCase(),
      side: params.side,
      notional: params.notional,
      margin: params.margin,
      size: ethers.formatEther(quote.size),
      priceUsd: amm.priceUsd,
    }
  }

  /**
   * Close a SynFutures V3 position.
   *
   * Trades the opposite size to close, then optionally withdraws margin from Gate.
   */
  async synfuturesClose(params: SynFuturesCloseParams): Promise<SynFuturesCloseResult> {
    this.requireBase('synfuturesClose')
    await this.init()

    const {
      getPosition,
      buildClosePositionCalls,
      buildWithdrawCalls,
      getGateReserve,
    } = await import('./trade/synfutures')

    this.emit({ type: 'step', step: 1, totalSteps: 3, title: 'Reading', message: 'Fetching position' })

    const position = await getPosition(params.instrument, this.wallet, this.provider)
    if (!position) {
      throw new Error(`No open position in ${params.instrument}`)
    }

    this.emit({ type: 'info', title: 'Position', message: `${position.side} ${position.size} (balance: ${position.balance})` })
    this.emit({ type: 'step', step: 2, totalSteps: 3, title: 'Closing', message: `Closing ${position.side} position` })

    const sizeWad = ethers.parseEther(position.size)
    const calls = buildClosePositionCalls(position.instrumentAddress, sizeWad)

    // Optionally withdraw remaining margin from Gate
    if (params.withdrawMargin !== false) {
      const reserve = await getGateReserve(this.wallet, this.provider)
      if (reserve > 0n) {
        calls.push(...buildWithdrawCalls(reserve))
      }
    }

    this.emit({ type: 'step', step: 3, totalSteps: 3, title: 'Executing', message: 'Submitting close to Base' })

    const result = await this.submitUserOp(calls.map(c => ({ to: c.to, value: c.value, data: c.data })))

    this.emit({ type: 'done', title: 'Done', message: `Closed ${position.side} position on ${params.instrument}` })

    return { txHash: result.txHash, instrument: params.instrument.toUpperCase() }
  }

  /**
   * Open a PRIVATE SynFutures V3 perp position — fund margin from privacy pool.
   *
   * Flow: Pool USDC → unshield → approve + deposit Gate + trade → shield remainder
   * On-chain: observer sees RelayAdapt deposited to Gate — no link to user.
   */
  async privateSynfuturesTrade(params: SynFuturesTradeParams): Promise<SynFuturesTradeResult> {
    this.requireBase('privateSynfuturesTrade')
    await this.init()

    const {
      buildOpenPositionCalls,
      getQuote,
      getAmmState,
    } = await import('./trade/synfutures')

    this.emit({ type: 'step', step: 1, totalSteps: 6, title: 'Quote', message: `Private trade: ${params.side} ${params.notional} USDC on ${params.instrument}` })

    const amm = await getAmmState(params.instrument, this.provider)
    const quote = await getQuote(params.instrument, params.notional, params.side, this.provider)

    const calls = buildOpenPositionCalls(
      { instrument: params.instrument, side: params.side, notional: params.notional, margin: params.margin, slippageBps: params.slippageBps },
      { size: quote.size, minAmount: quote.minAmount, tick: quote.tick },
    )

    const usdcAmount = ethers.parseUnits(params.margin, 6)

    const result = await this.executeCrossContractCall({
      tokenAddress: BASE_TOKENS.USDC.address,
      amount: usdcAmount,
      userCalls: calls,
      shieldTokens: [], // Margin locked in SynFutures Gate, nothing to shield back
      stepOffset: 1,
      totalSteps: 6,
    })

    return {
      txHash: result.txHash,
      instrument: params.instrument.toUpperCase(),
      side: params.side,
      notional: params.notional,
      margin: params.margin,
      size: ethers.formatEther(quote.size),
      priceUsd: amm.priceUsd,
    }
  }

  /** Available SynFutures instruments */
  static get synfuturesInstruments() {
    return ['BTC', 'ETH', 'SOL']
  }

  // ── Private DeFi via RelayAdapt ──────────────────────────────────────

  /**
   * Swap tokens privately from the privacy pool via RelayAdapt + Aerodrome.
   *
   * Flow: Pool USDC → unshield to RelayAdapt → Aerodrome swap → shield output → Pool
   * On-chain: observer sees "RelayAdapt called Aerodrome" — zero link to user.
   */
  async privateSwap(params: PrivateSwapParams): Promise<PrivateSwapResult> {
    this.requireBase('privateSwap')
    const tokenIn = this.resolveToken(params.from)
    const tokenOut = this.resolveToken(params.to)
    await this.init()
    const totalAmount = ethers.parseUnits(params.amount, tokenIn.decimals)
    const slippageBps = params.slippageBps ?? 50
    const slippagePercent = slippageBps / 100

    this.emit({ type: 'step', step: 1, totalSteps: 6, title: 'Quote', message: `Swapping ${params.amount} ${tokenIn.symbol}` })

    const { RELAY_ADAPT_ADDRESS } = await import('./privacy/lib/relay-adapt')

    let userCalls: Array<{ to: string; data: string; value: string }>
    let expectedOut: bigint
    let source = 'aerodrome'

    // Try Odos aggregator first (routes across ALL DEXes on Base)
    try {
      const { getAggregatorQuote, buildAggregatorSwapCalls } = await import('./swap/dex-aggregator')
      const aggQuote = await getAggregatorQuote(
        tokenIn.address, tokenOut.address, totalAmount, slippagePercent, RELAY_ADAPT_ADDRESS
      )
      userCalls = await buildAggregatorSwapCalls(aggQuote, tokenIn.address, RELAY_ADAPT_ADDRESS)
      expectedOut = aggQuote.amountOut
      source = 'odos'
      this.emit({ type: 'info', title: 'Route', message: `Odos aggregator (best rate across all DEXes)` })
    } catch {
      // Fallback: direct Aerodrome
      this.emit({ type: 'info', title: 'Route', message: `Aerodrome direct (aggregator unavailable)` })
      const { AerodromeProvider } = await import('./swap/aerodrome-provider')
      const aerodrome = new AerodromeProvider(BASE_CONTRACTS.AERODROME_ROUTER, this.provider)

      const quote = await aerodrome.getQuote({
        sellToken: tokenIn.address,
        buyToken: tokenOut.address,
        sellAmount: totalAmount,
        taker: RELAY_ADAPT_ADDRESS,
        slippageBps,
      })

      const erc20 = new ethers.Interface(ERC20_ABI)
      const approveData = erc20.encodeFunctionData('approve', [BASE_CONTRACTS.AERODROME_ROUTER, totalAmount])
      const swapCalldata = aerodrome.buildSwapCalldata({
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: totalAmount,
        amountOutMin: aerodrome.applySlippage(quote.buyAmount, slippageBps),
        to: RELAY_ADAPT_ADDRESS,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
      })

      userCalls = [
        { to: tokenIn.address, data: approveData, value: '0' },
        { to: swapCalldata.to, data: swapCalldata.data, value: '0' },
      ]
      expectedOut = quote.buyAmount
    }

    const result = await this.executeCrossContractCall({
      tokenAddress: tokenIn.address,
      amount: totalAmount,
      userCalls,
      shieldTokens: [{ tokenAddress: tokenOut.address }],
      stepOffset: 1,
      totalSteps: 6,
    })

    return {
      txHash: result.txHash,
      amountIn: params.amount,
      amountOut: ethers.formatUnits(expectedOut, tokenOut.decimals),
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
    }
  }

  /**
   * Deposit tokens privately into a Morpho vault from the privacy pool.
   *
   * Flow: Pool USDC → unshield to RelayAdapt → approve + vault.deposit → shield shares → Pool
   * Share tokens (vault address as ERC20) are shielded back into the pool.
   */
  async privateLend(params: PrivateLendParams): Promise<PrivateLendResult> {
    const token = this.resolveToken(params.token || 'USDC')
    const vault = resolveVault(params.vault || 'steakhouse', this.chainId)
    const relayAdapt = getRelayAdaptAddress(this.chainId)
    await this.init()
    const amount = ethers.parseUnits(params.amount, token.decimals)

    this.emit({ type: 'step', step: 1, totalSteps: 6, title: 'Building', message: 'Building vault deposit calls' })

    const erc20 = new ethers.Interface(ERC20_ABI)

    // approve(vault, amount) + vault.deposit(amount, RelayAdapt)
    const userCalls = [
      {
        to: token.address,
        data: erc20.encodeFunctionData('approve', [vault.address, amount]),
        value: '0',
      },
      {
        to: vault.address,
        data: ERC4626_INTERFACE.encodeFunctionData('deposit', [amount, relayAdapt]),
        value: '0',
      },
    ]

    const result = await this.executeCrossContractCall({
      tokenAddress: token.address,
      amount,
      userCalls,
      // Vault share token IS the vault contract address (standard ERC20)
      shieldTokens: [{ tokenAddress: vault.address }],
      stepOffset: 1,
      totalSteps: 6,
    })

    return { txHash: result.txHash, amount: params.amount, vault: vault.name }
  }

  /**
   * Redeem shares privately from a Morpho vault back to the privacy pool.
   *
   * Flow: Pool shares → unshield to RelayAdapt → vault.redeem → shield USDC → Pool
   * USDC is shielded back into the pool.
   */
  async privateRedeem(params: PrivateRedeemParams = {}): Promise<PrivateRedeemResult> {
    const vault = resolveVault(params.vault || 'steakhouse', this.chainId)
    const relayAdapt = getRelayAdaptAddress(this.chainId)
    const usdc = this.resolveToken('USDC')
    await this.init()

    this.emit({ type: 'step', step: 1, totalSteps: 6, title: 'Scanning', message: 'Checking shielded vault shares' })

    // Determine shares amount — from params or scan pool for vault share balance
    let shares: bigint
    if (params.shares) {
      shares = ethers.parseUnits(params.shares, vault.decimals)
    } else {
      // Scan privacy pool for vault share tokens
      const shieldedBals = await this.getShieldedBalances()
      // Vault share token address = vault contract address — match on address field
      const shareBal = shieldedBals.find(
        b => b.address?.toLowerCase() === vault.address.toLowerCase()
      )
      if (!shareBal || parseFloat(shareBal.balance) === 0) {
        throw new Error(`No shielded shares in ${vault.name}. Use privateLend() first.`)
      }
      // Get actual share token decimals on-chain (vault shares may differ from underlying)
      const shareTokenContract = new ethers.Contract(vault.address, ['function decimals() view returns (uint8)'], this.provider)
      const shareDecimals = Number(await shareTokenContract.decimals())
      shares = ethers.parseUnits(shareBal.balance, shareDecimals)
    }

    // Preview the expected USDC output
    const vaultContract = new ethers.Contract(vault.address, ERC4626_INTERFACE, this.provider)
    const expectedAssets: bigint = await vaultContract.convertToAssets(shares)

    // redeem(shares, RelayAdapt, RelayAdapt) — RelayAdapt owns the shares after unshield
    const userCalls = [
      {
        to: vault.address,
        data: ERC4626_INTERFACE.encodeFunctionData('redeem', [shares, relayAdapt, relayAdapt]),
        value: '0',
      },
    ]

    const result = await this.executeCrossContractCall({
      tokenAddress: vault.address,  // Unshield SHARE tokens
      amount: shares,
      userCalls,
      // Shield USDC back to pool — chain-aware (USDC differs per chain).
      shieldTokens: [{ tokenAddress: usdc.address }],
      stepOffset: 1,
      totalSteps: 6,
    })

    return {
      txHash: result.txHash,
      assetsReceived: ethers.formatUnits(expectedAssets, 6),
      vault: vault.name,
    }
  }

  /**
   * Private cross-chain send — transfer, bridge, or bridge+swap in one atomic call.
   * Covers: same-token cross-chain transfer, cross-chain swap (bridge+swap),
   * and cross-chain payments. LI.FI picks the optimal route across ~30 bridges
   * and ~20 DEXes.
   *
   * Flow:
   *   Source chain (atomic):
   *     Pool USDC -> unshield to RelayAdapt -> approve LI.FI Diamond
   *                                         -> LI.FI Diamond bridges+swaps
   *                                         -> shields any remainder back to pool
   *   Destination chain (follow-up):
   *     Funds arrive at `destinationAddress` (derived EOA).
   *     User/agent runs b402.shieldFromEOA on destination to complete privacy loop.
   *
   * Observer sees "RelayAdapt called LI.FI Diamond" on source; bridge fill on dest.
   * No link between the source shielded origin and the destination recipient.
   *
   * LI.FI picks the best tool (Across, Stargate, CCTP, Eco, NearIntents, etc.).
   * Charges a default 0.25% fixed fee.
   *
   * v1 limitation: source chain must match the SDK's current chain (8453 for now).
   * Cross-chain source selection will come in a follow-up.
   */
  async privateCrossChain(params: PrivateCrossChainParams): Promise<PrivateCrossChainResult> {
    await this.init()

    const { getChainConfig, getTokenAddress: getChainTokenAddress } =
      await import('./config/chains')
    const { LiFiProvider } = await import('./bridge/lifi-provider')
    const { RELAY_ADAPT_ADDRESS } = await import('./privacy/lib/relay-adapt')

    const fromToken = this.resolveToken(params.fromToken)
    // v1: source chain is Base (same as rest of SDK). Multi-chain source TBD.
    const sourceChainConfig = getChainConfig(8453)
    const destChainConfig = getChainConfig(params.toChain)

    if (sourceChainConfig.chainId === destChainConfig.chainId) {
      throw new Error(
        `Source and destination are the same chain (${sourceChainConfig.name}). Use privateSwap for same-chain swaps.`,
      )
    }

    // Resolve destination token address on destination chain
    const toTokenAddress = params.toToken.startsWith('0x')
      ? params.toToken
      : getChainTokenAddress(destChainConfig.chainId, params.toToken)

    const toTokenConfig = Object.values(destChainConfig.tokens).find(
      t => t.address.toLowerCase() === toTokenAddress.toLowerCase(),
    )
    const toTokenDecimals = toTokenConfig?.decimals ?? 18
    const toTokenSymbol = toTokenConfig?.symbol ?? params.toToken

    if (!ethers.isAddress(params.destinationAddress)) {
      throw new Error(`Invalid destinationAddress: ${params.destinationAddress}`)
    }

    const amount = ethers.parseUnits(params.amount, fromToken.decimals)
    const slippageBps = params.slippageBps ?? 50

    this.emit({
      type: 'step',
      step: 1,
      totalSteps: 6,
      title: 'Quote',
      message: `Bridging ${params.amount} ${fromToken.symbol} (${sourceChainConfig.name}) -> ${toTokenSymbol} (${destChainConfig.name})`,
    })

    const lifi = new LiFiProvider(params.lifiApiKey)
    const quote = await lifi.getBridgeQuote({
      fromChainId: sourceChainConfig.chainId,
      toChainId: destChainConfig.chainId,
      fromToken: fromToken.address,
      toToken: toTokenAddress,
      fromAmount: amount,
      fromAddress: RELAY_ADAPT_ADDRESS,
      toAddress: params.destinationAddress,
      slippageBps,
    })

    this.emit({
      type: 'info',
      title: 'Route',
      message: `${quote.toolName} — ETA ${quote.estimatedDurationSec}s, fee ${ethers.formatUnits(quote.feeAmount, fromToken.decimals)} ${fromToken.symbol}`,
    })

    // Build the source-chain multicall: [approve Diamond, call Diamond]
    const erc20 = new ethers.Interface(ERC20_ABI)
    const userCalls = [
      {
        to: fromToken.address,
        data: erc20.encodeFunctionData('approve', [quote.approvalAddress, amount]),
        value: '0',
      },
      {
        to: quote.to,
        data: quote.data,
        value: quote.value,
      },
    ]

    const result = await this.executeCrossContractCall({
      tokenAddress: fromToken.address,
      amount,
      userCalls,
      // No explicit output token on source chain — LI.FI Diamond consumes input.
      // executeCrossContractCall auto-adds input token to shield list, so any
      // unconsumed remainder re-shields back to the pool safely.
      shieldTokens: [],
      stepOffset: 1,
      totalSteps: 6,
    })

    return {
      txHash: result.txHash,
      tool: quote.toolName,
      fromChain: sourceChainConfig.name,
      toChain: destChainConfig.name,
      fromToken: fromToken.symbol,
      toToken: toTokenSymbol,
      amountIn: params.amount,
      expectedAmountOut: ethers.formatUnits(quote.toAmount, toTokenDecimals),
      minAmountOut: ethers.formatUnits(quote.toAmountMin, toTokenDecimals),
      destinationAddress: params.destinationAddress,
      estimatedDurationSec: quote.estimatedDurationSec,
    }
  }

  /**
   * Execute a private cross-contract call through RelayAdapt.
   *
   * Core pipeline:
   * 1. Derive Railgun keys
   * 2. Fetch UTXOs from privacy pool (smart wallet + EOA)
   * 3. Build shield requests for output tokens
   * 4. Compute adaptParams
   * 5. Generate ZK proof with adaptContract=RelayAdapt
   * 6. Build relay() transaction
   * 7. Submit as UserOp via facilitator
   * 8. Cache output shields from receipt
   */
  private async executeCrossContractCall(params: {
    tokenAddress: string
    amount: bigint
    userCalls: Array<{ to: string; data: string; value?: string }>
    shieldTokens: Array<{ tokenAddress: string }>
    stepOffset?: number
    totalSteps?: number
  }): Promise<{ txHash: string }> {
    const { tokenAddress, amount, userCalls, shieldTokens, stepOffset = 0, totalSteps = 6 } = params

    const step = (n: number, title: string, message: string) => {
      this.emit({ type: 'step', step: stepOffset + n, totalSteps, title, message })
    }

    // ── Step 1: Derive Railgun keys ───────────────────────────────────
    step(1, 'Keys', 'Deriving privacy keys')

    const { deriveRailgunKeys, getRailgunAddress } = await import('./privacy/lib/key-derivation')
    const masterSigner = this.config.signer ?? new ethers.Wallet(this.config.privateKey!)
    const signature = await masterSigner.signMessage(INCOGNITO_MESSAGE)
    const keys = await deriveRailgunKeys(signature)
    const railgunAddress = getRailgunAddress(keys)
    const masterEOA = await masterSigner.getAddress()

    // ── Step 2: Fetch UTXOs from pool ─────────────────────────────────
    step(2, 'Pool scan', 'Fetching spendable UTXOs')

    const { fetchSpendableUTXOs } = await import('./privacy/lib/utxo-fetcher')
    const chainId = this.chainId

    // Query all three addresses: smart wallet, master EOA, and incognito EOA
    const [swUtxos, eoaUtxos, incognitoUtxos] = await Promise.all([
      fetchSpendableUTXOs(this.wallet, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, tokenAddress, chainId).catch(() => []),
      fetchSpendableUTXOs(masterEOA, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, tokenAddress, chainId).catch(() => []),
      fetchSpendableUTXOs(this.incognitoEOA, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, tokenAddress, chainId).catch(() => []),
    ])

    // Deduplicate by position+tree
    const seen = new Set<string>()
    const utxos: typeof swUtxos = []
    for (const u of [...swUtxos, ...eoaUtxos, ...incognitoUtxos]) {
      const key = `${u.tree}-${u.position}`
      if (!seen.has(key)) {
        seen.add(key)
        utxos.push(u)
      }
    }

    if (utxos.length === 0) {
      throw new Error('No shielded balance found. Shield tokens first with b402.shield()')
    }

    // Single-input proof: find the largest UTXO for this token that covers the amount.
    // If no single UTXO is large enough, use the largest one available (caller handles batching).
    const tokenUTXOs = utxos
      .filter(u => u.note.tokenAddress.toLowerCase() === tokenAddress.toLowerCase())
      .sort((a, b) => Number(b.note.value - a.note.value)) // Largest first

    if (tokenUTXOs.length === 0) {
      throw new Error('Insufficient shielded balance')
    }

    // Prefer a UTXO that covers the full amount
    let utxo = tokenUTXOs.find(u => u.note.value >= amount)

    // If no single UTXO covers the amount but total balance does, auto-consolidate
    if (!utxo) {
      const total = tokenUTXOs.reduce((s, u) => s + u.note.value, 0n)
      if (total >= amount && tokenUTXOs.length > 1) {
        // Pass token address directly — resolveToken handles 0x addresses
        const tokenEntry = Object.entries(BASE_TOKENS).find(
          ([_, t]) => t.address.toLowerCase() === tokenAddress.toLowerCase()
        )
        const tokenRef = tokenEntry ? tokenEntry[0] : tokenAddress

        this.emit({ type: 'info', title: 'Auto-consolidate', message: `No single UTXO covers amount. Merging ${tokenUTXOs.length} UTXOs first.` })
        await this.consolidate({ token: tokenRef })

        // Wait for indexing after consolidation (backend needs time to index the re-shielded UTXO)
        const maxRetries = 6
        for (let retry = 0; retry < maxRetries; retry++) {
          if (retry > 0) {
            this.emit({ type: 'info', title: 'Indexing', message: `Waiting for consolidated UTXO... (${retry * 5}s)` })
            await new Promise(r => setTimeout(r, 5000))
          }

          const [swUtxos2, eoaUtxos2, incUtxos2] = await Promise.all([
            fetchSpendableUTXOs(this.wallet, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, tokenAddress, chainId).catch(() => []),
            fetchSpendableUTXOs(masterEOA, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, tokenAddress, chainId).catch(() => []),
            fetchSpendableUTXOs(this.incognitoEOA, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, tokenAddress, chainId).catch(() => []),
          ])

          const seen2 = new Set<string>()
          const refreshed: typeof swUtxos2 = []
          for (const u of [...swUtxos2, ...eoaUtxos2, ...incUtxos2]) {
            const k = `${u.tree}-${u.position}`
            if (!seen2.has(k)) { seen2.add(k); refreshed.push(u) }
          }

          utxo = refreshed
            .filter(u => u.note.tokenAddress.toLowerCase() === tokenAddress.toLowerCase())
            .sort((a, b) => Number(b.note.value - a.note.value))[0]

          if (utxo && utxo.note.value >= amount) break
        }

        if (!utxo || utxo.note.value < amount) {
          throw new Error('Consolidation completed but UTXO not yet indexed. Try again in 30 seconds.')
        }
      } else {
        utxo = tokenUTXOs[0] // fallback to largest (will fail downstream if too small)
      }
    }

    // ── Step 3: Build shield requests + ordered calls ─────────────────
    step(3, 'Building', 'Building cross-contract calls')

    const {
      buildRelayShieldRequests,
      computeAdaptParams,
      buildOrderedCalls,
      buildRelayCalldata,
    } = await import('./privacy/lib/relay-adapt')
    const relayAdaptAddress = getRelayAdaptAddress(this.chainId)

    // Ensure input token is also in shield list (re-shield any remainder)
    // Auto-add input token to shield list so leftover dust comes back to the
    // pool — but only on Base. The Arb B402 Railgun fork reverts on 0-balance
    // shields, so for fully-consuming flows (privateLend / privateSwap) we'd
    // get a CallFailed at the shield step. Callers that want input-token
    // re-shield on Arb must include it in `shieldTokens` explicitly.
    const allShieldTokens = [...shieldTokens]
    if (
      this.chainId === 8453 &&
      !allShieldTokens.some((s) => s.tokenAddress.toLowerCase() === tokenAddress.toLowerCase())
    ) {
      allShieldTokens.push({ tokenAddress })
    }

    const { shieldCallData } = await buildRelayShieldRequests(railgunAddress, allShieldTokens)

    // Build ordered calls: user calls + shield call at end (chain-specific RelayAdapt)
    const orderedCalls = buildOrderedCalls(userCalls, shieldCallData, tokenAddress, allShieldTokens, relayAdaptAddress)

    // ── Step 4: Compute adaptParams + build proof ─────────────────────
    step(4, 'ZK proof', 'Generating zero-knowledge proof (5-30s)')

    const { TransactNote } = await import('@railgun-community/engine')
    const nullifier = TransactNote.getNullifier(keys.nullifyingKey, utxo.position)
    const nullifierHex = `0x${nullifier.toString(16).padStart(64, '0')}`

    // Generate relay random (31 bytes for ActionData.random)
    const relayRandom = ethers.randomBytes(31)

    const actionData = {
      random: relayRandom,
      requireSuccess: true,
      minGasLimit: 0n,
      calls: orderedCalls,
    }

    const adaptParamsHash = computeAdaptParams([nullifierHex], actionData)

    // Build proof with adaptContract = RelayAdapt
    const { buildUnshieldProofInputs, verifyMerkleProof } = await import('./privacy/lib/proof-inputs')
    const { generateProofClientSide } = await import('./privacy/lib/prover')
    const { ByteUtils, ByteLength } = await import('@railgun-community/engine')
    const { poseidonHex } = await import('@railgun-community/engine/dist/utils/poseidon')

    // Verify merkle proof before expensive ZK proof generation
    const commitmentTokenAddress = utxo.commitment.tokenAddress.toLowerCase()
    const commitment = ByteUtils.hexToBigInt(
      poseidonHex([
        ByteUtils.nToHex(utxo.note.notePublicKey, ByteLength.UINT_256),
        commitmentTokenAddress,
        ByteUtils.nToHex(utxo.note.value, ByteLength.UINT_256),
      ])
    )

    if (!verifyMerkleProof(commitment, utxo.merkleProof)) {
      throw new Error('Merkle proof verification failed')
    }

    // Build proof inputs — unshield full UTXO to RelayAdapt (chain-specific)
    const proofInputs = buildUnshieldProofInputs({
      utxo,
      nullifyingKey: keys.nullifyingKey,
      spendingKeyPair: keys.spendingKeyPair,
      unshieldAmount: utxo.note.value, // Full UTXO value
      recipientAddress: relayAdaptAddress,
      tokenAddress,
    })

    // Generate ZK proof with adaptContract + adaptParams
    const proofResult = await generateProofClientSide({
      ...proofInputs,
      spendingPrivateKey: keys.spendingKeyPair.privateKey,
      chainId,
      treeNumber: utxo.tree,
      outputCount: 1,
      adaptContract: relayAdaptAddress,
      adaptParams: adaptParamsHash,
    })

    this.emit({ type: 'info', title: 'Proof', message: 'ZK proof generated' })

    // ── Step 5: Build relay() transaction ─────────────────────────────
    step(5, 'Submitting', 'Building relay transaction')

    const { formatUnshieldTransaction } = await import('./privacy/lib/transaction-formatter')

    const txStruct = formatUnshieldTransaction({
      proofResult,
      treeNumber: utxo.tree,
      tokenAddress,
      recipientAddress: relayAdaptAddress,
      unshieldAmount: utxo.note.value,
      chainId,
    })

    const relayTx = buildRelayCalldata(txStruct, actionData, relayAdaptAddress)

    // ── Step 6: Submit as UserOp ─────────────────────────────────────
    step(6, 'Executing', 'Submitting via facilitator')

    const calls: Call[] = [
      { to: relayTx.to, value: '0', data: relayTx.data },
    ]

    const result = await this.submitUserOp(calls)

    // Cache output shields from receipt
    try {
      const receipt = await this.provider.getTransactionReceipt(result.txHash)
      if (receipt) {
        await this.cacheShieldFromReceipt(result.txHash, receipt)
      }
    } catch {
      // Shield caching is best-effort
    }

    this.emit({ type: 'done', title: 'Done', message: `Private DeFi TX: ${result.txHash}` })
    return result
  }

  // ── Shielded balance (privacy pool) ─────────────────────────────────

  private async getShieldedBalances(): Promise<{ token: string; balance: string; address?: string }[]> {
    try {
      const { deriveRailgunKeys } = await import('./privacy/lib/key-derivation')
      const { fetchSpendableUTXOsLightweight } = await import('./privacy/lib/utxo-fetcher')

      const masterSigner = this.config.signer ?? new ethers.Wallet(this.config.privateKey!)
      const signature = await masterSigner.signMessage(INCOGNITO_MESSAGE)
      const keys = await deriveRailgunKeys(signature)
      const masterEOA = await masterSigner.getAddress()

      // Query UTXOs from all three addresses:
      // 1. Smart wallet — backend indexes UserOp shields by smart wallet
      //                    + in-memory cache from cacheShieldFromReceipt
      // 2. Master EOA — for old EOA-based shields
      // 3. Incognito EOA — dashboard shields indexed under incognito address
      // Client-side decryption ensures only our commitments are included
      const [swUtxos, eoaUtxos, incognitoUtxos] = await Promise.all([
        fetchSpendableUTXOsLightweight(this.wallet, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, undefined, this.chainId).catch(() => []),
        fetchSpendableUTXOsLightweight(masterEOA, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, undefined, this.chainId).catch(() => []),
        fetchSpendableUTXOsLightweight(this.incognitoEOA, keys.viewingKeyPair.privateKey, keys.masterPublicKey, keys.nullifyingKey, undefined, this.chainId).catch(() => []),
      ])

      // Deduplicate by position+tree
      const seen = new Set<string>()
      const allUtxos: typeof swUtxos = []
      for (const u of [...swUtxos, ...eoaUtxos, ...incognitoUtxos]) {
        const key = `${u.tree}-${u.position}`
        if (!seen.has(key)) {
          seen.add(key)
          allUtxos.push(u)
        }
      }

      // Aggregate balances across all UTXOs — discover tokens dynamically
      const balByAddr: Record<string, bigint> = {}
      for (const u of allUtxos) {
        const addr = u.note.tokenAddress.toLowerCase()
        balByAddr[addr] = (balByAddr[addr] ?? 0n) + u.note.value
      }

      // Build known token lookup for the active chain.
      // Vault share tokens are resolved on-chain (their decimals differ from underlying).
      const knownMeta: Record<string, { symbol: string; decimals: number }> = {}
      const chainTokensForMeta = B402_CHAINS[this.chainId]?.tokens ?? {}
      for (const [symbol, token] of Object.entries(chainTokensForMeta)) {
        knownMeta[token.address.toLowerCase()] = { symbol, decimals: token.decimals }
      }

      // Resolve unknown tokens on-chain
      const erc20Meta = new ethers.Interface([
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
      ])
      const unknownAddrs = Object.keys(balByAddr).filter(addr => !knownMeta[addr] && balByAddr[addr] > 0n)
      const resolved = await Promise.all(
        unknownAddrs.map(async (addr) => {
          try {
            const contract = new ethers.Contract(addr, erc20Meta, this.provider)
            const [symbol, decimals] = await Promise.all([
              contract.symbol() as Promise<string>,
              contract.decimals() as Promise<bigint>,
            ])
            return { addr, symbol, decimals: Number(decimals) }
          } catch {
            return { addr, symbol: addr.slice(0, 10) + '...', decimals: 18 }
          }
        })
      )
      for (const r of resolved) {
        knownMeta[r.addr] = { symbol: r.symbol, decimals: r.decimals }
      }

      const results: { token: string; balance: string; address?: string }[] = []
      for (const [addr, bal] of Object.entries(balByAddr)) {
        if (bal <= 0n) continue
        const meta = knownMeta[addr] ?? { symbol: addr.slice(0, 10) + '...', decimals: 18 }
        results.push({ token: meta.symbol, balance: ethers.formatUnits(bal, meta.decimals), address: addr })
      }
      return results
    } catch (err: any) {
      console.error('[getShieldedBalances] Error:', err.message)
      return []
    }
  }

  // ── Wallet derivation ──────────────────────────────────────────────

  private async init() {
    if (this._initialized) return
    // Derive incognito wallet from master key or signer
    const masterSigner = this.config.signer ?? new ethers.Wallet(this.config.privateKey!)
    const sig = await masterSigner.signMessage(INCOGNITO_MESSAGE)
    this.incognitoKey = ethers.keccak256(sig)
    this.incognitoWallet = new ethers.Wallet(this.incognitoKey, this.provider)
    this.incognitoEOA = this.incognitoWallet.address

    // Deterministic salt (must match facilitator's b402-incognito convention)
    this.salt = ethers.keccak256(
      ethers.toUtf8Bytes(`${SALT_PREFIX}-${this.incognitoEOA.toLowerCase()}`)
    )

    // Compute smart wallet via Nexus factory (same as incognito-wallet.ts)
    const validatorInitData = ethers.solidityPacked(['address'], [this.incognitoEOA])
    const bootstrapInterface = new ethers.Interface([
      'function initNexusWithDefaultValidator(bytes calldata data)',
    ])
    const bootstrapCall = bootstrapInterface.encodeFunctionData(
      'initNexusWithDefaultValidator',
      [validatorInitData],
    )
    const initData = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'bytes'],
      [BASE_CONTRACTS.NEXUS_BOOTSTRAP, bootstrapCall],
    )
    const saltBytes32 = ethers.zeroPadValue(ethers.toBeHex(BigInt(this.salt)), 32)

    const factoryInterface = new ethers.Interface([
      'function computeAccountAddress(bytes calldata initData, bytes32 salt) view returns (address)',
    ])
    const callData = factoryInterface.encodeFunctionData('computeAccountAddress', [
      initData,
      saltBytes32,
    ])
    const result = await this.provider.call({ to: BASE_CONTRACTS.NEXUS_FACTORY, data: callData })
    this.wallet = factoryInterface.decodeFunctionResult('computeAccountAddress', result)[0] as string

    this._initialized = true
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private emit(event: ProgressEvent) {
    this.config.onProgress?.(event)
  }

  /** Resolve a token symbol or address to {address, symbol, decimals} for the active chain. */
  resolveToken(nameOrAddress: string): { address: string; symbol: string; decimals: number } {
    const upper = nameOrAddress.toUpperCase()
    const chainTokens = B402_CHAINS[this.chainId]?.tokens ?? {}
    if (chainTokens[upper]) {
      const t = chainTokens[upper]
      return { address: t.address, symbol: t.symbol, decimals: t.decimals }
    }
    // Fallback to BASE_TOKENS for backward compatibility (Base-only tokens like AERO etc.)
    if (this.chainId === 8453 && BASE_TOKENS[upper as keyof typeof BASE_TOKENS]) {
      return BASE_TOKENS[upper as keyof typeof BASE_TOKENS]
    }
    if (nameOrAddress.startsWith('0x') && nameOrAddress.length === 42) {
      return { address: nameOrAddress, symbol: nameOrAddress.slice(0, 8), decimals: 18 }
    }
    throw new Error(
      `Unknown token: ${nameOrAddress} on chain ${this.chainId}. Available: ${Object.keys(chainTokens).join(', ')}`,
    )
  }

  // ── Static helpers ─────────────────────────────────────────────────

  static get vaults() {
    return Object.entries(MORPHO_VAULTS).map(([name, v]) => ({
      name, fullName: v.name, address: v.address, curator: v.curator,
    }))
  }

  static get tokens() {
    return Object.entries(BASE_TOKENS).map(([symbol, t]) => ({
      symbol, address: t.address, decimals: t.decimals,
    }))
  }

  static get pools() {
    return Object.entries(AERODROME_POOLS).map(([name, p]: [string, any]) => ({
      name, fullName: p.name, poolAddress: p.poolAddress, gaugeAddress: p.gaugeAddress,
    }))
  }

  static get perpMarkets() {
    return Object.entries(PERPS_MARKETS).map(([symbol, id]) => ({ symbol, marketId: id }))
  }

  static get speedMarketAssets() {
    return ['ETH', 'BTC']
  }

  // ── Unified dispatcher ────────────────────────────────────────────────
  //
  // `execute` is the one-verb surface for agents: pass `{ action, ...args }`
  // and it routes to the matching typed method. The discriminated union
  // preserves full autocomplete — picking an `action` narrows the rest of
  // the params to exactly that method's shape.
  async execute<A extends ExecuteParams['action']>(
    params: Extract<ExecuteParams, { action: A }>,
  ): Promise<ExecuteResultMap[A]>
  async execute(params: ExecuteParams): Promise<ExecuteResult> {
    switch (params.action) {
      case 'privateSwap': {
        const { action: _a, ...rest } = params
        return this.privateSwap(rest)
      }
      case 'privateLend': {
        const { action: _a, ...rest } = params
        return this.privateLend(rest)
      }
      case 'privateRedeem': {
        const { action: _a, ...rest } = params
        return this.privateRedeem(rest)
      }
      case 'privateCrossChain': {
        const { action: _a, ...rest } = params
        return this.privateCrossChain(rest)
      }
      case 'shield': {
        const { action: _a, ...rest } = params
        return this.shield(rest)
      }
      case 'unshield': {
        const { action: _a, ...rest } = params
        return this.unshield(rest)
      }
      default: {
        const exhaustive: never = params
        throw new Error(`Unknown action: ${(exhaustive as { action: string }).action}`)
      }
    }
  }
}

// ── execute() param union & result map ─────────────────────────────────

export type ExecuteParams =
  | ({ action: 'privateSwap' } & PrivateSwapParams)
  | ({ action: 'privateLend' } & PrivateLendParams)
  | ({ action: 'privateRedeem' } & PrivateRedeemParams)
  | ({ action: 'privateCrossChain' } & PrivateCrossChainParams)
  | ({ action: 'shield' } & ShieldParams)
  | ({ action: 'unshield' } & UnshieldParams)

export interface ExecuteResultMap {
  privateSwap: PrivateSwapResult
  privateLend: PrivateLendResult
  privateRedeem: PrivateRedeemResult
  privateCrossChain: PrivateCrossChainResult
  shield: ShieldResult
  unshield: UnshieldResult
}

export type ExecuteResult = ExecuteResultMap[keyof ExecuteResultMap]

// ── Convenience exports ───
export { BASE_TOKENS, BASE_CONTRACTS } from './types'
export { MORPHO_VAULTS } from './lend/morpho-vaults'
