#!/usr/bin/env tsx
/**
 * Test SynFutures V3 integration — read-only checks against live Base contracts
 */
import { ethers } from 'ethers'
import * as dotenv from 'dotenv'
dotenv.config()

import {
  SYNFUTURES_CONTRACTS,
  SYNFUTURES_INSTRUMENTS,
  getAmmState,
  getQuote,
  getGateReserve,
  getInstrumentCount,
  getPosition,
  buildOpenPositionCalls,
} from '../src/trade/synfutures'

const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org')

async function main() {
  console.log('=== SynFutures V3 on Base — Live Verification ===\n')

  // 1. Check instruments
  console.log('--- Instruments ---')
  const count = await getInstrumentCount(provider)
  console.log(`  Total on-chain instruments: ${count}`)
  console.log(`  Known instruments: ${Object.keys(SYNFUTURES_INSTRUMENTS).join(', ')}\n`)

  // 2. Check AMM state for each known instrument
  for (const [name, inst] of Object.entries(SYNFUTURES_INSTRUMENTS)) {
    console.log(`--- ${name} (${inst.type}) ---`)
    try {
      const amm = await getAmmState(name, provider)
      const price = Number(amm.priceUsd)
      console.log(`  Price:     $${price.toFixed(6)}`)
      console.log(`  Tick:      ${amm.tick}`)
      console.log(`  Liquidity: ${ethers.formatEther(amm.liquidity)}`)
      console.log(`  Long OI:   ${ethers.formatEther(amm.totalLong)}`)
      console.log(`  Short OI:  ${ethers.formatEther(amm.totalShort)}`)
      console.log(`  Status:    ${amm.status} (1=TRADING)`)
    } catch (e: any) {
      console.log(`  Error: ${e.message?.slice(0, 100)}`)
    }
    console.log()
  }

  // 3. Get a quote for a $20 LINK long
  console.log('--- Quote: $20 LINK LONG ---')
  try {
    const quote = await getQuote('LINK', '20', 'long', provider)
    console.log(`  Size:       ${ethers.formatEther(quote.size)} LINK`)
    console.log(`  Benchmark:  $${ethers.formatEther(quote.benchmark)}`)
    console.log(`  Mark:       $${ethers.formatEther(quote.mark)}`)
    console.log(`  Fee:        $${ethers.formatEther(quote.fee)}`)
    console.log(`  Min margin: $${ethers.formatEther(quote.minAmount)}`)
    console.log(`  Tick:       ${quote.tick}`)
  } catch (e: any) {
    console.log(`  Error: ${e.message?.slice(0, 200)}`)
  }
  console.log()

  // 4. Build calls (dry-run, don't execute)
  console.log('--- Build Calls (dry-run) ---')
  try {
    const quote = await getQuote('LINK', '20', 'long', provider)
    const calls = buildOpenPositionCalls(
      { instrument: 'LINK', side: 'long', notional: '20', margin: '10' },
      { size: quote.size, minAmount: quote.minAmount, tick: quote.tick },
    )
    console.log(`  Built ${calls.length} calls:`)
    calls.forEach((c, i) => {
      console.log(`    ${i + 1}. to=${c.to.slice(0, 10)}... selector=${c.data.slice(0, 10)}`)
    })
  } catch (e: any) {
    console.log(`  Error: ${e.message?.slice(0, 200)}`)
  }
  console.log()

  // 5. Check wallet position (if key available)
  const key = process.env.WORKER_PRIVATE_KEY_MAIN
  if (key) {
    const wallet = new ethers.Wallet(key, provider)
    console.log(`--- Wallet: ${wallet.address} ---`)
    const reserve = await getGateReserve(wallet.address, provider)
    console.log(`  Gate reserve: ${ethers.formatUnits(reserve, 6)} USDC`)

    for (const name of Object.keys(SYNFUTURES_INSTRUMENTS)) {
      const pos = await getPosition(name, wallet.address, provider)
      if (pos) {
        console.log(`  ${name}: ${pos.side} ${pos.size} (balance: ${pos.balance})`)
      }
    }
  }

  console.log('\n=== Done ===')
}

main().catch(e => console.error(e.message)).then(() => process.exit(0))
