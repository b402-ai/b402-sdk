#!/usr/bin/env tsx
/**
 * LI.FI integration — real mainnet E2E
 *
 * Runs the full privateCrossChain pipeline against Base + Arbitrum mainnets.
 * No mocks. Asserts on-chain state (LI.FI /status DONE, dest tx hash exists).
 *
 * Opt-in: will refuse to run without RUN_LIFI_REAL=1 to prevent accidental spend.
 *
 * Usage:
 *   WORKER_PRIVATE_KEY=0x...  \
 *   ARB_DEST_ADDRESS=0x...    \
 *   RUN_LIFI_REAL=1           \
 *   npx tsx test/integration/lifi-real.ts [A|B] [amount]
 *
 * Scenario A (default): $1 USDC Base -> USDC Arb
 * Scenario B:           $1 USDC Base -> ARB Arb (bridge+swap)
 *
 * Expects pool already funded on Base (use examples/demo-private-bridge.ts
 * to do the full narrative, or run b402.shieldFromEOA yourself first).
 */

import 'dotenv/config'
import { ethers } from 'ethers'
import { B402 } from '../../src/b402'

type Scenario = 'A' | 'B'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`)
}

async function pollStatus(txHash: string, timeoutMs = 10 * 60_000): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let last: any
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`https://li.quest/v1/status?txHash=${txHash}`)
      if (res.ok) {
        last = await res.json()
        console.log(`  li.fi status=${last.status}${last.substatus ? ` (${last.substatus})` : ''}`)
        if (last.status === 'DONE') return last
        if (last.status === 'FAILED' || last.status === 'INVALID') {
          throw new Error(`LI.FI ${last.status}: ${JSON.stringify(last).slice(0, 400)}`)
        }
      }
    } catch (e) {
      console.log(`  poll hiccup: ${(e as Error).message}`)
    }
    await new Promise(r => setTimeout(r, 15_000))
  }
  throw new Error(`timeout waiting for LI.FI DONE (last=${last?.status})`)
}

async function main() {
  if (process.env.RUN_LIFI_REAL !== '1') {
    console.error('Refusing to run without RUN_LIFI_REAL=1 (safety gate).')
    process.exit(1)
  }

  const privateKey = process.env.WORKER_PRIVATE_KEY
  const destAddress = process.env.ARB_DEST_ADDRESS
  assert(privateKey, 'WORKER_PRIVATE_KEY required')
  assert(destAddress, 'ARB_DEST_ADDRESS required')
  assert(ethers.isAddress(destAddress), `invalid dest ${destAddress}`)

  const scenario: Scenario = (process.argv[2] as Scenario) || 'A'
  const amount = process.argv[3] || '1'
  const toToken = scenario === 'B' ? 'ARB' : 'USDC'

  console.log(`\n=== LI.FI real E2E — Scenario ${scenario} — ${amount} USDC Base -> ${toToken} Arb ===\n`)

  const b402 = new B402({
    privateKey,
    rpcUrl: process.env.BASE_RPC_URL,
    facilitatorUrl: process.env.FACILITATOR_URL,
    onProgress: e => {
      if (e.type === 'step') console.log(`  [${e.step}/${e.totalSteps}] ${e.title}: ${e.message}`)
      else if (e.type === 'info') console.log(`  info: ${e.title}: ${e.message}`)
    },
  })

  const t0 = Date.now()

  const result = await b402.privateCrossChain({
    toChain: 'arbitrum',
    fromToken: 'USDC',
    toToken,
    amount,
    destinationAddress: destAddress,
  })

  const t1 = Date.now()

  console.log(`\n-- privateCrossChain complete in ${(t1 - t0) / 1000}s --`)
  console.log(`  tool:       ${result.tool}`)
  console.log(`  source tx:  https://basescan.org/tx/${result.txHash}`)
  console.log(`  expected:   ${result.expectedAmountOut} ${result.toToken}`)
  console.log(`  min:        ${result.minAmountOut} ${result.toToken}`)
  console.log(`  dest addr:  ${result.destinationAddress}`)

  // Assertions on source-chain tx
  assert(result.txHash.startsWith('0x') && result.txHash.length === 66, 'invalid txHash')
  assert(result.tool, 'missing tool name')
  assert(Number(result.minAmountOut) > 0, 'minAmountOut must be > 0')

  // Poll LI.FI status
  console.log(`\n-- polling LI.FI status --`)
  const status = await pollStatus(result.txHash)
  const destTx = status.receiving?.txHash
  const destAmount = status.receiving?.amount
  assert(destTx, 'no destination txHash from LI.FI')
  console.log(`  dest tx:    https://arbiscan.io/tx/${destTx}`)
  if (destAmount) console.log(`  received:   ${destAmount} wei of ${result.toToken}`)

  // Verify dest tx exists on Arbitrum
  console.log(`\n-- verifying dest tx on Arbitrum --`)
  const arbRpc = process.env.ARB_RPC_URL || 'https://arb1.arbitrum.io/rpc'
  const arbProvider = new ethers.JsonRpcProvider(arbRpc)
  const receipt = await arbProvider.getTransactionReceipt(destTx)
  assert(receipt, `dest receipt not found on Arbitrum`)
  assert(receipt.status === 1, `dest tx reverted (status=${receipt.status})`)
  console.log(`  dest block: ${receipt.blockNumber}`)
  console.log(`  dest gas:   ${receipt.gasUsed.toString()}`)

  const total = (Date.now() - t0) / 1000
  console.log(`\n=== PASS — total ${total.toFixed(1)}s ===\n`)
}

main().catch(err => {
  console.error(`\n=== FAIL: ${err.message} ===\n`)
  if (err.stack) console.error(err.stack.split('\n').slice(1, 6).join('\n'))
  process.exit(1)
})
