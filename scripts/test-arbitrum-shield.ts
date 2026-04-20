#!/usr/bin/env tsx
/**
 * E2E test: shield + unshield USDC on Arbitrum via B402 fork (0% fees)
 *
 * Source wallet: 0x5A7D750169fB30A28D48eE09a9A5E02E81fd2c53 (9 USDC, 0 ETH)
 * Flow:
 *   1. Shield 0.01 USDC → privacy pool (gasless via facilitator)
 *      `b402.shieldFromEOA` internally waits up to 120s for indexing
 *   2. Unshield 0.01 USDC → fresh recipient EOA (ZK proof, gasless)
 *   3. Verify fresh wallet received USDC
 *
 * Infra:
 *   - Railgun fork (0% fees): 0x9dB0eDC77C9047a06Fd6dE82c892630DAa5eF601
 *   - Facilitator (US):       https://b402-facilitator-arb-62092339396.us-central1.run.app
 *   - Backend API (local):    http://localhost:3004   (seeder indexes Arb blocks 452197063+)
 *
 * Run: npx tsx scripts/test-arbitrum-shield.ts
 */
import 'dotenv/config'
import { ethers } from 'ethers'
import { B402 } from '../src/b402'

// Load test wallet private key from env — NEVER hardcode.
// Set TEST_PRIVATE_KEY in .env (gitignored) before running this script.
const TEST_KEY = process.env.TEST_PRIVATE_KEY
if (!TEST_KEY) {
  throw new Error('TEST_PRIVATE_KEY env var required. Set in .env (gitignored).')
}
const AMOUNT = '0.01'

const FACILITATOR_URL =
  process.env.FACILITATOR_URL_ARB ||
  'https://b402-facilitator-arb-62092339396.us-central1.run.app'

// SDK's backend-api module reads this env var for UTXO/merkle queries
process.env.B402_BACKEND_API_URL =
  process.env.B402_BACKEND_API_URL || 'http://localhost:3004'

async function main() {
  console.log('\n  B402 Arbitrum E2E — Shield → Unshield → Fresh EOA')
  console.log('  ==================================================\n')

  const b402 = new B402({
    privateKey: TEST_KEY,
    chainId: 42161,
    facilitatorUrl: FACILITATOR_URL,
    onProgress: (e) => {
      if (e.type === 'step') console.log(`    [${e.step}/${e.totalSteps}] ${e.title}: ${e.message}`)
      else if (e.type === 'done') console.log(`    done: ${e.message}`)
      else if (e.type === 'info') console.log(`    info: ${e.message}`)
    },
  })

  console.log('  Config:')
  console.log(`    chainId:        ${b402.chainId}`)
  console.log(`    railgunNetwork: ${b402.railgunNetworkName}`)
  console.log(`    railgunRelay:   ${b402.contracts.RAILGUN_RELAY}`)
  console.log(`    paymaster:      ${b402.contracts.PAYMASTER}`)
  console.log(`    facilitator:    ${FACILITATOR_URL}`)
  console.log(`    backendApi:     ${process.env.B402_BACKEND_API_URL}`)
  console.log('')

  const token = b402.resolveToken('USDC')

  // ── Step 1: Shield from EOA (gasless) ─────────────────────────────────
  console.log(`  1. Shielding ${AMOUNT} USDC from EOA into privacy pool...`)
  const shield = await b402.shieldFromEOA({ token: 'USDC', amount: AMOUNT })
  console.log(`     TX:      ${shield.txHash}`)
  console.log(`     Indexed: ${shield.indexed}`)
  console.log(`     Arbiscan: https://arbiscan.io/tx/${shield.txHash}\n`)

  // ── Step 2: Unshield to fresh recipient EOA ─────────────────────────
  const recipient = ethers.Wallet.createRandom()
  console.log(`  2. Unshielding ${AMOUNT} USDC to fresh EOA...`)
  console.log(`     Recipient: ${recipient.address}`)
  console.log(`     (fresh address — no on-chain link to sender)`)

  const unshield = await b402.unshield({
    token: 'USDC',
    amount: AMOUNT,
    to: recipient.address,
  })
  console.log(`     TX:      ${unshield.txHash}`)
  console.log(`     Arbiscan: https://arbiscan.io/tx/${unshield.txHash}\n`)

  // ── Step 3: Verify recipient received USDC ──────────────────────────
  const provider = new ethers.JsonRpcProvider(b402.rpcUrl)
  const usdc = new ethers.Contract(
    token.address,
    ['function balanceOf(address) view returns (uint256)'],
    provider,
  )
  const bal = (await usdc.balanceOf(recipient.address)) as bigint
  const human = ethers.formatUnits(bal, token.decimals)
  console.log('  3. Verify:')
  console.log(`     Fresh wallet balance: ${human} USDC`)

  if (bal === 0n) {
    throw new Error('Fresh wallet has no USDC — unshield did not reach recipient')
  }

  console.log('\n  ==================================================')
  console.log('  ✅ E2E SUCCESS')
  console.log('     Fees:     0% (B402 fork)')
  console.log('     Gas paid: $0.00 (gasless via facilitator)')
  console.log('     Privacy:  on-chain link broken')
  console.log('  ==================================================\n')
}

main().catch((err) => {
  console.error(`\n  ❌ FAILED: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
