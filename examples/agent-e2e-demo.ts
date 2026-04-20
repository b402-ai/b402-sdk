#!/usr/bin/env tsx
/**
 * Agent E2E Demo — full private DeFi flow on Base mainnet
 *
 * What this shows:
 *   1. Shield USDC into privacy pool (breaks on-chain link)
 *   2. Unshield from pool to anonymous smart wallet (ZK proof)
 *   3. Deposit into Morpho yield vault (gasless)
 *   4. Withdraw from vault
 *   5. Final status check
 *
 * This is the script an agent would write after reading SKILL.md.
 *
 * Setup:
 *   export PRIVATE_KEY=0x...          # needs USDC + ETH on Base
 *   export FACILITATOR_URL=...        # optional, defaults to production
 *   npx tsx examples/agent-e2e-demo.ts
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
    else if (e.type === 'done') console.log(`    done: ${e.message}`)
  },
})

const SHIELD_AMOUNT = '0.5'
const UNSHIELD_AMOUNT = '0.3'
const LEND_AMOUNT = '0.2'

async function main() {
  console.log('\n  b402 SDK — Private DeFi on Base')
  console.log('  ================================\n')

  // Step 1: Status — where are we starting?
  console.log('  1. Checking wallet...')
  const before = await b402.status()
  console.log(`     Wallet:  ${before.smartWallet}`)
  console.log(`     Balance: ${before.balances.map(b => `${b.balance} ${b.token}`).join(', ') || 'empty'}`)
  console.log(`     Deployed: ${before.deployed}\n`)

  // Step 2: Shield — deposit USDC into privacy pool
  console.log(`  2. Shielding ${SHIELD_AMOUNT} USDC into privacy pool...`)
  const shield = await b402.shield({ token: 'USDC', amount: SHIELD_AMOUNT })
  console.log(`     TX: ${shield.txHash}`)
  console.log(`     Indexed: ${shield.indexed}\n`)

  // Step 3: Unshield — ZK proof withdrawal to anonymous wallet
  console.log(`  3. Unshielding ${UNSHIELD_AMOUNT} USDC (ZK proof)...`)
  const unshield = await b402.unshield({ token: 'USDC', amount: UNSHIELD_AMOUNT })
  console.log(`     TX: ${unshield.txHash}`)
  console.log(`     Proof: ${unshield.proofTimeSeconds.toFixed(1)}s\n`)

  // Step 4: Lend — deposit into Morpho vault for yield
  console.log(`  4. Depositing ${LEND_AMOUNT} USDC into Steakhouse vault...`)
  const lend = await b402.lend({ token: 'USDC', amount: LEND_AMOUNT, vault: 'steakhouse' })
  console.log(`     TX: ${lend.txHash}`)
  console.log(`     Vault: ${lend.vault}\n`)

  // Step 5: Check position
  console.log('  5. Checking position...')
  const mid = await b402.status()
  console.log(`     Balance: ${mid.balances.map(b => `${b.balance} ${b.token}`).join(', ') || 'empty'}`)
  console.log(`     Position: ${mid.positions.map(p => `${p.assets} in ${p.vault} (${p.apyEstimate} APY)`).join(', ')}\n`)

  // Step 6: Redeem — withdraw from vault
  console.log('  6. Withdrawing from Steakhouse vault...')
  const redeem = await b402.redeem({ vault: 'steakhouse' })
  console.log(`     TX: ${redeem.txHash}`)
  console.log(`     Received: ${redeem.assetsReceived} USDC\n`)

  // Step 7: Final status
  console.log('  7. Final status...')
  const after = await b402.status()
  console.log(`     Balance: ${after.balances.map(b => `${b.balance} ${b.token}`).join(', ') || 'empty'}`)
  console.log(`     Positions: ${after.positions.length === 0 ? 'none' : after.positions.map(p => `${p.assets} in ${p.vault}`).join(', ')}`)

  console.log('\n  ================================')
  console.log('  Gas paid: $0.00')
  console.log('  Privacy: on-chain link broken')
  console.log('  ================================\n')
}

main().catch((err) => {
  console.error(`\n  Failed: ${err.message}`)
  process.exit(1)
})
