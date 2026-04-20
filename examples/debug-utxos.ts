import 'dotenv/config'
import { ethers } from 'ethers'
import { deriveRailgunKeys } from '../src/privacy/lib/key-derivation'
import { fetchCommitmentsByEOA, fetchNullifierDataBatched } from '../src/privacy/lib/api'
import { getBackendApiUrl } from '../src/config/chains'

const INCOGNITO_MESSAGE = 'b402 Incognito EOA Derivation'

async function main() {
  const signer = new ethers.Wallet(process.env.WORKER_PRIVATE_KEY!)
  const sig = await signer.signMessage(INCOGNITO_MESSAGE)
  const keys = await deriveRailgunKeys(sig)
  const apiUrl = getBackendApiUrl(8453)
  const wallet = '0xde1fCbb09390C6450ab6af4d178Ea3D2dd6C3F4e'

  console.log('Backend:', apiUrl)
  console.log('Wallet:', wallet)

  // Step 1: Get shields
  const { shields } = await fetchCommitmentsByEOA(apiUrl, wallet, undefined, 8453)
  console.log(`\nShields from backend: ${shields.length}`)

  // Step 2: Decrypt
  const { ShieldNote, ByteUtils, ByteLength } = await import('@railgun-community/engine')
  const { getSharedSymmetricKey } = await import('@railgun-community/engine/dist/utils/keys-utils')
  const { poseidon } = await import('@railgun-community/engine/dist/utils/poseidon')

  let decrypted = 0
  let failed = 0
  const decryptedShields: any[] = []

  for (const shield of shields) {
    try {
      const sharedKey = getSharedSymmetricKey(
        keys.viewingKeyPair.privateKey,
        ByteUtils.hexToBigInt(shield.shieldKey || shield.senderCiphertext?.slice(0, 64) || '0')
      )
      if (!sharedKey) { failed++; continue }

      const note = ShieldNote.decrypt(
        shield.commitmentHash,
        {
          encryptedBundle: shield.encryptedBundle || [shield.encryptedRandom?.[0] || '', shield.encryptedRandom?.[1] || ''],
          shieldKey: shield.shieldKey || '',
        },
        sharedKey,
        keys.masterPublicKey,
        undefined
      )
      if (!note) { failed++; continue }

      const pos = parseInt(shield.position, 10)
      const nullifier = poseidon([keys.nullifyingKey, BigInt(pos)]).toString(16).padStart(64, '0')

      decryptedShields.push({ shield, note, nullifier: '0x' + nullifier, position: pos })
      decrypted++
    } catch {
      failed++
    }
  }

  console.log(`Decrypted: ${decrypted}, Failed: ${failed}`)

  // Step 3: Check nullifiers
  if (decryptedShields.length > 0) {
    const nullifiers = decryptedShields.map(d => d.nullifier)
    const status = await fetchNullifierDataBatched(apiUrl, nullifiers, 8453)

    const usedSet = new Set(status.used.map((n: any) => n.nullifier.toLowerCase()))
    const unusedSet = new Set(status.unused.map((n: any) => n.toLowerCase()))

    let spendable = 0
    let spent = 0
    let dropped = 0

    for (const d of decryptedShields) {
      const isUsed = usedSet.has(d.nullifier.toLowerCase())
      const isUnused = unusedSet.has(d.nullifier.toLowerCase())

      if (isUsed) {
        spent++
      } else if (isUnused) {
        spendable++
        const tokenAddr = d.note.tokenData?.tokenAddress || d.note.tokenAddress || 'unknown'
        console.log(`  SPENDABLE (unused): pos=${d.position} token=${tokenAddr.toString().slice(0,10)} value=${d.note.value?.toString()}`)
      } else {
        dropped++
        const tokenAddr = d.note.tokenData?.tokenAddress || d.note.tokenAddress || 'unknown'
        console.log(`  DROPPED (neither): pos=${d.position} token=${tokenAddr.toString().slice(0,10)} value=${d.note.value?.toString()}`)
      }
    }

    console.log(`\nNullifier results: spent=${spent}, unused/spendable=${spendable}, dropped=${dropped}`)
    console.log(`TRANSACT events: ${status.used.filter((n: any) => n.type === 'TRANSACT').length}`)
    console.log(`UNSHIELD events: ${status.used.filter((n: any) => n.type === 'UNSHIELD').length}`)

    // Step 4: Check change notes from TRANSACT events
    const transactEvents = status.used.filter((n: any) => n.type === 'TRANSACT')
    console.log(`\nTRANSACT events with outputCommitments:`)
    for (const t of transactEvents) {
      const ocs = t.outputCommitments?.length || 0
      if (ocs > 0) console.log(`  tx=${t.transactionHash?.slice(0,16)} outputs=${ocs}`)
    }
  }

  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
