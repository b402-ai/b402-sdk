/**
 * Build Shield Transaction - Returns unsigned transaction data
 * 
 * This function builds the shield transaction without sending it,
 * allowing for gasless relay where the relayer broadcasts the signed tx.
 */

import { ethers, Wallet, JsonRpcProvider } from 'ethers'
import type { SupportedToken } from './local-config'
import { getTokenAddress } from './tokens'
import { deriveMnemonicFromEOA, getShieldPrivateKey } from './railgun'
import { getDefaultChainId, getRailgunRelay, RAILGUN_NETWORK_MAP, getChainConfig } from '../../config/chains'

export interface BuildShieldOptions {
  invoicePrivateKey: string  // Private key of invoice wallet
  amount: string             // Human-readable amount (e.g., "10.50")
  token: SupportedToken
  network?: 'mainnet' | 'testnet'
  chainId?: number
  rpcUrl?: string
}

export interface ShieldTransactionData {
  // Approve transaction (if needed)
  approveTx?: {
    to: string
    data: string
    nonce: number
    gasLimit: bigint
    gasPrice: bigint
  }
  // Shield transaction
  shieldTx: {
    to: string
    data: string
    value: bigint
    nonce: number
    gasLimit: bigint
    gasPrice: bigint
  }
  // Metadata
  railgunAddress: string
  tokenAddress: string
  amountWei: bigint
}

// Legacy constant — use getRailgunRelay(chainId) for multi-chain
const RAILGUN_SMART_WALLET = '0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601'

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)'
]

/**
 * Build shield transaction data without sending
 * Returns unsigned transaction data that can be signed offline and broadcast by a relayer
 */
export async function buildShieldTransaction(options: BuildShieldOptions): Promise<ShieldTransactionData> {
  const {
    invoicePrivateKey,
    amount,
    token,
    network = 'mainnet',
    rpcUrl
  } = options

  const chainId = options.chainId || getDefaultChainId()
  const chainCfg = getChainConfig(chainId)
  const railgunNetwork = RAILGUN_NETWORK_MAP[chainId]
  if (!railgunNetwork) throw new Error(`No Railgun network mapping for chain ${chainId}`)
  const railgunContractAddress = getRailgunRelay(chainId)

  // Use centralized RPC config
  const effectiveRpc = rpcUrl || chainCfg.rpc

  // Dynamic imports for Railgun SDK
  const wallet = await import('@railgun-community/wallet')
  const { MemoryLevel } = await import('memory-level')

  const provider = new JsonRpcProvider(effectiveRpc)
  const invoiceWallet = new Wallet(invoicePrivateKey, provider)
  const invoiceAddress = invoiceWallet.address

  const tokenAddress = getTokenAddress(network, token, chainId)

  // Initialize Railgun engine
  const db = new MemoryLevel()
  const storage = new Map<string, string | Buffer>()
  const artifactStore = new wallet.ArtifactStore(
    async (path: string) => {
      const item = storage.get(path)
      if (!item) throw new Error(`Artifact not found: ${path}`)
      return item
    },
    async (_dir: string, path: string, item: string | Uint8Array) => {
      storage.set(path, typeof item === 'string' ? item : Buffer.from(item))
    },
    async (path: string) => storage.has(path)
  )

  await wallet.startRailgunEngine(
    'b402shield',
    db,
    false, // shouldDebug
    artifactStore,
    false, // useNativeArtifacts
    false, // skipMerkletreeScans - must be false to create wallets
    ['https://ppoi-agg.horsewithsixlegs.xyz'],
    [],
    false
  )

  try {
    // Load provider config - Railgun SDK requires at least 2 providers for fallback
    const chainConfig = {
      chainId,
      providers: [{
        provider: effectiveRpc,
        priority: 1,
        weight: 1,
        stallTimeout: 2500
      }, {
        provider: effectiveRpc,  // Same RPC as fallback
        priority: 2,
        weight: 1,
        stallTimeout: 2500
      }]
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sharedModels = await import('@railgun-community/shared-models') as any
    const networkName = sharedModels.NetworkName?.[railgunNetwork.networkName] ?? railgunNetwork.networkName
    await wallet.loadProvider(chainConfig, networkName, 60000)

    // Derive mnemonic from invoice wallet private key
    const mnemonic = await deriveMnemonicFromEOA(invoicePrivateKey)

    // Create Railgun wallet to get the railgun address
    const encryptionKey = ethers.keccak256(ethers.toUtf8Bytes('b402-encryption-key')).slice(2)
    const creationBlockNumbers = { [networkName]: railgunNetwork.creationBlock }
    const walletInfo = await wallet.createRailgunWallet(encryptionKey, mnemonic, creationBlockNumbers)
    const railgunAddress = walletInfo.railgunAddress

    // Check token balance
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider)
    const balance = await tokenContract.balanceOf(invoiceAddress)
    const amountWei = ethers.parseUnits(amount, 18)

    if (balance < amountWei) {
      throw new Error(`Insufficient balance. Have: ${ethers.formatUnits(balance, 18)}, Need: ${amount}`)
    }

    // Get current nonce and gas price
    const currentNonce = await provider.getTransactionCount(invoiceAddress)
    const feeData = await provider.getFeeData()
    const gasPrice = feeData.gasPrice || ethers.parseUnits('3', 'gwei')

    let result: ShieldTransactionData

    // Check if approval needed
    const allowance = await tokenContract.allowance(invoiceAddress, railgunContractAddress)
    const needsApproval = allowance < balance

    // Build approve transaction if needed
    let approveTx: ShieldTransactionData['approveTx']
    let shieldNonce = currentNonce

    if (needsApproval) {
      const approveData = new ethers.Interface(ERC20_ABI).encodeFunctionData(
        'approve',
        [railgunContractAddress, ethers.MaxUint256]
      )
      
      approveTx = {
        to: tokenAddress,
        data: approveData,
        nonce: currentNonce,
        gasLimit: BigInt(100000),
        gasPrice
      }
      shieldNonce = currentNonce + 1
    }

    // Build shield transaction using Railgun SDK
    const shieldPrivateKey = getShieldPrivateKey()
    const erc20AmountRecipients = [{
      tokenAddress,
      amount: balance, // Shield full balance
      recipientAddress: railgunAddress
    }]

    const txidVersion = sharedModels.TXIDVersion?.V2_PoseidonMerkle ?? 'V2_PoseidonMerkle'
    
    const shieldResult = await wallet.populateShield(
      txidVersion,
      networkName,
      shieldPrivateKey,
      erc20AmountRecipients,
      []
    )

    console.log('[buildShieldTransaction] populateShield result:', JSON.stringify(shieldResult, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2))

    const transaction = shieldResult.transaction
    if (!transaction) {
      throw new Error('Failed to populate shield transaction')
    }

    console.log('[buildShieldTransaction] transaction.data length:', transaction.data?.length || 0)

    // IMPORTANT: B402 fork - use our contract address, not the SDK's default
    // The shield calldata should be compatible since it's the same contract code
    const shieldTx = {
      to: railgunContractAddress,  // B402 fork address
      data: transaction.data as string,
      value: transaction.value ? BigInt(transaction.value) : BigInt(0),
      nonce: shieldNonce,
      gasLimit: BigInt(500000),
      gasPrice
    }

    console.log('[buildShieldTransaction] Using B402 fork:', railgunContractAddress)

    result = {
      approveTx,
      shieldTx,
      railgunAddress,
      tokenAddress,
      amountWei: balance
    }

    return result

  } finally {
    await wallet.stopRailgunEngine()
  }
}

