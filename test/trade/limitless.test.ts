import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import {
  LIMITLESS_CONTRACTS,
  fetchMarkets,
  fetchMarket,
  buildApprovalCalls,
  buildCtfApprovalCalls,
  buildRedeemCalls,
  buildSignedOrder,
  getNonce,
  getPositions,
  isResolved,
} from '../../src/trade/limitless'

// ── Constants ───────────────────────────────────────────────────────

describe('Limitless contracts', () => {
  it('has valid contract addresses', () => {
    expect(ethers.isAddress(LIMITLESS_CONTRACTS.CTF_EXCHANGE)).toBe(true)
    expect(ethers.isAddress(LIMITLESS_CONTRACTS.CONDITIONAL_TOKENS)).toBe(true)
    expect(ethers.isAddress(LIMITLESS_CONTRACTS.NEGRISK_EXCHANGE)).toBe(true)
    expect(ethers.isAddress(LIMITLESS_CONTRACTS.USDC)).toBe(true)
  })
})

// ── API Functions ───────────────────────────────────────────────────

describe('Limitless API', () => {
  it('fetches active market slugs', async () => {
    const markets = await fetchMarkets(5)
    expect(markets.length).toBeGreaterThan(0)
    expect(markets[0]).toHaveProperty('slug')
  }, 10000)

  it('fetches full market details', async () => {
    const slugs = await fetchMarkets(1)
    const market = await fetchMarket(slugs[0].slug)

    expect(market.slug).toBeTruthy()
    expect(market.title).toBeTruthy()
    expect(market.conditionId).toMatch(/^0x/)
    expect(market.tokens.yes).toBeTruthy()
    expect(market.tokens.no).toBeTruthy()
    expect(market.prices).toHaveLength(2)
    expect(market.exchange).toMatch(/^0x/)
    expect(market.collateral.symbol).toBe('USDC')
  }, 10000)

  it('returns correct price format', async () => {
    const slugs = await fetchMarkets(1)
    const market = await fetchMarket(slugs[0].slug)

    // Prices should be between 0 and 1
    expect(market.prices[0]).toBeGreaterThanOrEqual(0)
    expect(market.prices[0]).toBeLessThanOrEqual(1)
    expect(market.prices[1]).toBeGreaterThanOrEqual(0)
    expect(market.prices[1]).toBeLessThanOrEqual(1)
  }, 10000)
})

// ── Call Builders ───────────────────────────────────────────────────

describe('buildApprovalCalls', () => {
  it('builds USDC approval to CTF Exchange', () => {
    const calls = buildApprovalCalls(10_000_000n) // 10 USDC
    expect(calls).toHaveLength(1)
    expect(calls[0].to.toLowerCase()).toBe(LIMITLESS_CONTRACTS.USDC.toLowerCase())
    expect(calls[0].data).toContain('0x095ea7b3') // approve selector
  })
})

describe('buildCtfApprovalCalls', () => {
  it('builds setApprovalForAll for conditional tokens', () => {
    const calls = buildCtfApprovalCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].to.toLowerCase()).toBe(LIMITLESS_CONTRACTS.CONDITIONAL_TOKENS.toLowerCase())
  })
})

describe('buildRedeemCalls', () => {
  it('builds redeem call with conditionId', () => {
    const conditionId = '0xbd9e7acb1ea4d6f0de3a61c3fd90d5523931954d30631c663027ca9ce0fdea9b'
    const calls = buildRedeemCalls(conditionId)
    expect(calls).toHaveLength(1)
    expect(calls[0].to.toLowerCase()).toBe(LIMITLESS_CONTRACTS.CONDITIONAL_TOKENS.toLowerCase())
  })
})

// ── EIP-712 Order Signing ───────────────────────────────────────────

