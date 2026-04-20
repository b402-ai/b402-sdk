/**
 * Shield operations - deposit tokens into Railgun
 */

import { ethers } from 'ethers'
import type { Signer } from 'ethers'
import type { SupportedToken } from './local-config'
import { getTokenAddress } from './tokens'
import { deriveMnemonicFromEOA, getShieldPrivateKey } from './railgun'
import { getCachedSignature } from './signature-cache'
import { getDefaultChainId, getRailgunRelay, RAILGUN_NETWORK_MAP, getChainConfig } from '../../config/chains'

export interface ShieldOptions {
  amount: string // Human-readable amount (e.g., "10.50")
  token: SupportedToken
  signer: Signer
  network?: 'mainnet' | 'testnet' // Defaults to mainnet
  chainId?: number
}

export interface ShieldResult {
  hash: string
  railgunAddress: string
  amount: string
  token: string
}

// Railgun Smart Wallet contract addresses — use getRailgunRelay(chainId) for multi-chain
const RAILGUN_SMART_WALLET: Record<string, string> = {
  mainnet: '0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601',
  testnet: '0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601'
}

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)'
]

/**
 * Shield tokens into Railgun
 * This deposits from doxxed wallet into shielded balance
 */
export async function shieldTokens(options: ShieldOptions): Promise<ShieldResult> {
  // Dynamic imports for Railgun SDK
  const wallet = await import('@railgun-community/wallet')
  const { MemoryLevel } = await import('memory-level')

  const { amount, token, signer, network = 'mainnet' } = options
  const chainId = options.chainId || getDefaultChainId()
  const chainConfig_ = getChainConfig(chainId)
  const railgunNetwork = RAILGUN_NETWORK_MAP[chainId]
  if (!railgunNetwork) {
    throw new Error(`No Railgun network mapping for chain ${chainId}`)
  }

  const signerAddress = await signer.getAddress()
  const provider = signer.provider
  if (!provider) {
    throw new Error('Signer must have a provider')
  }

  const tokenAddress = getTokenAddress(network, token, chainId)
  const railgunSmartWallet = getRailgunRelay(chainId)
  const tokenDecimals = chainConfig_.tokens[token]?.decimals ?? 18

  // Initialize Railgun engine with in-memory storage
  const db = new MemoryLevel()

  // Create in-memory artifact store
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
    'b402sdk',
    db,
    false, // shouldDebug
    artifactStore,
    false, // useNativeArtifacts
    false, // skipMerkletreeScans - need false to create wallets
    ['https://ppoi-agg.horsewithsixlegs.xyz'],
    [],
    false
  )

  try {
    // Load provider
    const rpcUrl = chainConfig_.rpc
    const chainConfig = {
      chainId,
      providers: [{
        provider: rpcUrl,
        priority: 1,
        weight: 1,
        stallTimeout: 2500
      }, {
        provider: rpcUrl,
        priority: 2,
        weight: 1,
        stallTimeout: 2500
      }]
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sharedModels = await import('@railgun-community/shared-models') as any
    const networkName = sharedModels.NetworkName?.[railgunNetwork.networkName] ?? railgunNetwork.networkName
    await wallet.loadProvider(chainConfig, networkName, 60000)

    // Derive deterministic mnemonic from EOA
    // CRITICAL: Must use UNIFIED signature (same as incognito wallet derivation)
    // This ensures shield and unshield use the same keys
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const privateKey = (signer as any).privateKey

    let mnemonic: string
    if (privateKey) {
      // Use private key directly if available (Node.js wallets)
      // This uses wallet.signMessage() internally
      mnemonic = await deriveMnemonicFromEOA(privateKey)
    } else {
      // For browser wallets, use UNIFIED signature from cache
      // IMPORTANT: This MUST use getCachedSignature to match unshield/transact keys
      console.log('Getting unified signature for mnemonic derivation...')
      const signature = await getCachedSignature(signer)
      console.log('Signature received, deriving mnemonic...')
      // Derive entropy from signature
      const entropy = ethers.keccak256(signature).slice(0, 34) // 32 bytes + '0x'
      const { Mnemonic } = await import('ethers')
      mnemonic = Mnemonic.fromEntropy(entropy).phrase
      console.log('Mnemonic derived successfully')
    }

    // Create Railgun wallet (for private key path)
    const encryptionKey = ethers.keccak256(ethers.toUtf8Bytes('b402-encryption-key')).slice(2)
    const creationBlockNumbers = { [networkName]: railgunNetwork.creationBlock }
    const walletInfo = await wallet.createRailgunWallet(encryptionKey, mnemonic, creationBlockNumbers)

    const railgunAddress = walletInfo.railgunAddress

    // Approve token if needed
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer)
    const amountWei = ethers.parseUnits(amount, tokenDecimals)

    // Check balance
    const balance = await tokenContract.balanceOf(signerAddress)
    if (balance < amountWei) {
      throw new Error(`Insufficient balance. Have: ${ethers.formatUnits(balance, tokenDecimals)}, Need: ${amount}`)
    }

    const allowance = await tokenContract.allowance(signerAddress, railgunSmartWallet)
    console.log(`[shield] Token: ${tokenAddress}, Spender: ${railgunSmartWallet}`)
    console.log(`[shield] Current allowance: ${allowance}, Need: ${amountWei} (${amount} with ${tokenDecimals} decimals)`)
    if (allowance < amountWei) {
      console.log('[shield] Approval needed, sending approve tx...')
      const approveTx = await tokenContract.approve(railgunSmartWallet, ethers.MaxUint256)
      console.log(`[shield] Approval TX sent: ${approveTx.hash}, waiting for confirmation...`)
      const approveReceipt = await approveTx.wait()
      if (!approveReceipt || approveReceipt.status === 0) {
        throw new Error(`Approval TX failed or was dropped: ${approveTx.hash}`)
      }
      console.log(`[shield] Approval confirmed in block ${approveReceipt.blockNumber}`)

      // Verify allowance was actually set (guards against stale RPC state)
      const newAllowance = await tokenContract.allowance(signerAddress, railgunSmartWallet)
      console.log(`[shield] Post-approval allowance: ${newAllowance}`)
      if (newAllowance < amountWei) {
        throw new Error(`Approval confirmed but allowance still insufficient: ${newAllowance} < ${amountWei}`)
      }
    } else {
      console.log(`[shield] Token already approved (allowance: ${allowance})`)
    }

    // Build shield transaction
    const shieldPrivateKey = getShieldPrivateKey()
    const erc20AmountRecipients = [{
      tokenAddress,
      amount: amountWei,
      recipientAddress: railgunAddress
    }]

    // Use TXIDVersion - V2_PoseidonMerkle is the string 'V2_PoseidonMerkle'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const txidVersion = sharedModels.TXIDVersion?.V2_PoseidonMerkle ?? 'V2_PoseidonMerkle'
    
    const { transaction } = await wallet.populateShield(
      txidVersion,
      networkName,
      shieldPrivateKey,
      erc20AmountRecipients,
      [] // nftAmountRecipients
    )

    if (!transaction) {
      throw new Error('Failed to populate shield transaction')
    }

    // Send transaction
    // IMPORTANT: Use our B402 fork address, not the SDK's default (official Railgun)
    // Use explicit gasLimit to bypass estimateGas (avoids stale-state allowance errors)
    // Shield gas: ~822k on Base, ~766k on BSC — use 1.2M for safety margin
    console.log(`[shield] Sending shield TX to ${railgunSmartWallet}...`)
    const tx = await signer.sendTransaction({
      to: railgunSmartWallet,  // Use our fork, not SDK's transaction.to
      data: transaction.data,
      value: transaction.value,
      gasLimit: 1_200_000
    })
    console.log(`[shield] Shield TX sent: ${tx.hash}, waiting for confirmation...`)
    const receipt = await tx.wait()
    if (!receipt || receipt.status === 0) {
      throw new Error(`Shield TX reverted: ${tx.hash}`)
    }
    console.log(`[shield] Shield confirmed in block ${receipt.blockNumber}: ${receipt.hash}`)

    return {
      hash: receipt?.hash || tx.hash,
      amount: amount,
      token: tokenAddress,
      railgunAddress
    }
  } finally {
    await wallet.stopRailgunEngine()
  }
}
