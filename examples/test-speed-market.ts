#!/usr/bin/env tsx
/**
 * Test: Place a $2 speed market bet (ETH UP, 1 minute)
 * Uses WORKER_PRIVATE_KEY_MAIN
 */
import { B402 } from '../src/b402'
import * as dotenv from 'dotenv'
dotenv.config()

async function main() {
  const key = process.env.WORKER_PRIVATE_KEY_MAIN
  if (!key) { console.error('WORKER_PRIVATE_KEY_MAIN not set'); process.exit(1) }

  const b402 = new B402({
    privateKey: key,
    rpcUrl: process.env.BASE_RPC_URL,
    facilitatorUrl: process.env.FACILITATOR_URL,
    onProgress: (e) => {
      if (e.type === 'step') console.log(`  [${e.step}/${e.totalSteps}] ${e.title}: ${e.message}`)
      else if (e.type === 'done') console.log(`  ✓ ${e.message}`)
      else if (e.type === 'info') console.log(`    ${e.title}: ${e.message}`)
    },
  })

  // Check balance first
  const status = await b402.status()
  console.log(`\n  Wallet:  ${status.smartWallet}`)
  console.log(`  Balance: ${status.balances.map(b => `${b.balance} ${b.token}`).join(', ')}`)
  console.log()

  // Place speed market bet
  console.log('  Placing: ETH UP, $2 USDC, 1 minute')
  console.log()

  const result = await b402.speedMarket({
    asset: 'ETH',
    direction: 'up',
    amount: '2',
    duration: '1m',
  })

  console.log()
  console.log(`  TX:      https://basescan.org/tx/${result.txHash}`)
  console.log(`  Asset:   ${result.asset} ${result.direction}`)
  console.log(`  Amount:  ${result.amount} USDC`)
  console.log(`  Settles: ${new Date(result.strikeTime * 1000).toLocaleTimeString()} (in ~60s)`)
  console.log()

  // Check balance after
  const after = await b402.status()
  console.log(`  Balance after: ${after.balances.map(b => `${b.balance} ${b.token}`).join(', ')}`)
}

main().catch(e => {
  console.error(`\n  Failed: ${e.message}`)
  process.exit(1)
})
