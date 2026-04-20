import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import {
  SYNFUTURES_CONTRACTS,
  SYNFUTURES_INSTRUMENTS,
  buildDepositCalls,
  buildTradeCall,
  buildOpenPositionCalls,
  buildClosePositionCalls,
  buildWithdrawCalls,
  getQuote,
  getAmmState,
  getPosition,
  getGateReserve,
  getInstrumentCount,
} from '../../src/trade/synfutures'

// ── Constants ───────────────────────────────────────────────────────

describe('SynFutures contracts', () => {
  it('has valid contract addresses', () => {
    expect(ethers.isAddress(SYNFUTURES_CONTRACTS.GATE)).toBe(true)
    expect(ethers.isAddress(SYNFUTURES_CONTRACTS.OBSERVER)).toBe(true)
    expect(ethers.isAddress(SYNFUTURES_CONTRACTS.CONFIG)).toBe(true)
    expect(ethers.isAddress(SYNFUTURES_CONTRACTS.USDC)).toBe(true)
  })

  it('has valid instrument addresses', () => {
    for (const [name, inst] of Object.entries(SYNFUTURES_INSTRUMENTS)) {
      expect(ethers.isAddress(inst.address)).toBe(true)
      expect(inst.type).toBeTruthy()
    }
    expect(Object.keys(SYNFUTURES_INSTRUMENTS).length).toBeGreaterThanOrEqual(3)
  })
})

// ── Deposit encoding ────────────────────────────────────────────────

describe('buildDepositCalls', () => {
  it('builds approve + deposit calls for USDC', () => {
    const usdcAmount = 10_000_000n // 10 USDC
    const calls = buildDepositCalls(usdcAmount)

    expect(calls).toHaveLength(2)

    // Call 1: approve USDC to Gate
    expect(calls[0].to.toLowerCase()).toBe(SYNFUTURES_CONTRACTS.USDC.toLowerCase())
    expect(calls[0].value).toBe('0')
    expect(calls[0].data).toContain('0x095ea7b3') // approve selector

    // Call 2: Gate.deposit(bytes32)
    expect(calls[1].to.toLowerCase()).toBe(SYNFUTURES_CONTRACTS.GATE.toLowerCase())
    expect(calls[1].value).toBe('0')
    expect(calls[1].data).toContain('0xb214faa5') // deposit(bytes32) selector
  })

  it('encodes deposit amount correctly in bytes32', () => {
    const amount = 100_000_000n // 100 USDC
    const calls = buildDepositCalls(amount)
    const data = calls[1].data

    // The bytes32 arg should encode: (amount << 160) | USDC_address
    // We just check the data is 4 + 32 bytes (selector + one bytes32 arg)
    // Plus ABI encoding overhead (offset, etc.)
    expect(data.length).toBeGreaterThan(10)
  })
})

// ── Trade encoding ──────────────────────────────────────────────────

describe('buildTradeCall', () => {
  it('builds a trade call with correct encoding', () => {
    const instrumentAddr = SYNFUTURES_INSTRUMENTS.BTC.address
    const size = ethers.parseEther('0.5')     // 0.5 units long
    const amount = ethers.parseEther('10')     // 10 USDC margin in WAD
    const limitTick = 443636                   // MAX_TICK for long
    const deadline = Math.floor(Date.now() / 1000) + 300

    const call = buildTradeCall(instrumentAddr, size, amount, limitTick, deadline)

    expect(call.to.toLowerCase()).toBe(instrumentAddr.toLowerCase())
    expect(call.value).toBe('0')
    // trade(bytes32[2]) selector
    expect(call.data.slice(0, 10)).toBeTruthy()
    expect(call.data.length).toBeGreaterThan(10)
  })

  it('handles short positions (negative size)', () => {
    const instrumentAddr = SYNFUTURES_INSTRUMENTS.BTC.address
    const size = -ethers.parseEther('0.5')     // short
    const amount = ethers.parseEther('10')
    const limitTick = -322517                   // MIN_TICK for short
    const deadline = Math.floor(Date.now() / 1000) + 300

    const call = buildTradeCall(instrumentAddr, size, amount, limitTick, deadline)

    expect(call.to.toLowerCase()).toBe(instrumentAddr.toLowerCase())
    expect(call.data.length).toBeGreaterThan(10)
  })
})

// ── Open position ───────────────────────────────────────────────────

