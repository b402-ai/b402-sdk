#!/usr/bin/env tsx
/**
 * @b402ai/sdk — Real Integration Test
 *
 * Tests each SDK operation on Base mainnet.
 * Run specific tests with: npx tsx test/integration/sdk-real.ts [test-name]
 *
 * Available tests:
 *   status     — Check wallet addresses, balances, positions
 *   shield     — Shield USDC from EOA into Railgun privacy pool (needs USDC + ETH on EOA)
 *   lend       — Deposit USDC into Morpho vault (needs USDC on smart wallet)
 *   redeem     — Withdraw from Morpho vault (needs vault position)
 *   swap       — Swap USDC→WETH via 0x (needs USDC on smart wallet + ZERO_X_API_KEY)
 *   rebalance  — Move capital to best vault (needs vault position)
 *   unshield   — Unshield USDC from privacy pool to smart wallet (ZK proof)
 *   private-swap   — Swap from privacy pool via RelayAdapt + Aerodrome
 *   private-lend   — Deposit from privacy pool to Morpho vault via RelayAdapt
 *   private-redeem — Withdraw from Morpho vault to privacy pool via RelayAdapt
 *   all        — Run all tests in order
 *
 * Usage:
 *   npx tsx test/integration/sdk-real.ts status
 *   npx tsx test/integration/sdk-real.ts shield
 *   npx tsx test/integration/sdk-real.ts lend
 *   npx tsx test/integration/sdk-real.ts all
 */

import { B402 } from '../../src/b402'
import { ethers } from 'ethers'
import * as dotenv from 'dotenv'
dotenv.config()

const privateKey = process.env.WORKER_PRIVATE_KEY
if (!privateKey) {
  console.error('Set WORKER_PRIVATE_KEY in .env')
  process.exit(1)
}

const b402 = new B402({
  privateKey,
  zeroXApiKey: process.env.ZERO_X_API_KEY,
  rpcUrl: process.env.BASE_RPC_URL,
  onProgress: (e) => {
    if (e.type === 'step') console.log(`  [${e.step}/${e.totalSteps}] ${e.title}`)
    else if (e.type === 'done') console.log(`  ✓ ${e.message}`)
    else if (e.type === 'info') console.log(`  ℹ ${e.title}: ${e.message}`)
  },
})

// ── Test: Status ──────────────────────────────────────────────────────

async function testStatus() {
  console.log('\n━━━ STATUS ━━━')
  const status = await b402.status()

  console.log(`  Incognito EOA:  ${status.ownerEOA}`)
  console.log(`  Smart Wallet:   ${status.smartWallet}`)
  console.log(`  Deployed:       ${status.deployed}`)
  console.log(`  Chain:          ${status.chain}`)

  if (status.shieldedBalances.length > 0) {
    console.log('  Privacy Pool:')
    for (const b of status.shieldedBalances) {
      console.log(`    ${b.token}: ${b.balance} (shielded)`)
    }
  } else {
    console.log('  Privacy Pool:   (empty)')
  }

  if (status.balances.length > 0) {
    console.log('  Smart Wallet:')
    for (const b of status.balances) {
      console.log(`    ${b.token}: ${b.balance}`)
    }
  } else {
    console.log('  Smart Wallet:   (empty)')
  }

  if (status.positions.length > 0) {
    console.log('  Positions:')
    for (const p of status.positions) {
      console.log(`    ${p.vault}: ${p.assets} (${p.apyEstimate})`)
    }
  } else {
    console.log('  Positions:      (none)')
  }

  // Also check EOA balance (the master key's EOA, for shield)
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org')
  const masterWallet = new ethers.Wallet(privateKey!)
  const eoaAddress = masterWallet.address

  const ethBalance = await provider.getBalance(eoaAddress)
  const usdcContract = new ethers.Contract(
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    ['function balanceOf(address) view returns (uint256)'],
    provider,
  )
  const usdcBalance = await usdcContract.balanceOf(eoaAddress)

  console.log(`\n  Master EOA:     ${eoaAddress}`)
  console.log(`  EOA ETH:        ${ethers.formatEther(ethBalance)} ETH`)
  console.log(`  EOA USDC:       ${ethers.formatUnits(usdcBalance, 6)} USDC`)

  // Check smart wallet USDC too
  const swUsdcBalance = await usdcContract.balanceOf(status.smartWallet)
  console.log(`  Wallet USDC:    ${ethers.formatUnits(swUsdcBalance, 6)} USDC`)

  console.log('\n  ✓ Status check complete')
  return status
}

