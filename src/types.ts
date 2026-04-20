/**
 * Private Trading Worker — Core Type Definitions
 *
 * Types for the agent runtime that executes private DeFi recipes
 * (swap, DCA, payout) from Railgun shielded balances via ERC-4337 smart wallets.
 */

// ═══════════════ WORKER CONFIG ═══════════════

export interface WorkerConfig {
  /** Unique worker identifier */
  workerId: string
  /** Target chain ID (8453 = Base) */
  chainId: number
  /** RPC endpoint URL */
  rpcUrl: string
  /** Backend API for UTXO indexing + merkle proofs */
  backendApiUrl: string
  /** Worker's EOA private key (signs UserOps) */
  privateKey: string
  /** Computed smart wallet address (counterfactual or deployed) */
  smartWalletAddress?: string
  /** Paymaster contract address */
  paymasterAddress: string
  /** Paymaster signer private key */
  paymasterSignerKey: string
  /** 0x API key for swap routing */
  zeroXApiKey: string
  /** Railgun relay contract address */
  railgunRelay: string
  /** EntryPoint v0.7 address */
  entryPoint: string
  /** Nexus factory address */
  nexusFactory: string
  /** Aerodrome router address */
  aerodromeRouter: string
  /** Directory for state + receipt files */
  stateDir: string
}

// ═══════════════ RECIPE CONFIG ═══════════════

export type RecipeType = 'swap' | 'dca' | 'payout' | 'lend'

export interface SwapRecipeConfig {
  type: 'swap'
  /** Token to sell (symbol, e.g., 'USDC') */
  tokenIn: string
  /** Token to buy (symbol, e.g., 'WETH') */
  tokenOut: string
  /** Human-readable amount to swap (e.g., '100') */
  amount: string
  /** Max slippage in basis points (e.g., 50 = 0.5%) */
  slippageBps: number
  /** Preferred swap provider ('0x' | 'aerodrome' | 'auto') */
  provider?: '0x' | 'aerodrome' | 'auto'
}

export interface DCARecipeConfig {
  type: 'dca'
  tokenIn: string
  tokenOut: string
  /** Amount per swap */
  amount: string
  slippageBps: number
  /** Interval between swaps in seconds */
  intervalSeconds: number
  /** Max total spend (stop condition) */
  maxSpendTotal: string
  /** Max drawdown % (stop condition) */
  maxDrawdownPercent: number
  provider?: '0x' | 'aerodrome' | 'auto'
}

export interface PayoutRecipeConfig {
  type: 'payout'
  /** Token to pay out */
  token: string
  /** Amount to pay out */
  amount: string
  /** 'transact' = to 0zk address (fully private), 'unshield' = to fresh EOA */
  mode: 'transact' | 'unshield'
  /** Recipient address (0zk for transact, 0x for unshield) */
  recipientAddress: string
}

export interface LendRecipeConfig {
  type: 'lend'
  /** Token to deposit (symbol, e.g., 'USDC') */
  token: string
  /** Human-readable amount (e.g., '100') */
  amount: string
  /** Vault name (e.g., 'steakhouse') or address */
  vault: string
  /** 'deposit' or 'redeem' */
  action: 'deposit' | 'redeem'
}

export type RecipeConfig = SwapRecipeConfig | DCARecipeConfig | PayoutRecipeConfig | LendRecipeConfig

// ═══════════════ WORKER STATE ═══════════════

export type WorkerStatus = 'idle' | 'initializing' | 'running' | 'paused' | 'stopped' | 'error'

export interface WorkerState {
  workerId: string
  status: WorkerStatus
  smartWalletAddress: string
  /** Total executions completed */
  executionCount: number
  /** Total volume swapped (in tokenIn units, human-readable) */
  totalVolumeIn: string
  /** Shielded balances by token symbol */
  shieldedBalances: Record<string, string>
  /** On-chain wallet balances by token symbol */
  walletBalances: Record<string, string>
  /** Timestamp of last execution */
  lastExecutionAt: number
  /** Last error message if status = 'error' */
  lastError?: string
  /** DCA-specific: cumulative spend */
  cumulativeSpend?: string
  /** DCA-specific: current cycle index */
  currentCycle?: number
  /** Timestamp of state save */
  updatedAt: number
}

// ═══════════════ SWAP QUOTE ═══════════════

