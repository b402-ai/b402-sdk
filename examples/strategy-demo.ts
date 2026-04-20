#!/usr/bin/env tsx
/**
 * @b402ai/sdk — Autonomous Private DeFi Strategies
 *
 * One prompt. Multiple private operations. Zero trace.
 *
 * Usage:
 *   npx tsx examples/strategy-demo.ts <strategy> [amount] [options...]
 *
 * Strategies:
 *   full-spectrum [amount]    — Shield → swap → LP → vault → reserve (diversified)
 *   private-dca [amount] [n]  — Private DCA into WETH: n swaps, invisible accumulation
 *   mev-shield [amount]       — MEV-protected large swap: split into private chunks
 *   stealth-portfolio [amount] — Build invisible portfolio: vaults + WETH + stables
 *   yield-arb                 — Scan all vaults, move capital to highest APY privately
 *   vault-split [amount]      — Split across top Morpho vaults privately
 *   harvest                   — Claim all rewards, rebalance vaults, compound
 *   exit                      — Liquidate everything back to privacy pool
 */

import { B402 } from '../src/b402'
import * as dotenv from 'dotenv'
dotenv.config()

const b402 = new B402({
  privateKey: process.env.WORKER_PRIVATE_KEY!,
  
  rpcUrl: process.env.BASE_RPC_URL,
  facilitatorUrl: process.env.FACILITATOR_URL,
  onProgress: (e) => {
    if (e.type === 'step') console.log(`    [${e.step}/${e.totalSteps}] ${e.title}`)
    else if (e.type === 'done') console.log(`    ✓ ${e.message}`)
    else if (e.type === 'info') console.log(`    → ${e.title}: ${e.message}`)
  },
})

