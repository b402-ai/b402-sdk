#!/usr/bin/env tsx
/**
 * @b402ai/sdk — Agent Demo
 *
 * Shows how an AI agent uses the SDK to execute private DeFi on Base.
 *
 * Usage:
 *   npx tsx examples/agent-demo.ts <operation> [amount]
 *
 * Operations:
 *   status              — Check wallet balances and positions
 *   shield [amount]     — Shield USDC into privacy pool (default: 1, gasless via smart wallet)
 *   shield-eoa [amount] — Shield USDC from owner EOA directly (default: 1, gasless via EIP-3009)
 *   unshield [amount]   — Unshield USDC from pool to wallet (default: 0.5)
 *   lend [amount]       — Deposit USDC into Morpho vault (default: 1)
 *   redeem              — Withdraw from Morpho vault
 *   swap [amount]       — Swap USDC → WETH (default: 1)
 *   rebalance           — Move to highest-yield vault
 *   private-swap [from] [to] [amount] — Swap from pool (fully private, e.g. private-swap WETH USDC 0.001)
 *   private-lend [amount]   — Deposit from pool to vault (fully private, default: 0.5)
 *   private-redeem          — Withdraw from vault to pool (fully private)
 *   add-lp [amount]        — Add liquidity to Aerodrome WETH/USDC pool (default: 10)
 *   remove-lp              — Remove all liquidity + claim AERO rewards
 *   claim-rewards          — Claim AERO rewards without removing LP
 *   speed-market [amount]  — Place a speed market bet (ETH UP, 10min)
 *   private-speed [amount] — Same but from privacy pool
 *   open-perp [margin]     — Open ETH long perp (Synthetix V3)
 *   close-perp             — Close ETH perp position
 *   private-perp [margin]  — Open private ETH perp from privacy pool
 *   discover               — List available vaults, pools, and tokens
 */

import { B402 } from '../src/b402'
import { ethers } from 'ethers'
import * as dotenv from 'dotenv'
dotenv.config()

const b402 = new B402({
  privateKey: process.env.WORKER_PRIVATE_KEY!,
  zeroXApiKey: process.env.ZERO_X_API_KEY,
  rpcUrl: process.env.BASE_RPC_URL,
  facilitatorUrl: process.env.FACILITATOR_URL,
  onProgress: (e) => {
    if (e.type === 'step') console.log(`  [${e.step}/${e.totalSteps}] ${e.title}`)
    else if (e.type === 'done') console.log(`  ✓ ${e.message}`)
    else if (e.type === 'info') console.log(`  → ${e.title}: ${e.message}`)
  },
})

const op = process.argv[2] || 'status'
const amt = process.argv[3] // optional amount argument
const arg4 = process.argv[4] // optional 4th arg (e.g., target token for swaps)
const tx = (hash: string) => `https://basescan.org/tx/${hash}`