// ── Test: Shield ──────────────────────────────────────────────────────

async function testShield() {
  console.log('\n━━━ SHIELD ━━━')
  console.log('  Shielding 1 USDC from EOA → Railgun privacy pool')
  console.log('  (requires USDC + ETH for gas on master EOA)')

  const result = await b402.shield({ token: 'USDC', amount: '1' })

  console.log(`  TX:      ${result.txHash}`)
  console.log(`  Indexed: ${result.indexed}`)
  console.log(`  View:    https://basescan.org/tx/${result.txHash}`)
  console.log('\n  ✓ Shield complete')
  return result
}

// ── Test: Lend ────────────────────────────────────────────────────────

async function testLend() {
  console.log('\n━━━ LEND ━━━')
  console.log('  Depositing 1 USDC into Steakhouse vault')
  console.log('  (requires USDC on smart wallet)')

  const result = await b402.lend({
    token: 'USDC',
    amount: '1',
    vault: 'steakhouse',
  })

  console.log(`  TX:    ${result.txHash}`)
  console.log(`  Amount: ${result.amount} USDC`)
  console.log(`  Vault:  ${result.vault}`)
  console.log(`  View:   https://basescan.org/tx/${result.txHash}`)
  console.log('\n  ✓ Lend complete')
  return result
}

// ── Test: Redeem ──────────────────────────────────────────────────────

async function testRedeem() {
  console.log('\n━━━ REDEEM ━━━')
  console.log('  Redeeming all shares from Steakhouse vault')
  console.log('  (requires position in vault)')

  const result = await b402.redeem({ vault: 'steakhouse' })

  console.log(`  TX:     ${result.txHash}`)
  console.log(`  Assets: ${result.assetsReceived} USDC`)
  console.log(`  Vault:  ${result.vault}`)
  console.log(`  View:   https://basescan.org/tx/${result.txHash}`)
  console.log('\n  ✓ Redeem complete')
  return result
}

// ── Test: Swap ────────────────────────────────────────────────────────

async function testSwap() {
  console.log('\n━━━ SWAP ━━━')
  console.log('  Swapping 1 USDC → WETH via 0x')
  console.log('  (requires USDC on smart wallet + ZERO_X_API_KEY)')

  if (!process.env.ZERO_X_API_KEY) {
    console.log('  ⚠ Skipped — ZERO_X_API_KEY not set')
    return null
  }

  const result = await b402.swap({
    from: 'USDC',
    to: 'WETH',
    amount: '1',
  })

  console.log(`  TX:       ${result.txHash}`)
  console.log(`  Sold:     ${result.amountIn} ${result.tokenIn}`)
  console.log(`  Received: ${result.amountOut} ${result.tokenOut}`)
  console.log(`  View:     https://basescan.org/tx/${result.txHash}`)
  console.log('\n  ✓ Swap complete')
  return result
}

// ── Test: Rebalance ───────────────────────────────────────────────────

async function testRebalance() {
  console.log('\n━━━ REBALANCE ━━━')

  const result = await b402.rebalance()

  console.log(`  Action:  ${result.action}`)
  if (result.currentVault) console.log(`  Current: ${result.currentVault}`)
  if (result.bestVault) console.log(`  Best:    ${result.bestVault}`)
  if (result.txHash) console.log(`  TX:      ${result.txHash}`)
  console.log('\n  ✓ Rebalance check complete')
  return result
}

// ── Test: Static Helpers ──────────────────────────────────────────────

function testStatic() {
  console.log('\n━━━ STATIC HELPERS ━━━')

  console.log('  Vaults:')
  for (const v of B402.vaults) {
    console.log(`    ${v.name}: ${v.fullName} (${v.address.slice(0, 10)}...)`)
  }

  console.log('  Tokens:')
  for (const t of B402.tokens) {
    console.log(`    ${t.symbol}: ${t.address.slice(0, 10)}... (${t.decimals} decimals)`)
  }

  console.log('\n  ✓ Static helpers OK')
}

// ── Test: Unshield ───────────────────────────────────────────────────