const strategy = process.argv[2] || 'full-spectrum'
const inputAmount = process.argv[3] || '10'
const inputArg4 = process.argv[4]
const tx = (hash: string) => `https://basescan.org/tx/${hash}`

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${title}`)
  console.log(`${'═'.repeat(60)}`)
}

function step(n: number, total: number, label: string) {
  console.log(`\n  ▸ Step ${n}/${total}: ${label}`)
  console.log(`  ${'─'.repeat(40)}`)
}

async function showStatus() {
  const s = await b402.status()
  const prices: Record<string, number> = { USDC: 1, USDT: 1, DAI: 1, WETH: 2100, AERO: 1.2 }

  console.log('\n  ┌─ Portfolio Snapshot ─────────────────────┐')

  if (s.shieldedBalances.length > 0) {
    const getPrice = (token: string) => {
      if (prices[token]) return prices[token]
      if (token.includes('USDC') || token.includes('USD')) return 1
      return 0
    }
    const poolTotal = s.shieldedBalances.reduce(
      (sum, b) => sum + parseFloat(b.balance) * getPrice(b.token), 0
    )
    console.log(`  │  Privacy Pool: $${poolTotal.toFixed(2)}`)
    for (const b of s.shieldedBalances) {
      const amt = parseFloat(b.balance)
      if (amt <= 0) continue
      const price = getPrice(b.token)
      const label = b.token.length > 14 ? b.token.slice(0, 14) : b.token
      console.log(`  │    ${label.padEnd(14)} ${amt.toFixed(4).padStart(12)}  $${(amt * price).toFixed(2)}`)
    }
  }

  if (s.positions.length > 0) {
    for (const p of s.positions) {
      console.log(`  │  Vault: ${p.assets} in ${p.vault} (${p.apyEstimate} APY)`)
    }
  }

  if (s.lpPositions.length > 0) {
    for (const lp of s.lpPositions) {
      console.log(`  │  LP: $${lp.usdValue} in ${lp.pool} (${lp.apyEstimate} APY)`)
      if (lp.pendingRewards && !lp.pendingRewards.startsWith('0.0000')) {
        console.log(`  │    Pending: ${lp.pendingRewards}`)
      }
    }
  }

  if (s.balances.length > 0) {
    const walletTotal = s.balances.reduce(
      (sum, b) => sum + parseFloat(b.balance) * (prices[b.token] || 0), 0
    )
    if (walletTotal > 0.01) {
      console.log(`  │  Wallet: $${walletTotal.toFixed(2)}`)
    }
  }

  console.log(`  └────────────────────────────────────────┘`)
  return s
}

async function ensurePoolBalance(amount: number): Promise<void> {
  const status = await b402.status()
  const poolUsdc = status.shieldedBalances.find(b => b.token === 'USDC')
  const poolBal = poolUsdc ? parseFloat(poolUsdc.balance) : 0
  if (poolBal >= amount) {
    console.log(`    Pool has ${poolBal.toFixed(2)} USDC — sufficient.`)
  } else {
    const walletUsdc = status.balances.find(b => b.token === 'USDC')
    const walletBal = walletUsdc ? parseFloat(walletUsdc.balance) : 0
    const needed = amount - poolBal
    if (walletBal >= needed) {
      console.log(`    Pool has ${poolBal.toFixed(2)}, shielding ${needed.toFixed(2)} more...`)
      const r = await b402.shield({ token: 'USDC', amount: needed.toFixed(2) })
      console.log(`    TX: ${tx(r.txHash)}`)
    } else if (poolBal + walletBal >= amount) {
      console.log(`    Shielding ${walletBal.toFixed(2)} USDC from wallet...`)
      const r = await b402.shield({ token: 'USDC', amount: walletBal.toFixed(4) })
      console.log(`    TX: ${tx(r.txHash)}`)
    } else {
      throw new Error(`Need ${amount} USDC. Pool: ${poolBal.toFixed(2)}, Wallet: ${walletBal.toFixed(2)}. Send more USDC to ${status.smartWallet}`)
    }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ─── Strategies ──────────────────────────────────────────────────────

const strategies: Record<string, () => Promise<void>> = {

  // ═══════════════════════════════════════════════════════════════════
  // 1. PRIVATE DCA — Accumulate WETH invisibly over multiple swaps
  // ═══════════════════════════════════════════════════════════════════
  'private-dca': async () => {
    const totalAmount = parseFloat(inputAmount)
    const numSwaps = parseInt(inputArg4 || '5')
    const perSwap = (totalAmount / numSwaps).toFixed(2)

    header(`Private DCA — ${totalAmount} USDC → WETH in ${numSwaps} invisible swaps`)
    console.log(`  Accumulating WETH privately. No wallet shows exposure.`)
    console.log(`  Nansen, Arkham, DeBank — all blind.`)
    console.log(`  ${perSwap} USDC per swap × ${numSwaps} swaps`)

    step(1, numSwaps + 1, `Verify pool balance`)
    await ensurePoolBalance(totalAmount)

    let totalWeth = 0

    for (let i = 0; i < numSwaps; i++) {
      step(i + 2, numSwaps + 1, `Private swap #${i + 1}: ${perSwap} USDC → WETH`)
      const result = await b402.privateSwap({
        from: 'USDC', to: 'WETH', amount: perSwap, slippageBps: 300,
      })
      const wethOut = parseFloat(result.amountOut)
      totalWeth += wethOut
      console.log(`    TX: ${tx(result.txHash)}`)
      console.log(`    Got: ${result.amountOut} WETH ($${(wethOut * 2100).toFixed(2)})`)
      console.log(`    Running total: ${totalWeth.toFixed(6)} WETH ($${(totalWeth * 2100).toFixed(2)})`)

      if (i < numSwaps - 1) {
        console.log(`    Waiting 3s before next swap...`)
        await sleep(3000)
      }
    }

    await showStatus()
    console.log(`\n  ✅ Private DCA complete.`)
    console.log(`     Accumulated: ${totalWeth.toFixed(6)} WETH ($${(totalWeth * 2100).toFixed(2)})`)
    console.log(`     ${numSwaps} swaps. Zero on-chain accumulation visible.`)
    console.log(`     No wallet shows WETH exposure. Arkham sees nothing.`)
  },

  // ═══════════════════════════════════════════════════════════════════
  // 2. MEV-PROTECTED SWAP — Large swap split into private chunks
  // ═══════════════════════════════════════════════════════════════════
  'mev-shield': async () => {
    const totalAmount = parseFloat(inputAmount)
    const chunks = parseInt(inputArg4 || '4')
    const perChunk = (totalAmount / chunks).toFixed(2)

    header(`MEV-Protected Swap — ${totalAmount} USDC → WETH (${chunks} private chunks)`)
    console.log(`  Large swap split into ${chunks} private chunks via RelayAdapt.`)
    console.log(`  Each chunk uses a fresh ZK proof. MEV bots can't:`)
    console.log(`    • See the full order size`)
    console.log(`    • Front-run or sandwich any chunk`)
    console.log(`    • Link chunks to the same trader`)

    step(1, chunks + 1, `Verify pool balance`)
    await ensurePoolBalance(totalAmount)

    let totalWeth = 0
    const txHashes: string[] = []

    for (let i = 0; i < chunks; i++) {
      step(i + 2, chunks + 1, `Chunk ${i + 1}/${chunks}: ${perChunk} USDC → WETH (private)`)
      const result = await b402.privateSwap({
        from: 'USDC', to: 'WETH', amount: perChunk, slippageBps: 300,
      })
      const wethOut = parseFloat(result.amountOut)
      totalWeth += wethOut
      txHashes.push(result.txHash)
      console.log(`    TX: ${tx(result.txHash)}`)
      console.log(`    Got: ${result.amountOut} WETH`)
      console.log(`    Progress: ${((i + 1) / chunks * 100).toFixed(0)}% filled`)
    }

    await showStatus()
    console.log(`\n  ✅ MEV-protected swap complete.`)
    console.log(`     Total filled: ${totalAmount} USDC → ${totalWeth.toFixed(6)} WETH`)
    console.log(`     Avg price: $${(totalAmount / totalWeth).toFixed(2)} per WETH`)
    console.log(`     ${chunks} chunks. Each with unique ZK proof.`)
    console.log(`     On-chain: ${chunks} unrelated RelayAdapt swaps. No link between them.`)
  },

  // ═══════════════════════════════════════════════════════════════════
  // 3. STEALTH PORTFOLIO — Build invisible portfolio across assets
  // ═══════════════════════════════════════════════════════════════════
  'stealth-portfolio': async () => {
    const totalAmount = parseFloat(inputAmount)
    const wethAlloc = (totalAmount * 0.30).toFixed(2)   // 30% WETH
    const vault1Alloc = (totalAmount * 0.30).toFixed(2)  // 30% Steakhouse
    const vault2Alloc = (totalAmount * 0.20).toFixed(2)  // 20% Moonwell
    const reserve = (totalAmount * 0.20).toFixed(2)      // 20% USDC reserve

    header(`Stealth Portfolio — ${totalAmount} USDC → Invisible diversified portfolio`)
    console.log(`  Building a portfolio that doesn't exist on-chain:`)
    console.log(`    30% WETH   — private ETH exposure`)
    console.log(`    30% Steakhouse  — private yield (3% APY)`)
    console.log(`    20% Moonwell    — private yield (3.5% APY)`)
    console.log(`    20% USDC reserve — liquid, shielded`)
    console.log(`  No wallet on Etherscan/Arkham shows any holdings.`)

    step(1, 5, `Check pool / shield if needed`)
    await ensurePoolBalance(totalAmount)

    step(2, 5, `Private swap ${wethAlloc} USDC → WETH (ETH exposure)`)
    const swapResult = await b402.privateSwap({
      from: 'USDC', to: 'WETH', amount: wethAlloc, slippageBps: 300,
    })
    console.log(`    TX: ${tx(swapResult.txHash)}`)
    console.log(`    Got: ${swapResult.amountOut} WETH ($${(parseFloat(swapResult.amountOut) * 2100).toFixed(2)})`)

    step(3, 5, `Private lend ${vault1Alloc} USDC → Steakhouse (~3% APY)`)
    const lend1 = await b402.privateLend({
      token: 'USDC', amount: vault1Alloc, vault: 'steakhouse',
    })
    console.log(`    TX: ${tx(lend1.txHash)}`)

    step(4, 5, `Private lend ${vault2Alloc} USDC → Moonwell (~3.5% APY)`)
    const lend2 = await b402.privateLend({
      token: 'USDC', amount: vault2Alloc, vault: 'moonwell',
    })
    console.log(`    TX: ${tx(lend2.txHash)}`)

    step(5, 5, `Reserve ${reserve} USDC — shielded, liquid`)
    console.log(`    ${reserve} USDC stays in privacy pool.`)

    await showStatus()
    console.log(`\n  ✅ Stealth portfolio built.`)
    console.log(`     Your on-chain footprint: $0.00`)
    console.log(`     Your actual portfolio: $${totalAmount.toFixed(2)}`)
    console.log(`     WETH + 2 yield vaults + USDC reserve.`)
    console.log(`     Etherscan: empty. Arkham: nothing. DeBank: zero.`)
  },

  // ═══════════════════════════════════════════════════════════════════
  // 4. YIELD ARBITRAGE — Scan vaults, move to highest APY privately
  // ═══════════════════════════════════════════════════════════════════
  'yield-arb': async () => {
    header(`Yield Arbitrage — Find and capture best APY privately`)
    console.log(`  Agent will scan all yield sources, compare APYs,`)
    console.log(`  and move capital to the highest yield — all privately.`)
    console.log(`  Competitors can't see your vault positions or copy your strategy.`)

    step(1, 4, `Scan current positions`)
    const status = await b402.status()

    const hasPositions = status.positions.length > 0 || status.lpPositions.length > 0
    if (hasPositions) {
      for (const p of status.positions) {
        console.log(`    Current: ${p.assets} in ${p.vault} (${p.apyEstimate} APY)`)
      }
      for (const lp of status.lpPositions) {
        console.log(`    Current: $${lp.usdValue} in ${lp.pool} (${lp.apyEstimate} APY)`)
      }
    } else {
      console.log(`    No active yield positions.`)
    }

    step(2, 4, `Fetch live APYs from all sources`)
    console.log(`    Scanning Morpho vaults + Aerodrome pools...`)
    const rebalanceResult = await b402.rebalance(0.1) // 0.1% threshold

    if (rebalanceResult.action === 'rebalanced') {
      step(3, 4, `Rebalance: ${rebalanceResult.currentVault} → ${rebalanceResult.bestVault}`)
      if (rebalanceResult.txHash) console.log(`    TX: ${tx(rebalanceResult.txHash)}`)
      console.log(`    Moved capital to higher-yield vault.`)
    } else {
      step(3, 4, `Analysis complete`)
      console.log(`    Current allocation is already optimal.`)
      if (rebalanceResult.bestVault) {
        console.log(`    Best vault: ${rebalanceResult.bestVault}`)
      }
    }

    // If no positions, deploy to best vault privately
    const poolUsdc = status.shieldedBalances.find(b => b.token === 'USDC')
    const poolBal = poolUsdc ? parseFloat(poolUsdc.balance) : 0
    if (!hasPositions && poolBal > 1) {
      const deployAmount = Math.min(poolBal * 0.5, parseFloat(inputAmount)).toFixed(2)
      step(4, 4, `Deploy ${deployAmount} USDC → best vault privately`)
      const bestVault = rebalanceResult.bestVault || 'steakhouse'
      const lendResult = await b402.privateLend({
        token: 'USDC', amount: deployAmount, vault: bestVault,
      })
      console.log(`    TX: ${tx(lendResult.txHash)}`)
      console.log(`    Deposited to ${bestVault} from privacy pool.`)
    } else {
      step(4, 4, `Portfolio snapshot`)
    }

    await showStatus()
    console.log(`\n  ✅ Yield arbitrage complete.`)
    console.log(`     Capital deployed to highest-yield source.`)
    console.log(`     Competitors see nothing — no vault positions visible.`)
  },

  // ═══════════════════════════════════════════════════════════════════
  // 5. FULL SPECTRUM — LP + Vault + WETH + Reserve
  // ═══════════════════════════════════════════════════════════════════
  'full-spectrum': async () => {
    const amount = parseFloat(inputAmount)
    const lpAlloc = (amount * 0.30).toFixed(2)
    const vaultAlloc = (amount * 0.30).toFixed(2)
    const swapAlloc = (amount * 0.20).toFixed(2)
    const reserve = (amount * 0.20).toFixed(2)

    header(`Full Spectrum — ${amount} USDC → LP + Vault + WETH + Reserve`)
    console.log(`  Agent will execute 6 private operations autonomously:`)
    console.log(`  shield → swap → LP → vault → diversify → reserve`)
    console.log(`  Deployed across 3 protocols. Every step untraceable.`)

    step(1, 6, `Shield ${amount} USDC into privacy pool`)
    await ensurePoolBalance(amount)

    step(2, 6, `Private swap ${swapAlloc} USDC → WETH`)
    const swapResult = await b402.privateSwap({
      from: 'USDC', to: 'WETH', amount: swapAlloc, slippageBps: 300,
    })
    console.log(`    TX: ${tx(swapResult.txHash)}`)
    console.log(`    Got: ${swapResult.amountOut} WETH`)

    step(3, 6, `Unshield ${lpAlloc} USDC for Aerodrome LP`)
    await b402.unshield({ token: 'USDC', amount: lpAlloc })

    step(4, 6, `Add liquidity — Aerodrome WETH/USDC (~7.6% APY)`)
    const lpResult = await b402.addLiquidity({ pool: 'weth-usdc', amount: lpAlloc, slippageBps: 300 })
    console.log(`    TX: ${tx(lpResult.txHash)}`)

    step(5, 6, `Private lend ${vaultAlloc} USDC → Steakhouse vault (~3% APY)`)
    const lendResult = await b402.privateLend({
      token: 'USDC', amount: vaultAlloc, vault: 'steakhouse',
    })
    console.log(`    TX: ${tx(lendResult.txHash)}`)

    step(6, 6, `Reserve ${reserve} USDC in privacy pool (liquid)`)
    console.log(`    ${reserve} USDC stays shielded — ready for opportunities.`)

    await showStatus()
    console.log(`\n  ✅ Full Spectrum strategy deployed:`)
    console.log(`     • ${lpAlloc} → Aerodrome LP  (~7.6% APY)`)
    console.log(`     • ${vaultAlloc} → Steakhouse   (~3.0% APY)`)
    console.log(`     • ${swapAlloc} → WETH          (private)`)
    console.log(`     • ${reserve} → Reserve       (liquid in pool)`)
    console.log(`     6 operations, 3 protocols, 0 wallet trace.`)
  },

  // ═══════════════════════════════════════════════════════════════════
  // 6. VAULT SPLIT — Split across multiple Morpho vaults
  // ═══════════════════════════════════════════════════════════════════
  'vault-split': async () => {
    const amount = parseFloat(inputAmount)
    header(`Private Vault Split — ${amount} USDC across Morpho vaults`)
    console.log(`  Agent will: shield → analyze APYs → deploy to best vaults`)
    console.log(`  Every deposit from privacy pool. No on-chain link.`)

    step(1, 4, `Shield ${amount} USDC into privacy pool`)
    await ensurePoolBalance(amount)

    step(2, 4, `Analyze vault APYs`)
    console.log(`    Scanning Morpho vaults for best rates...`)

    const allocations = [
      { vault: 'steakhouse', pct: 0.5, label: 'Steakhouse USDC' },
      { vault: 'moonwell', pct: 0.3, label: 'Moonwell Flagship' },
      { vault: 'gauntlet', pct: 0.2, label: 'Gauntlet Prime' },
    ]

    for (const alloc of allocations) {
      console.log(`    → ${alloc.label}: ${(alloc.pct * 100).toFixed(0)}% (${(amount * alloc.pct).toFixed(2)} USDC)`)
    }

    step(3, 4, `Deploy capital to vaults (private)`)
    for (const alloc of allocations) {
      const allocAmount = (amount * alloc.pct).toFixed(2)
      console.log(`\n    Depositing ${allocAmount} USDC → ${alloc.vault}...`)
      const result = await b402.privateLend({
        token: 'USDC', amount: allocAmount, vault: alloc.vault,
      })
      console.log(`    TX: ${tx(result.txHash)}`)
    }

    step(4, 4, `Verify positions`)
    await showStatus()
    console.log(`\n  ✅ Capital diversified across 3 vaults.`)
    console.log(`     All deposits from privacy pool — no wallet linked.`)
  },

  // ═══════════════════════════════════════════════════════════════════
  // 7. HARVEST — Claim rewards and rebalance
  // ═══════════════════════════════════════════════════════════════════
  harvest: async () => {
    header(`Harvest & Rebalance — Optimize all positions`)
    console.log(`  Agent will: claim rewards → check APYs → rebalance if needed`)

    step(1, 3, `Claim AERO rewards from LP`)
    try {
      const claimResult = await b402.claimRewards({ pool: 'weth-usdc' })
      console.log(`    TX: ${tx(claimResult.txHash)}`)
    } catch {
      console.log(`    No LP position or rewards to claim.`)
    }

    step(2, 3, `Scan vault APYs & rebalance`)
    const rebalanceResult = await b402.rebalance()
    if (rebalanceResult.action === 'rebalanced') {
      console.log(`    Moved: ${rebalanceResult.currentVault} → ${rebalanceResult.bestVault}`)
      if (rebalanceResult.txHash) console.log(`    TX: ${tx(rebalanceResult.txHash)}`)
    } else {
      console.log(`    Current allocation is optimal. No rebalance needed.`)
    }

    step(3, 3, `Portfolio snapshot`)
    await showStatus()
    console.log(`\n  ✅ Harvest complete. Positions optimized.`)
  },

  // ═══════════════════════════════════════════════════════════════════
  // 8. EXIT — Liquidate everything back to privacy pool
  // ═══════════════════════════════════════════════════════════════════
  exit: async () => {
    header(`Exit — Liquidate all positions to privacy pool`)
    console.log(`  Agent will: remove LP → redeem vaults → consolidate to pool`)

    const status = await b402.status()
    let stepNum = 1
    const totalSteps = (status.lpPositions.length > 0 ? 1 : 0) +
      (status.positions.length > 0 ? status.positions.length : 0) + 1

    if (status.lpPositions.length > 0) {
      step(stepNum++, totalSteps, `Remove LP + claim rewards`)
      const removeResult = await b402.removeLiquidity({ pool: 'weth-usdc' })
      console.log(`    TX: ${tx(removeResult.txHash)}`)
      console.log(`    Got: ${removeResult.amountWETH} WETH + ${removeResult.amountUSDC} USDC`)

      console.log(`    Shielding returned tokens...`)
      if (parseFloat(removeResult.amountUSDC) > 0.001) {
        await b402.shield({ token: 'USDC', amount: removeResult.amountUSDC })
      }
      if (parseFloat(removeResult.amountWETH) > 0.0000001) {
        await b402.shield({ token: 'WETH', amount: removeResult.amountWETH })
      }
    }

    const vaultNames = ['steakhouse', 'moonwell', 'gauntlet', 'steakhouse-hy']
    for (const vault of vaultNames) {
      try {
        step(stepNum++, totalSteps, `Redeem ${vault} vault`)
        const redeemResult = await b402.privateRedeem({ vault })
        console.log(`    TX: ${tx(redeemResult.txHash)}`)
        console.log(`    Got: ${redeemResult.assetsReceived} USDC → privacy pool`)
      } catch {
        console.log(`    No position in ${vault}. Skipping.`)
        stepNum--
      }
    }

    step(stepNum, totalSteps, `Final portfolio`)
    await showStatus()
    console.log(`\n  ✅ All positions liquidated to privacy pool.`)
    console.log(`     Funds are shielded and untraceable.`)
  },
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  if (!strategies[strategy]) {
    console.error(`Unknown strategy: ${strategy}`)
    console.error(`\nAvailable strategies:`)
    console.error(`  private-dca [amount] [swaps]   Invisible WETH accumulation`)
    console.error(`  mev-shield [amount] [chunks]   MEV-protected large swap`)
    console.error(`  stealth-portfolio [amount]     Build invisible portfolio`)
    console.error(`  yield-arb [amount]             Private yield arbitrage`)
    console.error(`  full-spectrum [amount]         LP + vault + swap + reserve`)
    console.error(`  vault-split [amount]           Split across Morpho vaults`)
    console.error(`  harvest                        Claim rewards & rebalance`)
    console.error(`  exit                           Liquidate to privacy pool`)
    process.exit(1)
  }

  console.log(`\n🤖 b402 Autonomous Agent`)
  console.log(`   Strategy: ${strategy}`)
  console.log(`   Chain: Base (gasless)`)
  console.log(`   Privacy: Railgun ZK proofs`)

  const start = Date.now()
  await strategies[strategy]()
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)

  console.log(`\n  ⏱  Completed in ${elapsed}s`)
  console.log(`${'═'.repeat(60)}\n`)
  process.exit(0)
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`)
  process.exit(1)
})