describe('buildSignedOrder', () => {
  it('builds and signs a BUY YES order', async () => {
    const wallet = ethers.Wallet.createRandom()
    const market = {
      slug: 'test-market',
      title: 'Test Market',
      conditionId: '0x' + '1'.repeat(64),
      status: 'FUNDED',
      prices: [0.65, 0.35] as [number, number],
      tokens: { yes: '12345', no: '67890' },
      volume: '100',
      exchange: LIMITLESS_CONTRACTS.CTF_EXCHANGE,
      adapter: null,
      expirationDate: '2026-04-01',
      marketType: 'single',
      collateral: { address: LIMITLESS_CONTRACTS.USDC, decimals: 6, symbol: 'USDC' },
    }

    const { signedOrder, price, shares } = await buildSignedOrder(
      wallet,
      market,
      { market: 'test-market', outcome: 'yes', amount: '10' },
      0n,
    )

    expect(signedOrder.maker).toBe(ethers.getAddress(wallet.address))
    expect(signedOrder.signer).toBe(signedOrder.maker)
    expect(signedOrder.tokenId).toBe('12345') // YES token
    expect(signedOrder.side).toBe(0) // BUY
    expect(signedOrder.signatureType).toBe(0) // EOA
    expect(signedOrder.signature).toMatch(/^0x/)
    expect(signedOrder.signature.length).toBe(132) // 65 bytes
    expect(price).toBeCloseTo(0.65, 1)
    expect(parseFloat(shares)).toBeGreaterThan(0)
  })

  it('builds a BUY NO order with correct tokenId', async () => {
    const wallet = ethers.Wallet.createRandom()
    const market = {
      slug: 'test-market',
      title: 'Test',
      conditionId: '0x' + '1'.repeat(64),
      status: 'FUNDED',
      prices: [0.65, 0.35] as [number, number],
      tokens: { yes: '12345', no: '67890' },
      volume: '100',
      exchange: LIMITLESS_CONTRACTS.CTF_EXCHANGE,
      adapter: null,
      expirationDate: '2026-04-01',
      marketType: 'single',
      collateral: { address: LIMITLESS_CONTRACTS.USDC, decimals: 6, symbol: 'USDC' },
    }

    const { signedOrder } = await buildSignedOrder(
      wallet, market,
      { market: 'test-market', outcome: 'no', amount: '5' },
      0n,
    )

    expect(signedOrder.tokenId).toBe('67890') // NO token
  })

  it('uses custom price for GTC orders', async () => {
    const wallet = ethers.Wallet.createRandom()
    const market = {
      slug: 'test',
      title: 'Test',
      conditionId: '0x' + '1'.repeat(64),
      status: 'FUNDED',
      prices: [0.65, 0.35] as [number, number],
      tokens: { yes: '111', no: '222' },
      volume: '0',
      exchange: LIMITLESS_CONTRACTS.CTF_EXCHANGE,
      adapter: null,
      expirationDate: '2026-04-01',
      marketType: 'single',
      collateral: { address: LIMITLESS_CONTRACTS.USDC, decimals: 6, symbol: 'USDC' },
    }

    const { price } = await buildSignedOrder(
      wallet, market,
      { market: 'test', outcome: 'yes', amount: '10', price: 0.50 },
      0n,
    )

    expect(price).toBe(0.50)
  })
})

// ── On-Chain Reads ──────────────────────────────────────────────────

describe('Limitless on-chain reads', () => {
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
  const provider = new ethers.JsonRpcProvider(rpcUrl)

  it('reads nonce from exchange', async () => {
    try {
      const nonce = await getNonce(ethers.ZeroAddress, provider)
      expect(nonce).toBe(0n)
    } catch (e: any) {
      expect(e.code).toBe('CALL_EXCEPTION')
    }
  }, 10000)

  it('checks if a market is resolved', async () => {
    try {
      // Use a known conditionId
      const resolved = await isResolved(
        '0xbd9e7acb1ea4d6f0de3a61c3fd90d5523931954d30631c663027ca9ce0fdea9b',
        provider,
      )
      expect(typeof resolved).toBe('boolean')
    } catch (e: any) {
      expect(e.code).toBe('CALL_EXCEPTION')
    }
  }, 10000)

  it('reads positions for zero address (should be 0)', async () => {
    try {
      const slugs = await fetchMarkets(1)
      const market = await fetchMarket(slugs[0].slug)
      const pos = await getPositions(ethers.ZeroAddress, market, provider)
      expect(pos.yes).toBe('0.00')
      expect(pos.no).toBe('0.00')
    } catch (e: any) {
      // Rate limiting or CALL_EXCEPTION
      expect(['CALL_EXCEPTION', 'SERVER_ERROR']).toContain(e.code)
    }
  }, 15000)
})