async function testUnshield() {
  console.log('\n━━━ UNSHIELD ━━━')
  console.log('  Unshielding 0.1 USDC from privacy pool → smart wallet (ZK proof)')
  console.log('  (requires shielded USDC in privacy pool)')

  const result = await b402.unshield({ token: 'USDC', amount: '0.1' })

  console.log(`  TX:    ${result.txHash}`)
  console.log(`  Proof: ${result.proofTimeSeconds.toFixed(1)}s`)
  console.log(`  View:  https://basescan.org/tx/${result.txHash}`)
  console.log('\n  ✓ Unshield complete')
  return result
}

// ── Test: Private Swap ──────────────────────────────────────────────

async function testPrivateSwap() {
  console.log('\n━━━ PRIVATE SWAP ━━━')
  console.log('  Swapping 0.01 USDC → WETH via RelayAdapt + Aerodrome (fully private)')
  console.log('  (requires shielded USDC in privacy pool)')

  const result = await b402.privateSwap({
    from: 'USDC',
    to: 'WETH',
    amount: '0.01',
    slippageBps: 300, // 3% for tiny amount
  })

  console.log(`  TX:       ${result.txHash}`)
  console.log(`  Swapped:  ${result.amountIn} ${result.tokenIn} → ${result.amountOut} ${result.tokenOut}`)
  console.log(`  View:     https://basescan.org/tx/${result.txHash}`)
  console.log('\n  ✓ Private swap complete')
  return result
}

// ── Test: Private Lend ──────────────────────────────────────────────

async function testPrivateLend() {
  console.log('\n━━━ PRIVATE LEND ━━━')
  console.log('  Depositing 0.01 USDC from privacy pool → Steakhouse vault via RelayAdapt')
  console.log('  (requires shielded USDC in privacy pool)')

  const result = await b402.privateLend({
    token: 'USDC',
    amount: '0.01',
    vault: 'steakhouse',
  })

  console.log(`  TX:    ${result.txHash}`)
  console.log(`  Amount: ${result.amount} USDC`)
  console.log(`  Vault:  ${result.vault}`)
  console.log(`  View:   https://basescan.org/tx/${result.txHash}`)
  console.log('\n  ✓ Private lend complete')
  return result
}

// ── Test: Private Redeem ────────────────────────────────────────────

async function testPrivateRedeem() {
  console.log('\n━━━ PRIVATE REDEEM ━━━')
  console.log('  Redeeming vault shares from privacy pool → USDC back to pool via RelayAdapt')
  console.log('  (requires shielded vault shares from privateLend)')

  const result = await b402.privateRedeem({ vault: 'steakhouse' })

  console.log(`  TX:       ${result.txHash}`)
  console.log(`  Received: ${result.assetsReceived} USDC`)
  console.log(`  Vault:    ${result.vault}`)
  console.log(`  View:     https://basescan.org/tx/${result.txHash}`)
  console.log('\n  ✓ Private redeem complete')
  return result
}

// ── Runner ────────────────────────────────────────────────────────────

const TESTS: Record<string, () => Promise<any>> = {
  status: testStatus,
  shield: testShield,
  unshield: testUnshield,
  lend: testLend,
  redeem: testRedeem,
  swap: testSwap,
  rebalance: testRebalance,
  'private-swap': testPrivateSwap,
  'private-lend': testPrivateLend,
  'private-redeem': testPrivateRedeem,
}

async function main() {
  const arg = process.argv[2] || 'status'

  console.log('╔══════════════════════════════════════╗')
  console.log('║   @b402ai/sdk Integration Test         ║')
  console.log('╚══════════════════════════════════════╝')

  testStatic()

  if (arg === 'all') {
    for (const name of ['status', 'shield', 'unshield', 'lend', 'redeem', 'swap', 'rebalance']) {
      try {
        await TESTS[name]()
      } catch (err: any) {
        console.error(`  ✗ ${name} FAILED: ${err.message}`)
      }
    }
  } else if (arg === 'private-all') {
    // Run all private pool operations
    for (const name of ['status', 'private-swap', 'private-lend', 'private-redeem']) {
      try {
        await TESTS[name]()
      } catch (err: any) {
        console.error(`  ✗ ${name} FAILED: ${err.message}`)
      }
    }
  } else if (TESTS[arg]) {
    await TESTS[arg]()
  } else {
    console.error(`Unknown test: ${arg}`)
    console.error(`Available: ${Object.keys(TESTS).join(', ')}, all, private-all`)
    process.exit(1)
  }

  console.log('\n═══ Done ═══')
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`\nFAILED: ${err.message}`)
  process.exit(1)
})
