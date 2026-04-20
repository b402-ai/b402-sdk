import 'dotenv/config'
import { ethers } from 'ethers'
import { deriveRailgunKeys, getRailgunAddress } from '../src/privacy/lib/key-derivation'
async function main() {
  const signer = new ethers.Wallet(process.env.WORKER_PRIVATE_KEY!)
  const sig = await signer.signMessage('b402 Incognito EOA Derivation')
  const keys = await deriveRailgunKeys(sig)
  const railgunAddr = getRailgunAddress(keys)
  console.log('Railgun address:', railgunAddr)
  process.exit(0)
}
main()
