import { describe, it, expect, vi } from 'vitest'
import {
  MORPHO_VAULTS,
  MORPHO_VAULTS_BY_CHAIN,
  getMorphoVaults,
  resolveVault,
} from '../../src/lend/morpho-vaults'
import { B402 } from '../../src/b402'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

describe('MORPHO_VAULTS chain-aware registry', () => {
  it('exposes Base vaults under chainId 8453', () => {
    const base = MORPHO_VAULTS_BY_CHAIN[8453]
    expect(Object.keys(base)).toEqual(
      expect.arrayContaining(['steakhouse', 'moonwell', 'gauntlet', 'steakhouse-hy']),
    )
  })

  it('exposes Arbitrum vaults under chainId 42161', () => {
    const arb = MORPHO_VAULTS_BY_CHAIN[42161]
    expect(Object.keys(arb)).toEqual(
      expect.arrayContaining(['steakhouse-hy', 'steakhouse', 'gauntlet', 'gauntlet-prime']),
    )
    // Moonwell is Base/Optimism only
    expect(arb).not.toHaveProperty('moonwell')
  })

  it('Base and Arb steakhouse vaults have different addresses', () => {
    const baseSteak = MORPHO_VAULTS_BY_CHAIN[8453]['steakhouse']
    const arbSteak = MORPHO_VAULTS_BY_CHAIN[42161]['steakhouse']
    expect(baseSteak.address.toLowerCase()).not.toBe(arbSteak.address.toLowerCase())
  })

  it('legacy MORPHO_VAULTS export still points at Base for back-compat', () => {
    expect(MORPHO_VAULTS).toBe(MORPHO_VAULTS_BY_CHAIN[8453])
  })

  it('getMorphoVaults returns the chain map', () => {
    expect(getMorphoVaults(8453)).toBe(MORPHO_VAULTS_BY_CHAIN[8453])
    expect(getMorphoVaults(42161)).toBe(MORPHO_VAULTS_BY_CHAIN[42161])
  })

  it('getMorphoVaults returns empty object for unsupported chain', () => {
    expect(getMorphoVaults(56)).toEqual({}) // BSC has no Morpho
  })
})

describe('resolveVault', () => {
  it('resolves by name on Base by default', () => {
    const v = resolveVault('steakhouse')
    expect(v.address).toBe(MORPHO_VAULTS_BY_CHAIN[8453]['steakhouse'].address)
  })

  it('resolves by name on Arbitrum when chainId is 42161', () => {
    const v = resolveVault('steakhouse-hy', 42161)
    expect(v.address).toBe(MORPHO_VAULTS_BY_CHAIN[42161]['steakhouse-hy'].address)
    expect(v.curator).toBe('Steakhouse Financial')
  })

  it('resolves by address on the matching chain', () => {
    const arbAddr = MORPHO_VAULTS_BY_CHAIN[42161]['gauntlet'].address
    const v = resolveVault(arbAddr, 42161)
    expect(v.name).toBe('Gauntlet USDC Core')
  })

  it('throws for unknown vault on the chain', () => {
    expect(() => resolveVault('moonwell', 42161)).toThrow(/Unknown vault/i)
  })

  it('throws for unsupported chain', () => {
    expect(() => resolveVault('steakhouse', 56)).toThrow(/No Morpho vaults/i)
  })

  it('Arb gauntlet-prime is its own vault, distinct from gauntlet', () => {
    const core = resolveVault('gauntlet', 42161)
    const prime = resolveVault('gauntlet-prime', 42161)
    expect(core.address).not.toBe(prime.address)
  })
})

describe('B402.privateLend on Arbitrum (chainId 42161)', () => {
  it('does NOT throw the Base-only guard', async () => {
    const b402 = new B402({ privateKey: TEST_KEY, chainId: 42161 })
    // Spy on the internal pipeline to short-circuit before network calls
    const spy = vi
      .spyOn(b402 as any, 'executeCrossContractCall')
      .mockResolvedValue({ txHash: '0xtest' })
    // Stub init so we don't make real RPC calls during construction of address state
    vi.spyOn(b402 as any, 'init').mockResolvedValue(undefined)

    const result = await b402.privateLend({
      token: 'USDC',
      amount: '1',
      vault: 'steakhouse-hy',
    })

    expect(result.txHash).toBe('0xtest')
    expect(result.vault).toBe('Steakhouse High Yield USDC')
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })

  it('builds vault deposit calls targeting the Arb vault address', async () => {
    const b402 = new B402({ privateKey: TEST_KEY, chainId: 42161 })
    const spy = vi
      .spyOn(b402 as any, 'executeCrossContractCall')
      .mockResolvedValue({ txHash: '0xtest' })
    vi.spyOn(b402 as any, 'init').mockResolvedValue(undefined)

    await b402.privateLend({ token: 'USDC', amount: '1', vault: 'steakhouse-hy' })

    const call = spy.mock.calls[0][0] as any
    const arbVaultAddr = MORPHO_VAULTS_BY_CHAIN[42161]['steakhouse-hy'].address
    // The 2nd userCall should target the vault contract for deposit()
    expect(call.userCalls[1].to.toLowerCase()).toBe(arbVaultAddr.toLowerCase())
    // Output shield should target the same vault address (share token)
    expect(call.shieldTokens[0].tokenAddress.toLowerCase()).toBe(arbVaultAddr.toLowerCase())
    spy.mockRestore()
  })

  it('rejects with chain-aware vault error for unknown vault on Arb', async () => {
    const b402 = new B402({ privateKey: TEST_KEY, chainId: 42161 })
    await expect(
      b402.privateLend({ token: 'USDC', amount: '1', vault: 'moonwell' }),
    ).rejects.toThrow(/Unknown vault.*42161/i)
  })
})