const operations: Record<string, () => Promise<void>> = {
  async status() {
    const s = await b402.status()

    // USD prices (hardcoded like dashboard)
    const prices: Record<string, number> = { USDC: 1, USDT: 1, DAI: 1, WETH: 2100, AERO: 1.2 }
    const fmtUsd = (amt: number, price: number) => {
      const usd = amt * price
      return usd < 0.01 ? `$${usd.toPrecision(2)}` : `$${usd.toFixed(2)}`
    }
    const fmtAmt = (amt: number) => {
      if (amt < 0.000001) return '<0.000001'
      if (amt < 0.01) return amt.toPrecision(3)
      return amt.toFixed(4)
    }

    console.log('\n── Treasury Status ──')
    console.log(`  Smart Wallet:  ${s.smartWallet}`)
    console.log(`  Deployed:      ${s.deployed}`)

    // Wallet balances
    if (s.balances.length > 0) {
      const walletTotal = s.balances.reduce((sum, b) => sum + parseFloat(b.balance) * (prices[b.token] || 0), 0)
      console.log(`  Wallet:        ${walletTotal < 0.01 ? '' : `$${walletTotal.toFixed(2)}`}`)
      for (const b of s.balances) {
        const amt = parseFloat(b.balance)
        const price = prices[b.token] || 0
        console.log(`    ${b.token.padEnd(12)} ${fmtAmt(amt).padStart(12)}  ${fmtUsd(amt, price).padStart(8)}`)
      }
    } else {
      console.log('  Wallet:        empty')
    }

    // Privacy pool
    if (s.shieldedBalances.length > 0) {
      // Stablecoins and known tokens get hardcoded prices; vault shares ≈ $1/share (USDC vaults)
      const getPrice = (token: string) => {
        if (prices[token]) return prices[token]
        // Morpho vault share tokens (USDC-denominated vaults) — share ≈ 1.08 USDC
        if (token.includes('USDC') || token.includes('Steakhouse') || token.includes('Moonwell') || token.includes('Gauntlet')) return 1.085
        // Other stablecoins
        if (token.includes('USD')) return 1
        return 0
      }
      const poolTotal = s.shieldedBalances.reduce((sum, b) => sum + parseFloat(b.balance) * getPrice(b.token), 0)
      console.log(`  Privacy Pool:  ${poolTotal < 0.01 ? '' : `$${poolTotal.toFixed(2)}`}`)
      for (const b of s.shieldedBalances) {
        const amt = parseFloat(b.balance)
        if (amt <= 0) continue
        const price = getPrice(b.token)
        const label = b.token.length > 20 ? b.token.slice(0, 20) : b.token
        console.log(`    ${label.padEnd(22)} ${fmtAmt(amt).padStart(10)}  ${fmtUsd(amt, price).padStart(8)}`)
      }
    } else {
      console.log('  Privacy Pool:  empty')
    }

    // Yield
    if (s.positions.length > 0) {
      for (const p of s.positions) {
        console.log(`  Yield:         ${p.assets} in ${p.vault} (${p.apyEstimate} APY${p.tvl ? ', ' + p.tvl + ' TVL' : ''})`)
      }
    } else {
      console.log('  Yield:         none')
    }

    // LP
    if (s.lpPositions.length > 0) {
      for (const lp of s.lpPositions) {
        console.log(`  LP:            $${lp.usdValue} in ${lp.pool} (${lp.apyEstimate} APY${lp.tvl ? ', ' + lp.tvl + ' TVL' : ''})`)
        if (lp.pendingRewards && !lp.pendingRewards.startsWith('0.0000000000')) {
          console.log(`    Rewards:     ${lp.pendingRewards}`)
        }
      }
    }
  },

  async shield() {
    const amount = amt || '1'
    console.log(`\n── Shield: ${amount} USDC → privacy pool ──`)
    const result = await b402.shield({ token: 'USDC', amount })
    console.log(`  TX:      ${tx(result.txHash)}`)
    console.log(`  Indexed: ${result.indexed}`)
  },

  'shield-eoa': async () => {
    const amount = amt || '1'
    console.log(`\n── Shield from EOA: ${amount} USDC → privacy pool (gasless, EIP-3009) ──`)
    const result = await b402.shieldFromEOA({ token: 'USDC', amount })
    console.log(`  TX:      ${tx(result.txHash)}`)
    console.log(`  Indexed: ${result.indexed}`)
  },

  async unshield() {
    const amount = amt || '0.5'
    console.log(`\n── Unshield: ${amount} USDC → smart wallet (ZK proof) ──`)
    const result = await b402.unshield({ token: 'USDC', amount })
    console.log(`  TX:    ${tx(result.txHash)}`)
    console.log(`  Proof: ${result.proofTimeSeconds.toFixed(1)}s`)
  },

  async lend() {
    const amount = amt || '1'
    console.log(`\n── Lend: ${amount} USDC → Steakhouse vault ──`)
    const result = await b402.lend({ token: 'USDC', amount, vault: 'steakhouse' })
    console.log(`  TX:    ${tx(result.txHash)}`)
    console.log(`  Vault: ${result.vault}`)
  },

  async redeem() {
    console.log('\n── Redeem: Steakhouse vault → USDC ──')
    const result = await b402.redeem({ vault: 'steakhouse' })
    console.log(`  TX:       ${tx(result.txHash)}`)
    console.log(`  Received: ${result.assetsReceived} USDC`)
  },

  async swap() {
    const amount = amt || '1'
    console.log(`\n── Swap: ${amount} USDC → WETH ──`)
    const result = await b402.swap({ from: 'USDC', to: 'WETH', amount })
    console.log(`  TX:       ${tx(result.txHash)}`)
    console.log(`  Received: ${result.amountOut} ${result.tokenOut}`)
  },

  async transact() {
    console.log('\n── Transact: arbitrary call ──')
    const erc20 = new ethers.Interface([
      'function approve(address spender, uint256 amount) returns (bool)',
    ])
    const result = await b402.transact([
      {
        to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        value: '0',
        data: erc20.encodeFunctionData('approve', [
          '0x0000000000000000000000000000000000000001',
          0n,
        ]),
      },
    ])
    console.log(`  TX: ${tx(result.txHash)}`)
  },

  'private-swap': async () => {
    const from = amt && arg4 ? amt.toUpperCase() : 'USDC'
    const to = amt && arg4 ? arg4.toUpperCase() : (arg4 ? arg4.toUpperCase() : 'WETH')
    const amount = amt && arg4 ? (process.argv[5] || '0.5') : (amt || '0.5')
    console.log(`\n── Private Swap: ${amount} ${from} → ${to} (from privacy pool) ──`)
    const result = await b402.privateSwap({ from, to, amount, slippageBps: 300 })
    console.log(`  TX:       ${tx(result.txHash)}`)
    console.log(`  Swapped:  ${result.amountIn} ${result.tokenIn} → ${result.amountOut} ${result.tokenOut}`)
  },

  'private-lend': async () => {
    const amount = amt || '0.5'
    console.log(`\n── Private Lend: ${amount} USDC → Morpho Steakhouse (from privacy pool) ──`)
    const result = await b402.privateLend({ token: 'USDC', amount, vault: 'steakhouse' })
    console.log(`  TX:    ${tx(result.txHash)}`)
    console.log(`  Vault: ${result.vault}`)
  },

  'private-redeem': async () => {
    const vault = amt || 'steakhouse'
    console.log(`\n── Private Redeem: Morpho ${vault} → privacy pool ──`)
    const result = await b402.privateRedeem({ vault })
    console.log(`  TX:       ${tx(result.txHash)}`)
    console.log(`  Received: ${result.assetsReceived} USDC`)
  },

  async rebalance() {
    console.log('\n── Rebalance ──')
    const result = await b402.rebalance()
    console.log(`  Action: ${result.action}`)
    if (result.currentVault) console.log(`  Current: ${result.currentVault}`)
    if (result.bestVault) console.log(`  Best:    ${result.bestVault}`)
  },

  'add-lp': async () => {
    const amount = amt || '10'
    console.log(`\n── Add Liquidity: ${amount} USDC → WETH/USDC Pool ──`)
    const result = await b402.addLiquidity({ pool: 'weth-usdc', amount })
    console.log(`  TX:   ${tx(result.txHash)}`)
    console.log(`  Pool: ${result.pool}`)
  },

  'remove-lp': async () => {
    console.log('\n── Remove Liquidity: WETH/USDC Pool → WETH + USDC ──')
    const result = await b402.removeLiquidity({ pool: 'weth-usdc' })
    console.log(`  TX:       ${tx(result.txHash)}`)
    console.log(`  Received: ${result.amountWETH} WETH + ${result.amountUSDC} USDC`)
  },

  'claim-rewards': async () => {
    console.log('\n── Claim AERO Rewards ──')
    const result = await b402.claimRewards({ pool: 'weth-usdc' })
    console.log(`  TX:   ${tx(result.txHash)}`)
    console.log(`  Pool: ${result.pool}`)
  },

  'speed-market': async () => {
    const amount = amt || '10'
    console.log(`\n── Speed Market: ${amount} USDC on ETH UP (10min) ──`)
    const result = await b402.speedMarket({ asset: 'ETH', direction: 'up', amount, duration: '10m' })
    console.log(`  TX:     ${tx(result.txHash)}`)
    console.log(`  Asset:  ${result.asset} ${result.direction}`)
    console.log(`  Amount: ${result.amount} USDC`)
    console.log(`  Settles: ${new Date(result.strikeTime * 1000).toLocaleTimeString()}`)
  },

  'private-speed': async () => {
    const amount = amt || '10'
    console.log(`\n── Private Speed Market: ${amount} USDC on ETH UP (from privacy pool) ──`)
    const result = await b402.privateSpeedMarket({ asset: 'ETH', direction: 'up', amount, duration: '10m' })
    console.log(`  TX:     ${tx(result.txHash)}`)
    console.log(`  Asset:  ${result.asset} ${result.direction}`)
    console.log(`  Wallet never appears on-chain.`)
  },

  'open-perp': async () => {
    const margin = amt || '50'
    console.log(`\n── Open Perp: ETH long, ${margin} USDC margin ──`)
    const result = await b402.openPerp({ market: 'ETH', side: 'long', size: '0.01', margin })
    console.log(`  TX:     ${tx(result.txHash)}`)
    console.log(`  Market: ${result.market} ${result.side}`)
    console.log(`  Size:   ${result.size} ETH`)
    console.log(`  Margin: ${result.margin} USDC`)
  },

  'close-perp': async () => {
    console.log('\n── Close Perp: ETH position ──')
    // Account ID derived from wallet — same as openPerp uses
    const { ethers } = await import('ethers')
    const status = await b402.status()
    const accountId = BigInt('0x' + ethers.keccak256(ethers.toUtf8Bytes(status.smartWallet)).slice(2, 18))
    const result = await b402.closePerp({ market: 'ETH', accountId: accountId.toString() })
    console.log(`  TX:     ${tx(result.txHash)}`)
  },

  'private-perp': async () => {
    const margin = amt || '50'
    console.log(`\n── Private Perp: ETH long, ${margin} USDC (from privacy pool) ──`)
    const result = await b402.privateOpenPerp({ market: 'ETH', side: 'long', size: '0.01', margin })
    console.log(`  TX:     ${tx(result.txHash)}`)
    console.log(`  Market: ${result.market} ${result.side}`)
    console.log(`  Wallet never appears on-chain.`)
  },

  async discover() {
    console.log('\n── Discover ──')
    console.log(`  Vaults:        ${B402.vaults.map(v => `${v.name} (${v.fullName})`).join(', ')}`)
    console.log(`  Pools:         ${B402.pools.map(p => `${p.name} (${p.fullName})`).join(', ')}`)
    console.log(`  Tokens:        ${B402.tokens.map(t => `${t.symbol} (${t.address.slice(0, 10)}...)`).join(', ')}`)
    console.log(`  Perp Markets:  ${B402.perpMarkets.map(m => `${m.symbol} (ID:${m.marketId})`).join(', ')}`)
    console.log(`  Speed Markets: ${B402.speedMarketAssets.join(', ')} (UP/DOWN, 10m-24h)`)
  },

  async all() {
    await operations.status()
    await operations.rebalance()
    await operations.discover()
  },
}

async function main() {
  if (!operations[op]) {
    console.error(`Unknown operation: ${op}`)
    console.error(`Available: ${Object.keys(operations).join(', ')}`)
    process.exit(1)
  }
  await operations[op]()
  console.log('\n── Done ──')
  process.exit(0)
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`)
  process.exit(1)
})
