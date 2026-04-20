import { B402 } from '@b402ai/sdk'
import { getPrivateKey } from './wallet-store.js'

let instance: B402 | null = null

export function getB402(): B402 {
  if (!instance) {
    const privateKey = getPrivateKey()
    if (!privateKey) {
      throw new Error('No wallet found. Run: npx b402-mcp --claude')
    }
    instance = new B402({
      privateKey,
      rpcUrl: process.env.BASE_RPC_URL,
      facilitatorUrl: process.env.FACILITATOR_URL,
    })
  }
  return instance
}
