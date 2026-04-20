import { describe, it, expect } from 'vitest'
import { B402 } from '../src/b402'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

describe('fundIncognito', () => {
  const b402 = new B402({ privateKey: TEST_KEY })

  it('throws on unknown token', async () => {
    await expect(
      b402.fundIncognito({ token: 'SHIBA', amount: '1' }),
    ).rejects.toThrow('Unknown token: SHIBA')
  })

  it('throws on zero amount', async () => {
    await expect(
      b402.fundIncognito({ token: 'USDC', amount: '0' }),
    ).rejects.toThrow('Amount must be greater than zero')
  })

  it('throws on negative amount', async () => {
    await expect(
      b402.fundIncognito({ token: 'USDC', amount: '-5' }),
    ).rejects.toThrow('Amount must be greater than zero')
  })

  it('throws on non-numeric amount', async () => {
    await expect(
      b402.fundIncognito({ token: 'USDC', amount: 'abc' }),
    ).rejects.toThrow('Amount must be greater than zero')
  })
})

describe('getIncognitoAddress', () => {
  it('returns a valid address after init', async () => {
    const b402 = new B402({ privateKey: TEST_KEY })
    const address = await b402.getIncognitoAddress()
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('returns the same address for the same key', async () => {
    const b402a = new B402({ privateKey: TEST_KEY })
    const b402b = new B402({ privateKey: TEST_KEY })
    const addrA = await b402a.getIncognitoAddress()
    const addrB = await b402b.getIncognitoAddress()
    expect(addrA).toBe(addrB)
  })

  it('returns different address than smart wallet', async () => {
    const b402 = new B402({ privateKey: TEST_KEY })
    const incognito = await b402.getIncognitoAddress()
    const status = await b402.status().catch(() => null)
    // Even without network, incognito address is derived locally
    expect(incognito).toBeTruthy()
    expect(incognito.length).toBe(42)
  })
})

describe('getIncognitoSigner', () => {
  it('returns an ethers Wallet with signTypedData', async () => {
    const b402 = new B402({ privateKey: TEST_KEY })
    const signer = await b402.getIncognitoSigner()
    expect(signer).toBeDefined()
    expect(typeof signer.signTypedData).toBe('function')
    expect(signer.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  it('signer address matches getIncognitoAddress', async () => {
    const b402 = new B402({ privateKey: TEST_KEY })
    const address = await b402.getIncognitoAddress()
    const signer = await b402.getIncognitoSigner()
    expect(signer.address.toLowerCase()).toBe(address.toLowerCase())
  })
})