/**
 * Sign and serialize a transaction for relay
 */
export async function signTransactionForRelay(
  invoicePrivateKey: string,
  tx: { to: string; data: string; value?: bigint; nonce: number; gasLimit: bigint; gasPrice: bigint },
  chainId: number = 56
): Promise<string> {
  const wallet = new Wallet(invoicePrivateKey)

  const txRequest = {
    to: tx.to,
    data: tx.data,
    value: tx.value || BigInt(0),
    nonce: tx.nonce,
    gasLimit: tx.gasLimit,
    gasPrice: tx.gasPrice,
    chainId,
    type: 0 // Legacy transaction
  }

  return await wallet.signTransaction(txRequest)
}

// ============================================
// Smart Wallet Shield Calldata (for UserOp)
// ============================================

export interface ShieldCalldataResult {
  approveCall: {
    to: string
    value: string
    data: string
  }
  shieldCall: {
    to: string
    value: string
    data: string
  }
  railgunAddress: string
  tokenAddress: string
  balance: string
}

/**
 * Build shield calldata for use in a UserOp
 *
 * This is used for Smart Wallet invoices where the shield operation
 * is executed via ERC-4337 UserOp with paymaster sponsorship.
 *
 * Returns the approve and shield call data that will be batched in the UserOp.
 */
