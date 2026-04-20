/**
 * Rebalancer — Check vault positions and move capital to highest yield
 *
 * Flow:
 *   1. Read vault share balances across all Morpho vaults
 *   2. Estimate APY for each vault (totalAssets as proxy)
 *   3. If current vault isn't optimal, redeem → deposit into best vault
 *   4. All through the private pipeline (redeem is public, deposit uses ZK)
 */

import { ethers } from 'ethers'
import { MORPHO_VAULTS, ERC4626_INTERFACE, resolveVault } from '../lend/morpho-vaults'
import { executeRedeem, executeDirectDeposit } from '../lend/lend-pipeline'
import { deriveWorkerWalletParams, computeSmartWalletAddressOnChain } from '../wallet/wallet-factory'
import { BASE_TOKENS } from '../types'
import type { SwapProgress } from '../pipeline'

// ═══════════════ TYPES ═══════════════

export interface VaultPosition {
  name: string
  address: string
  shares: bigint
  assets: bigint
  /** Formatted asset amount (human-readable) */
  assetsFormatted: string
  /** Estimated APY range string */
  apyEstimate: string
  /** Numeric APY midpoint for comparison */
  apyMidpoint: number
}

export interface RebalanceResult {
  positions: VaultPosition[]
  currentVault: string | null
  bestVault: string
  action: 'rebalanced' | 'already-optimal' | 'no-positions'
  redeemTxHash?: string
  depositTxHash?: string
  amountMoved?: string
}

// ═══════════════ APY FROM MORPHO API ═══════════════

import { fetchAllVaultMetrics, formatAPY, type VaultMetrics } from '../lend/morpho-api'

/** Fallback when Morpho API is unreachable */
const FALLBACK_APY: Record<string, { range: string; midpoint: number }> = {
  steakhouse: { range: '3-4%', midpoint: 3.5 },
  moonwell: { range: '3-4%', midpoint: 3.8 },
  gauntlet: { range: '3-4%', midpoint: 3.5 },
  'steakhouse-hy': { range: '3-4%', midpoint: 3.5 },
}

function fallbackAPY(vaultKey: string): { range: string; midpoint: number } {
  return FALLBACK_APY[vaultKey] || { range: '1-3%', midpoint: 2.0 }
}

// ═══════════════ SCAN POSITIONS ═══════════════

export async function scanVaultPositions(
  smartWallet: string,
  provider: ethers.JsonRpcProvider,
  tokenDecimals: number = 6,
  metrics?: Record<string, VaultMetrics> | null,
): Promise<VaultPosition[]> {
  const positions: VaultPosition[] = []

  for (const [key, vault] of Object.entries(MORPHO_VAULTS)) {
    const contract = new ethers.Contract(vault.address, ERC4626_INTERFACE, provider)
    try {
      const shares: bigint = await contract.balanceOf(smartWallet)
      if (shares > 0n) {
        const assets: bigint = await contract.convertToAssets(shares)
        const m = metrics?.[key]
        positions.push({
          name: key,
          address: vault.address,
          shares,
          assets,
          assetsFormatted: ethers.formatUnits(assets, tokenDecimals),
          apyEstimate: m ? formatAPY(m.netApy) : fallbackAPY(key).range,
          apyMidpoint: m ? m.netApy * 100 : fallbackAPY(key).midpoint,
        })
      }
    } catch {
      // Vault call failed, skip
    }
  }

  return positions
}

// ═══════════════ FIND BEST VAULT ═══════════════

export async function findBestVault(
  metrics?: Record<string, VaultMetrics> | null,
): Promise<{ name: string; midpoint: number }> {
  const m = metrics || await fetchAllVaultMetrics(8453)
  let best = { name: 'steakhouse', midpoint: 0 }
  for (const key of Object.keys(MORPHO_VAULTS)) {
    const vaultMetrics = m?.[key]
    const midpoint = vaultMetrics ? vaultMetrics.netApy * 100 : fallbackAPY(key).midpoint
    if (midpoint > best.midpoint) {
      best = { name: key, midpoint }
    }
  }
  return best
}

