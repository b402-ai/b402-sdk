#!/usr/bin/env tsx
/**
 * Demo: Private Cross-Chain Swap (bridge + swap in one atomic call)
 *
 * "I have shielded USDC on Base. I want ARB on Arbitrum. One call."
 * LI.FI routes through a bridge+swap tool (e.g. NearIntents) — the bridge
 * and the swap happen in a single atomic settlement. No intermediate
 * holding, no multi-step UX.
 *
 * Flow (all real mainnet):
 *   1. Optional: shield USDC on Base EOA into pool    (b402.shieldFromEOA)
 *   2. Private cross-chain swap USDC(Base) -> ARB(Arb) (b402.privateCrossChain)
 *   3. Poll LI.FI /status until destination fill
 *
 * Usage:
 *   npx tsx examples/demo-cross-chain-swap.ts [amount-usdc]
 *   SKIP_SHIELD=1 npx tsx examples/demo-cross-chain-swap.ts 1
 *
 * Required env:
 *   WORKER_PRIVATE_KEY    — source wallet
 *   ARB_DEST_ADDRESS      — recipient EOA on Arbitrum (will receive ARB)
 */

import 'dotenv/config'
import { ethers } from 'ethers'
import { B402 } from '../src/b402'

const AMOUNT = process.argv[2] || '1'
const SKIP_SHIELD = process.env.SKIP_SHIELD === '1'

async function pollStatus(txHash: string): Promise<{ destTxHash: string; receivedAmount?: string }> {
  const deadline = Date.now() + 10 * 60_000
  let last: any
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`https://li.quest/v1/status?txHash=${txHash}`)
      if (res.ok) {
        last = await res.json()
        console.log(`    status: ${last.status}${last.substatus ? ` (${last.substatus})` : ''}`)
        if (last.status === 'DONE') {
          return { destTxHash: last.receiving?.txHash, receivedAmount: last.receiving?.amount }
        }
        if (last.status === 'FAILED' || last.status === 'INVALID') {
          throw new Error(`LI.FI ${last.status}`)
        }
      }
    } catch (e) {
      console.log(`    status poll hiccup: ${(e as Error).message}`)
    }
    await new Promise(r => setTimeout(r, 15_000))
  }
  throw new Error(`LI.FI did not finish in 10 min`)
}

async function main() {
  console.log()
  console.log('  === Private Cross-Chain Swap ===')
  console.log(`  ${AMOUNT} USDC (Base, shielded)  ->  ARB (Arbitrum)`)
  console.log()

  const privateKey = process.env.WORKER_PRIVATE_KEY
  const destAddress = process.env.ARB_DEST_ADDRESS
  if (!privateKey) throw new Error('WORKER_PRIVATE_KEY required')
  if (!destAddress) throw new Error('ARB_DEST_ADDRESS required')
  if (!ethers.isAddress(destAddress)) throw new Error(`Invalid ARB_DEST_ADDRESS`)

  const b402 = new B402({
    privateKey,
    rpcUrl: process.env.BASE_RPC_URL,
    facilitatorUrl: process.env.FACILITATOR_URL,
    onProgress: e => {
      if (e.type === 'step') console.log(`  [${e.step}/${e.totalSteps}] ${e.title}: ${e.message}`)
      else if (e.type === 'info') console.log(`    ${e.title}: ${e.message}`)
    },
  })

  let shieldTx: string | undefined
  if (!SKIP_SHIELD) {
    console.log('  Step 1/3 — Shield USDC on Base (gasless)\n')
    const shield = await b402.shieldFromEOA({ token: 'USDC', amount: AMOUNT })
    shieldTx = shield.txHash
    console.log(`  Base shield: https://basescan.org/tx/${shieldTx}`)
    console.log('    waiting 60s for pool indexing...')
    await new Promise(r => setTimeout(r, 60_000))
    console.log()
  } else {
    console.log('  Step 1/3 — skipped (SKIP_SHIELD=1)\n')
  }

  console.log(`  Step 2/3 — Private cross-chain swap (bridge + swap, atomic)\n`)
  const result = await b402.privateCrossChain({
    toChain: 'arbitrum',
    fromToken: 'USDC',
    toToken: 'ARB',
    amount: AMOUNT,
    destinationAddress: destAddress,
  })

  console.log(`  Tool:            ${result.tool}`)
  console.log(`  Expected out:    ${result.expectedAmountOut} ${result.toToken}`)
  console.log(`  Min out:         ${result.minAmountOut} ${result.toToken}`)
  console.log(`  Dest address:    ${result.destinationAddress}`)
  console.log(`  Source tx:       https://basescan.org/tx/${result.txHash}`)
  console.log(`  ETA:             ~${result.estimatedDurationSec}s`)
  console.log()

  console.log('  Step 3/3 — Polling LI.FI for destination fill\n')
  const { destTxHash, receivedAmount } = await pollStatus(result.txHash)
  console.log(`  Arb fill tx:     https://arbiscan.io/tx/${destTxHash}`)
  if (receivedAmount) console.log(`  Received:        ${receivedAmount} wei of ARB`)
  console.log()
  console.log('  === Complete ===\n')
  if (shieldTx) console.log(`  Shield:      https://basescan.org/tx/${shieldTx}`)
  console.log(`  Source:      https://basescan.org/tx/${result.txHash}`)
  console.log(`  Dest:        https://arbiscan.io/tx/${destTxHash}`)
  console.log()
  console.log('  One signature. Private source. Bridge + swap settled atomically across chains.\n')
}

main().catch(err => {
  console.error(`\n  Failed: ${err.message}`)
  process.exit(1)
})