export async function buildShieldCalldata(
  invoicePrivateKey: string,
  token: SupportedToken,
  network: 'mainnet' | 'testnet' = 'mainnet',
  rpcUrl?: string,
  smartWalletAddress?: string,  // For smart invoices, tokens are at this address
  amount?: string,  // Specific amount to shield (if not provided, shields full balance)
  chainIdOverride?: number
): Promise<ShieldCalldataResult> {
  const chainId2 = chainIdOverride || getDefaultChainId()
  const chainCfg2 = getChainConfig(chainId2)
  const railgunNet2 = RAILGUN_NETWORK_MAP[chainId2]
  if (!railgunNet2) throw new Error(`No Railgun network mapping for chain ${chainId2}`)
  const railgunAddr2 = getRailgunRelay(chainId2)

  const effectiveRpc = rpcUrl || chainCfg2.rpc

  // Dynamic imports for Railgun SDK
  const walletSdk = await import('@railgun-community/wallet')
  const { MemoryLevel } = await import('memory-level')

  const provider = new JsonRpcProvider(effectiveRpc)
  const invoiceWallet = new Wallet(invoicePrivateKey, provider)
  const invoiceAddress = invoiceWallet.address

  // For smart invoices, check balance at smart wallet address
  // For regular invoices, check balance at EOA address
  const balanceCheckAddress = smartWalletAddress || invoiceAddress

  const tokenAddress = getTokenAddress(network, token, chainId2)

  // Initialize Railgun engine
  const db = new MemoryLevel()
  const storage = new Map<string, string | Buffer>()
  const artifactStore = new walletSdk.ArtifactStore(
    async (path: string) => {
      const item = storage.get(path)
      if (!item) throw new Error(`Artifact not found: ${path}`)
      return item
    },
    async (_dir: string, path: string, item: string | Uint8Array) => {
      storage.set(path, typeof item === 'string' ? item : Buffer.from(item))
    },
    async (path: string) => storage.has(path)
  )

  await walletSdk.startRailgunEngine(
    'b402shieldcall',
    db,
    false, // shouldDebug
    artifactStore,
    false, // useNativeArtifacts
    false, // skipMerkletreeScans - must be false to create wallets
    ['https://ppoi-agg.horsewithsixlegs.xyz'],
    [],
    false
  )

  try {
    // Load provider config - Railgun SDK requires at least 2 providers for fallback
    const chainConfig2 = {
      chainId: chainId2,
      providers: [{
        provider: effectiveRpc,
        priority: 1,
        weight: 1,
        stallTimeout: 2500
      }, {
        provider: effectiveRpc,  // Use same RPC as fallback
        priority: 2,
        weight: 1,
        stallTimeout: 2500
      }]
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sharedModels = await import('@railgun-community/shared-models') as any
    const networkName2 = sharedModels.NetworkName?.[railgunNet2.networkName] ?? railgunNet2.networkName
    await walletSdk.loadProvider(chainConfig2, networkName2, 60000)

    // Derive mnemonic from invoice wallet private key
    const mnemonic = await deriveMnemonicFromEOA(invoicePrivateKey)

    // Create Railgun wallet to get the railgun address
    const encryptionKey = ethers.keccak256(ethers.toUtf8Bytes('b402-encryption-key')).slice(2)
    const creationBlockNumbers = { [networkName2]: railgunNet2.creationBlock }
    const walletInfo = await walletSdk.createRailgunWallet(encryptionKey, mnemonic, creationBlockNumbers)
    const railgunAddress = walletInfo.railgunAddress

    // Check token balance at the correct address (smart wallet or EOA)
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider)
    const balance = await tokenContract.balanceOf(balanceCheckAddress)

    if (balance === BigInt(0)) {
      throw new Error(`No tokens to shield at ${balanceCheckAddress}`)
    }

    // Build approve calldata
    const approveData = new ethers.Interface(ERC20_ABI).encodeFunctionData(
      'approve',
      [railgunAddr2, ethers.MaxUint256]
    )

    const approveCall = {
      to: tokenAddress,
      value: '0',
      data: approveData
    }

    // Build shield calldata using Railgun SDK
    const shieldPrivateKey = getShieldPrivateKey()

    // Use specified amount or full balance
    const shieldAmount = amount ? ethers.parseUnits(amount, 18) : balance
    if (shieldAmount > balance) {
      throw new Error(`Insufficient balance: have ${ethers.formatUnits(balance, 18)}, need ${amount}`)
    }

    const erc20AmountRecipients = [{
      tokenAddress,
      amount: shieldAmount,
      recipientAddress: railgunAddress
    }]

    const txidVersion = sharedModels.TXIDVersion?.V2_PoseidonMerkle ?? 'V2_PoseidonMerkle'

    const { transaction } = await walletSdk.populateShield(
      txidVersion,
      networkName2,
      shieldPrivateKey,
      erc20AmountRecipients,
      []
    )

    if (!transaction || !transaction.to || !transaction.data) {
      throw new Error('Failed to populate shield transaction')
    }

    // IMPORTANT: Override transaction.to with our B402 fork address
    // The Railgun SDK returns the official Railgun address, but we need to use our fork
    const shieldCall = {
      to: railgunAddr2,  // Use our fork, not SDK's default
      value: transaction.value ? transaction.value.toString() : '0',
      data: transaction.data as string
    }

    return {
      approveCall,
      shieldCall,
      railgunAddress,
      tokenAddress,
      balance: ethers.formatUnits(balance, 18)
    }

  } finally {
    await walletSdk.stopRailgunEngine()
  }
}
