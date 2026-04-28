import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import {
  AAVE_V3_BY_CHAIN,
  resolveAaveMarket,
  buildAaveSupplyCalls,
  buildAaveWithdrawCalls,
  AAVE_POOL_ABI,
} from '../../src/lend/aave-v3'

const RELAY_ADAPT = '0x0000000000000000000000000000000000000001'

describe('Aave V3 registry', () => {
  it('has Base + Arb pools registered', () => {
    expect(AAVE_V3_BY_CHAIN[8453]).toBeDefined()
    expect(AAVE_V3_BY_CHAIN[42161]).toBeDefined()
  })

  it('resolves "usdc" market on Arb to native USDC + correct aToken', () => {
    const m = resolveAaveMarket('usdc', 42161)
    expect(m.underlying.toLowerCase()).toBe('0xaf88d065e77c8cc2239327c5edb3a432268e5831')
    expect(m.aToken.toLowerCase()).toBe('0x724dc807b04555b71ed48a6896b6f41593b8c637')
    expect(m.pool.toLowerCase()).toBe('0x794a61358d6845594f94dc1db02a252b5b4814ad')
  })

  it('resolves "usdc" market on Base to bridged USDC + correct aToken', () => {
    const m = resolveAaveMarket('usdc', 8453)
    expect(m.pool.toLowerCase()).toBe('0xa238dd80c259a72e81d7e4664a9801593f98d1c5')
    expect(m.aToken.toLowerCase()).toBe('0x4e65fe4dba92790696d040ac24aa414708f5c0ab')
  })

  it('throws for unknown market', () => {
    expect(() => resolveAaveMarket('weird-token', 42161)).toThrow(/Unknown.*market/i)
  })

  it('throws for unsupported chain', () => {
    expect(() => resolveAaveMarket('usdc', 999)).toThrow(/Aave V3.*not configured|chainId/i)
  })
})

describe('Aave V3 supply call construction', () => {
  it('builds [approve(Pool, amount), Pool.supply(asset, amount, recipient, 0)]', () => {
    const market = resolveAaveMarket('usdc', 42161)
    const amount = 1_000_000n // 1 USDC

    const calls = buildAaveSupplyCalls({
      market,
      amount,
      recipient: RELAY_ADAPT,
    })

    expect(calls).toHaveLength(2)

    // approve
    expect(calls[0].to.toLowerCase()).toBe(market.underlying.toLowerCase())
    expect(calls[0].value).toBe('0')
    const erc20 = new ethers.Interface([
      'function approve(address spender, uint256 amount) external returns (bool)',
    ])
    const decoded = erc20.decodeFunctionData('approve', calls[0].data)
    expect(decoded[0].toLowerCase()).toBe(market.pool.toLowerCase())
    expect(decoded[1]).toBe(amount)

    // Pool.supply
    expect(calls[1].to.toLowerCase()).toBe(market.pool.toLowerCase())
    expect(calls[1].value).toBe('0')
    const pool = new ethers.Interface(AAVE_POOL_ABI)
    const supplyDecoded = pool.decodeFunctionData('supply', calls[1].data)
    expect(supplyDecoded[0].toLowerCase()).toBe(market.underlying.toLowerCase())
    expect(supplyDecoded[1]).toBe(amount)
    expect(supplyDecoded[2].toLowerCase()).toBe(RELAY_ADAPT.toLowerCase())
    expect(supplyDecoded[3]).toBe(0n) // referralCode
  })
})

describe('Aave V3 withdraw call construction', () => {
  it('builds [Pool.withdraw(asset, MAX_UINT256, recipient)] (no approve — Pool burns from msg.sender)', () => {
    const market = resolveAaveMarket('usdc', 42161)

    const calls = buildAaveWithdrawCalls({
      market,
      recipient: RELAY_ADAPT,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].to.toLowerCase()).toBe(market.pool.toLowerCase())
    expect(calls[0].value).toBe('0')

    const pool = new ethers.Interface(AAVE_POOL_ABI)
    const decoded = pool.decodeFunctionData('withdraw', calls[0].data)
    expect(decoded[0].toLowerCase()).toBe(market.underlying.toLowerCase())
    // amount=type(uint256).max — withdraw all aToken balance held by msg.sender
    expect(decoded[1]).toBe((1n << 256n) - 1n)
    expect(decoded[2].toLowerCase()).toBe(RELAY_ADAPT.toLowerCase())
  })
})