export interface SwapQuoteParams {
  sellToken: string
  buyToken: string
  /** Amount in wei/smallest unit */
  sellAmount: bigint
  /** Smart wallet address (taker) */
  taker: string
  /** Max slippage in basis points */
  slippageBps: number
}

export interface SwapQuote {
  /** Provider that generated this quote */
  provider: string
  /** Sell token address */
  sellToken: string
  /** Buy token address */
  buyToken: string
  /** Sell amount in wei */
  sellAmount: bigint
  /** Expected buy amount in wei */
  buyAmount: bigint
  /** Address to approve tokens for */
  allowanceTarget: string
  /** Router/exchange address to call */
  to: string
  /** Encoded swap calldata */
  data: string
  /** ETH value to send with call (usually '0') */
  value: string
  /** Estimated gas for the swap */
  estimatedGas: bigint
}

// ═══════════════ EXECUTION RECEIPT ═══════════════

export interface ExecutionReceipt {
  /** Unique receipt ID */
  receiptId: string
  /** Worker that executed this */
  workerId: string
  /** Recipe type */
  recipeType: RecipeType
  /** Execution timestamp (ms) */
  timestamp: number
  /** Token sold */
  tokenIn: string
  /** Token bought */
  tokenOut: string
  /** Amount sold (human-readable) */
  amountIn: string
  /** Amount received (human-readable) */
  amountOut: string
  /** Transaction hashes for each step */
  txHashes: {
    unshield?: string
    approve?: string
    swap?: string
    shield?: string
    /** Combined UserOp tx hash (all steps in one) */
    userOp?: string
  }
  /** Fee breakdown */
  fees: {
    /** Railgun unshield fee (0% on b402 fork) */
    railgunFee: string
    /** Gas cost in ETH (0 if paymaster covers) */
    gasCost: string
    /** b402 protocol fee */
    b402Fee: string
  }
  /** Policy compliance */
  policy: {
    /** keccak256 of the policy used */
    policyHash: string
    /** Whether execution was within policy limits */
    withinLimits: boolean
  }
  /** Execution status */
  status: 'success' | 'failed'
  /** Error message if failed */
  error?: string
  /** Total execution duration in ms */
  duration: number
}

// ═══════════════ FEE TYPES ═══════════════

export interface FeeBreakdown {
  /** Total fee in token's smallest unit */
  totalFee: bigint
  /** Base fee (flat, e.g., $0.05) */
  baseFee: bigint
  /** Volume-based fee (tiered bps) */
  volumeFee: bigint
  /** Volume tier rate (bps) */
  tierBps: number
}

export type FeeTier = 'small' | 'medium' | 'large'

// ═══════════════ CONSTANTS ═══════════════

/** Base Mainnet token addresses */
export const BASE_TOKENS = {
  USDC: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const,
    symbol: 'USDC' as const,
    decimals: 6,
  },
  WETH: {
    address: '0x4200000000000000000000000000000000000006' as const,
    symbol: 'WETH' as const,
    decimals: 18,
  },
  DAI: {
    address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb' as const,
    symbol: 'DAI' as const,
    decimals: 18,
  },
  AERO: {
    address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631' as const,
    symbol: 'AERO' as const,
    decimals: 18,
  },
  USDT: {
    address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' as const,
    symbol: 'USDT' as const,
    decimals: 6,
  },
} as const

/** Base Mainnet contract addresses */
export const BASE_CONTRACTS = {
  RAILGUN_RELAY: '0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85' as const,
  ENTRY_POINT: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const,
  NEXUS_FACTORY: '0x0000006648ED9B2B842552BE63Af870bC74af837' as const,
  NEXUS_BOOTSTRAP: '0x0000003eDf18913c01cBc482C978bBD3D6E8ffA3' as const,
  K1_VALIDATOR: '0x0000000031ef4155C978d48a8A7d4EDba03b04fE' as const,
  PAYMASTER: '0x9C2D794Cc5ac6C33CDFCb9Ea225766c5CB681650' as const,
  AERODROME_ROUTER: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43' as const,
} as const

/** Railgun unshield fee in basis points (0% — b402 fork has no protocol fees) */
export const RAILGUN_UNSHIELD_FEE_BPS = 0n

/** B402 backend API for Base */
export const BASE_BACKEND_API_URL = 'https://b402-base-api-62092339396.us-central1.run.app'
