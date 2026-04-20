import { describe, it, expect, beforeAll } from 'vitest'
import { ethers } from 'ethers'
import * as dotenv from 'dotenv'
dotenv.config()

import { deriveRailgunKeys, getRailgunAddress } from '../../src/privacy/lib/key-derivation'
import { fetchCommitmentsByEOA, fetchNullifierDataBatched } from '../../src/privacy/lib/api'
import { fetchSpendableUTXOsLightweight } from '../../src/privacy/lib/utxo-fetcher'
import { B402 } from '../../src/b402'

const INCOGNITO_MESSAGE = 'b402 Incognito EOA Derivation'
const CHAIN_ID = 8453
const BACKEND_API_URL = 'https://b402-backend-api-base-836626313375.europe-west1.run.app'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const hasKeys = !!process.env.WORKER_PRIVATE_KEY

describe.skipIf(!hasKeys)('Backend API Integration', () => {
  let signature: string
  let eoaAddress: string

  beforeAll(async () => {
    const wallet = new ethers.Wallet(process.env.WORKER_PRIVATE_KEY!)
    eoaAddress = wallet.address
    signature = await wallet.signMessage(INCOGNITO_MESSAGE)
  })

  it('key derivation pipeline produces valid 0zk address', async () => {
    const keys = await deriveRailgunKeys(signature)
    const address = getRailgunAddress(keys)

    expect(keys.mnemonic.split(' ')).toHaveLength(12)
    expect(keys.masterPublicKey).toBeGreaterThan(0n)
    expect(address).toMatch(/^0zk/)
  }, 30_000)

  it('fetchCommitmentsByEOA returns shields array', async () => {
    const result = await fetchCommitmentsByEOA(BACKEND_API_URL, eoaAddress, undefined, CHAIN_ID)

    expect(result).toHaveProperty('shields')
    expect(Array.isArray(result.shields)).toBe(true)
    // Each shield should have required fields
    for (const shield of result.shields) {
      expect(shield).toHaveProperty('commitmentHash')
      expect(shield).toHaveProperty('treeNumber')
      expect(shield).toHaveProperty('position')
      expect(shield).toHaveProperty('tokenAddress')
    }
  }, 30_000)

  it('fetchNullifierDataBatched returns unused/used arrays', async () => {
    // Use a dummy nullifier that shouldn't exist
    const dummyNullifier = '0x' + '0'.repeat(64)
    const result = await fetchNullifierDataBatched(BACKEND_API_URL, [dummyNullifier], CHAIN_ID)

    expect(result).toHaveProperty('unused')
    expect(result).toHaveProperty('used')
    expect(Array.isArray(result.unused)).toBe(true)
    expect(Array.isArray(result.used)).toBe(true)
  }, 30_000)

  it('fetchSpendableUTXOsLightweight returns lightweight UTXOs', async () => {
    const keys = await deriveRailgunKeys(signature)
    const utxos = await fetchSpendableUTXOsLightweight(
      eoaAddress,
      keys.viewingKeyPair.privateKey,
      keys.masterPublicKey,
      keys.nullifyingKey,
      USDC,
      CHAIN_ID,
    )

    expect(Array.isArray(utxos)).toBe(true)
    for (const utxo of utxos) {
      expect(utxo).toHaveProperty('commitment')
      expect(utxo).toHaveProperty('note')
      expect(utxo).toHaveProperty('nullifier')
      expect(utxo).toHaveProperty('position')
      expect(utxo).toHaveProperty('tree')
      expect(typeof utxo.note.value).toBe('bigint')
    }
  }, 60_000)

  it('b402.status() returns valid structure', async () => {
    const b402 = new B402({
      privateKey: process.env.WORKER_PRIVATE_KEY!,
      rpcUrl: process.env.BASE_RPC_URL,
    })

    const status = await b402.status()

    expect(status).toHaveProperty('ownerEOA')
    expect(status).toHaveProperty('smartWallet')
    expect(status).toHaveProperty('deployed')
    expect(status).toHaveProperty('chain')
    expect(status).toHaveProperty('balances')
    expect(status).toHaveProperty('shieldedBalances')
    expect(status).toHaveProperty('positions')

    expect(status.ownerEOA).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(status.smartWallet).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(typeof status.deployed).toBe('boolean')
    expect(Array.isArray(status.balances)).toBe(true)
    expect(Array.isArray(status.shieldedBalances)).toBe(true)
    expect(Array.isArray(status.positions)).toBe(true)
  }, 60_000)
})