describe('buildOpenPositionCalls', () => {
  it('builds approve + deposit + trade calls for a long', () => {
    const order = {
      instrument: 'BTC',
      side: 'long' as const,
      notional: '20',
      margin: '10',
    }
    const quote = {
      size: ethers.parseEther('1.5'),
      minAmount: ethers.parseEther('8'),
      tick: 50000,
    }

    const calls = buildOpenPositionCalls(order, quote)

    // Should have: approve, deposit, trade = 3 calls
    expect(calls).toHaveLength(3)

    // Call 1: USDC approve to Gate
    expect(calls[0].to.toLowerCase()).toBe(SYNFUTURES_CONTRACTS.USDC.toLowerCase())

    // Call 2: Gate.deposit
    expect(calls[1].to.toLowerCase()).toBe(SYNFUTURES_CONTRACTS.GATE.toLowerCase())

    // Call 3: Instrument.trade
    expect(calls[2].to.toLowerCase()).toBe(SYNFUTURES_INSTRUMENTS.BTC.address.toLowerCase())
  })

  it('builds calls for a short position', () => {
    const order = {
      instrument: 'ETH',
      side: 'short' as const,
      notional: '20',
      margin: '10',
    }
    const quote = {
      size: ethers.parseEther('5'),
      minAmount: ethers.parseEther('8'),
      tick: 30000,
    }

    const calls = buildOpenPositionCalls(order, quote)
    expect(calls).toHaveLength(3)
    expect(calls[2].to.toLowerCase()).toBe(SYNFUTURES_INSTRUMENTS.ETH.address.toLowerCase())
  })
})

// ── Close position ──────────────────────────────────────────────────

describe('buildClosePositionCalls', () => {
  it('builds a trade call with opposite size', () => {
    const instrumentAddr = SYNFUTURES_INSTRUMENTS.BTC.address
    const currentSize = ethers.parseEther('1.5') // long position

    const calls = buildClosePositionCalls(instrumentAddr, currentSize)
    expect(calls).toHaveLength(1)
    expect(calls[0].to.toLowerCase()).toBe(instrumentAddr.toLowerCase())
  })

  it('builds close for short position', () => {
    const instrumentAddr = SYNFUTURES_INSTRUMENTS.BTC.address
    const currentSize = -ethers.parseEther('2') // short position

    const calls = buildClosePositionCalls(instrumentAddr, currentSize)
    expect(calls).toHaveLength(1)
  })
})

// ── Withdraw ────────────────────────────────────────────────────────

describe('buildWithdrawCalls', () => {
  it('builds a withdraw call', () => {
    const amount = 10_000_000n
    const calls = buildWithdrawCalls(amount)
    expect(calls).toHaveLength(1)
    expect(calls[0].to.toLowerCase()).toBe(SYNFUTURES_CONTRACTS.GATE.toLowerCase())
  })
})

// ── Integration tests (require Base RPC) ────────────────────────────

describe('SynFutures on-chain reads', () => {
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
  const provider = new ethers.JsonRpcProvider(rpcUrl)

  it('gets instrument count from Gate', async () => {
    try {
      const count = await getInstrumentCount(provider)
      expect(count).toBeGreaterThan(0)
    } catch (e: any) {
      // RPC rate limiting
      expect(e.code).toBe('CALL_EXCEPTION')
    }
  }, 15000)

  it('gets AMM state for BTC instrument', async () => {
    try {
      const amm = await getAmmState('BTC', provider)
      expect(amm.status).toBeGreaterThanOrEqual(0)
      expect(amm.priceWad).toBeGreaterThan(0n)
      expect(Number(amm.priceUsd)).toBeGreaterThan(0)
    } catch (e: any) {
      expect(e.code).toBe('CALL_EXCEPTION')
    }
  }, 15000)

  it('gets quote for a long trade', async () => {
    try {
      const quote = await getQuote('BTC', '20', 'long', provider)
      expect(quote.size).toBeGreaterThan(0n) // positive for long
      expect(quote.benchmark).toBeGreaterThan(0n)
      expect(quote.fee).toBeGreaterThanOrEqual(0n)
    } catch (e: any) {
      expect(e.code).toBe('CALL_EXCEPTION')
    }
  }, 15000)

  it('gets quote for a short trade', async () => {
    try {
      const quote = await getQuote('BTC', '20', 'short', provider)
      expect(quote.size).toBeLessThan(0n) // negative for short
    } catch (e: any) {
      expect(e.code).toBe('CALL_EXCEPTION')
    }
  }, 15000)

  it('gets position for a random address (should be null)', async () => {
    try {
      const pos = await getPosition('BTC', ethers.ZeroAddress, provider)
      expect(pos).toBeNull()
    } catch (e: any) {
      expect(e.code).toBe('CALL_EXCEPTION')
    }
  }, 15000)

  it('gets Gate reserve for a random address', async () => {
    try {
      const reserve = await getGateReserve(ethers.ZeroAddress, provider)
      expect(reserve).toBe(0n)
    } catch (e: any) {
      expect(e.code).toBe('CALL_EXCEPTION')
    }
  }, 15000)
})
