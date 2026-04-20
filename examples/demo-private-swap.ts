#!/usr/bin/env tsx
/**
 * Private Swap Demo — Screen recording script
 *
 * Shows: import SDK → private swap → tx link
 * Run:   npx tsx examples/demo-private-swap.ts [amount]
 */

import { B402 } from '../src/b402'
import * as dotenv from 'dotenv'
dotenv.config()

const amt = process.argv[2] || '0.5'

async function main() {
  console.log()
  console.log('  import { B402 } from "@b402ai/sdk"')
  console.log()
  console.log('  const b402 = new B402({ privateKey: "0x..." })')
  console.log()

  const b402 = new B402({
    privateKey: process.env.WORKER_PRIVATE_KEY!,
    rpcUrl: process.env.BASE_RPC_URL,
    facilitatorUrl: process.env.FACILITATOR_URL,
    onProgress: (e) => {
      if (e.type === 'step') console.log(`  [${e.step}/${e.totalSteps}] ${e.title}`)
      else if (e.type === 'done') console.log(`  ✓ ${e.message}`)
      else if (e.type === 'info') console.log(`    ${e.title}: ${e.message}`)
    },
  })

  console.log(`  await b402.privateSwap({ from: "USDC", to: "WETH", amount: "${amt}" })`)
  console.log()

  const result = await b402.privateSwap({ from: 'USDC', to: 'WETH', amount: amt })

  console.log()
  console.log(`  Swapped:   ${result.amountIn} ${result.tokenIn} → ${result.amountOut} ${result.tokenOut}`)
  console.log(`  TX:        https://basescan.org/tx/${result.txHash}`)
  console.log()
  console.log('  Wallet never appears on-chain.')
  console.log()
}

main().catch(err => {
  console.error(`\n  Failed: ${err.message}`)
  process.exit(1)
})
