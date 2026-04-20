import 'dotenv/config'
import { B402 } from '../src/b402'
const b402 = new B402({
  privateKey: process.env.WORKER_PRIVATE_KEY!,
  rpcUrl: process.env.BASE_RPC_URL,
  onProgress: (e) => {
    if (e.type === 'step') console.log(`  [${e.step}/${e.totalSteps}] ${e.title}`)
    else if (e.type === 'done') console.log(`  ✓ ${e.message}`)
    else if (e.type === 'info') console.log(`  → ${e.title}: ${e.message}`)
  },
})
async function main() {
  console.log('Consolidating USDC UTXOs...')
  const result = await b402.consolidate({ token: 'USDC' })
  console.log(`Done: ${result.utxosConsumed} UTXOs → 1 (${result.amount} USDC)`)
  if (result.txHash) console.log(`TX: https://basescan.org/tx/${result.txHash}`)
  process.exit(0)
}
main().catch(e => { console.error(e.message); process.exit(1) })