// ═══════════════ REBALANCE ═══════════════

export async function executeRebalance(
  config: {
    privateKey: string
    paymasterSignerKey: string
    rpcUrl?: string
    chainId?: number
    minApyDiffPercent?: number
  },
  progress: SwapProgress,
): Promise<RebalanceResult> {
  const {
    privateKey,
    paymasterSignerKey,
    rpcUrl = 'https://mainnet.base.org',
    chainId = 8453,
    minApyDiffPercent = 0.5,
  } = config

  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const token = BASE_TOKENS.USDC

  // ─── Resolve wallet ───

  progress.step(1, 4, 'Scanning positions')
  progress.spin('Deriving smart wallet...')

  const walletParams = deriveWorkerWalletParams(privateKey)
  const smartWallet = await computeSmartWalletAddressOnChain(walletParams, provider)

  progress.succeed(`Wallet: ${smartWallet}`)

  // ─── Scan all vaults ───

  progress.spin('Fetching live vault metrics...')
  const metrics = await fetchAllVaultMetrics(chainId)

  progress.spin('Scanning Morpho vault positions...')
  const positions = await scanVaultPositions(smartWallet, provider, token.decimals, metrics)

  if (positions.length === 0) {
    progress.succeed('No vault positions found')
    const best = await findBestVault(metrics)
    return {
      positions,
      currentVault: null,
      bestVault: best.name,
      action: 'no-positions',
    }
  }

  // Show current positions
  for (const pos of positions) {
    progress.info(pos.name, `${pos.assetsFormatted} USDC (${pos.apyEstimate} APY)`)
  }

  // ─── Compare yields ───

  progress.step(2, 4, 'Comparing yields')

  const currentVault = positions.reduce((a, b) => a.assets > b.assets ? a : b)
  const bestVaultInfo = await findBestVault(metrics)
  const bestVault = resolveVault(bestVaultInfo.name)

  const apyDiff = bestVaultInfo.midpoint - currentVault.apyMidpoint

  const bestMetrics = metrics?.[bestVaultInfo.name]
  progress.info('Current', `${currentVault.name} (${currentVault.apyEstimate})`)
  progress.info('Best', `${bestVaultInfo.name} (${bestMetrics ? formatAPY(bestMetrics.netApy) : fallbackAPY(bestVaultInfo.name).range})`)
  progress.info('APY diff', `${apyDiff.toFixed(2)}%`)

  // Already in the best vault or difference too small
  if (currentVault.name === bestVaultInfo.name || apyDiff < minApyDiffPercent) {
    progress.succeed(`Already optimal — staying in ${currentVault.name}`)
    return {
      positions,
      currentVault: currentVault.name,
      bestVault: bestVaultInfo.name,
      action: 'already-optimal',
    }
  }

  // ─── Redeem from current vault ───

  progress.step(3, 4, `Redeeming from ${currentVault.name}`)

  const redeemResult = await executeRedeem({
    privateKey,
    paymasterSignerKey,
    token,
    vault: currentVault.name,
    rpcUrl,
    chainId,
  }, {
    step: () => {},
    spin: (msg) => progress.spin(msg),
    succeed: (msg) => progress.succeed(msg),
    info: (k, v) => progress.info(k, v),
  })

  // ─── Deposit into best vault (direct — tokens already on wallet) ───

  progress.step(4, 4, `Depositing into ${bestVaultInfo.name}`)

  const lendResult = await executeDirectDeposit({
    privateKey,
    paymasterSignerKey,
    token,
    amount: redeemResult.assetsReceived,
    vault: bestVaultInfo.name,
    rpcUrl,
    chainId,
  }, {
    step: () => {},
    spin: (msg) => progress.spin(msg),
    succeed: (msg) => progress.succeed(msg),
    info: (k, v) => progress.info(k, v),
  })

  return {
    positions,
    currentVault: currentVault.name,
    bestVault: bestVaultInfo.name,
    action: 'rebalanced',
    redeemTxHash: redeemResult.txHash,
    depositTxHash: lendResult.txHash,
    amountMoved: redeemResult.assetsReceived,
  }
}
