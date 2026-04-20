import 'dotenv/config'
import { B402 } from '../src/b402'

const to = process.argv[2]
const amount = process.argv[3] || '5'
if (!to) { console.error('Usage: npx tsx examples/unshield-to.ts <address> [amount]'); process.exit(1) }

const b402 = new B402({
  privateKey: process.env.WORKER_PRIVATE_KEY!,
  onProgress: (e) => {
    if (e.type === 'step') console.log(`  [${e.step}/${e.totalSteps}] ${e.title}`)
    else if (e.type === 'done') console.log(`  ✓ ${e.message}`)
    else if (e.type === 'info') console.log(`  → ${e.title}: ${e.message}`)
  },
})

async function main() {
  console.log(`\nUnshielding ${amount} USDC → ${to}`)
  const result = await b402.unshield({ token: 'USDC', amount, to })
  console.log(`TX: https://basescan.org/tx/${result.txHash}`)
  process.exit(0)
}
main().catch(e => { console.error('Error:', e.message); process.exit(1) })
