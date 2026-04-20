#!/usr/bin/env tsx
/**
 * Unshield test: we already shielded 0.01 USDC.
 * Now unshield to a fresh EOA.
 */
import 'dotenv/config'
import { ethers } from 'ethers'
import { B402 } from '../src/b402'

const TEST_KEY = process.env.TEST_PRIVATE_KEY
if (!TEST_KEY) {
  throw new Error('TEST_PRIVATE_KEY env var required. Set in .env (gitignored).')
}
const FACILITATOR_URL = process.env.FACILITATOR_URL_ARB || 'http://localhost:3404'
process.env.B402_BACKEND_API_URL = process.env.B402_BACKEND_API_URL || 'http://localhost:3004'

async function main() {
  const b402 = new B402({
    privateKey: TEST_KEY,
    chainId: 42161,
    facilitatorUrl: FACILITATOR_URL,
    onProgress: (e) => {
      if (e.type === 'step') console.log(`  [${e.step}/${e.totalSteps}] ${e.title}: ${e.message}`)
      else console.log(`  [${e.type}] ${e.title}: ${e.message}`)
    },
  })

  const recipient = ethers.Wallet.createRandom()
  console.log(`Unshielding 0.01 USDC → ${recipient.address}`)

  const unshield = await b402.unshield({
    token: 'USDC',
    amount: '0.01',
    to: recipient.address,
  })
  console.log(`\nTX: ${unshield.txHash}`)
  console.log(`Arbiscan: https://arbiscan.io/tx/${unshield.txHash}`)

  const provider = new ethers.JsonRpcProvider(b402.rpcUrl)
  const usdc = new ethers.Contract(
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    ['function balanceOf(address) view returns (uint256)'],
    provider,
  )
  const bal = (await usdc.balanceOf(recipient.address)) as bigint
  console.log(`\nFresh EOA balance: ${ethers.formatUnits(bal, 6)} USDC`)
  if (bal === 0n) throw new Error('Recipient has no USDC')
  console.log('\n✅ UNSHIELD SUCCESS — privacy link broken')
}

main().catch((e) => {
  console.error(`\n❌ FAIL: ${e.message}`)
  if (e.stack) console.error(e.stack)
  process.exit(1)
})
