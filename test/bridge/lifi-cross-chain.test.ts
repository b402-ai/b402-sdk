import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { LiFiProvider } from '../../src/bridge/lifi-provider'

/**
 * Cross-chain routing regressions.
 *
 * Two layers:
 *  1. LiFiProvider must forward fromChain/toChain verbatim to /quote.
 *  2. B402.privateCrossChain must source from this.chainId, not a literal.
 */

const FAKE_QUOTE = {
  tool: 'across',
  toolDetails: { name: 'Across' },
  estimate: {
    fromAmount: '1000000',
    toAmount: '999500',
    toAmountMin: '994500',
    approvalAddress: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
    feeCosts: [],
    gasCosts: [{ amount: '100000', estimate: '100000' }],
    executionDuration: 30,
  },
  transactionRequest: {
    to: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
    data: '0xdeadbeef',
    value: '0x0',
    gasLimit: '500000',
  },
  action: {
    fromToken: { address: '0xUSDC' },
    toToken: { address: '0xUSDC_DEST' },
    fromChainId: 0,    // overwritten per-test below
    toChainId: 0,
  },
}

describe('LiFiProvider chain routing', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString()
      const params = new URL(url).searchParams
      const fromChainId = Number(params.get('fromChain'))
      const toChainId = Number(params.get('toChain'))
      const quote = {
        ...FAKE_QUOTE,
        action: { ...FAKE_QUOTE.action, fromChainId, toChainId },
      }
      return new Response(JSON.stringify(quote), { status: 200 })
    })
  })

  afterEach(() => fetchSpy.mockRestore())

  it('forwards Arb→Base bridge query verbatim', async () => {
    const lifi = new LiFiProvider()
    const q = await lifi.getBridgeQuote({
      fromChainId: 42161,
      toChainId: 8453,
      fromToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arb USDC
      toToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',   // Base USDC
      fromAmount: 1_000_000n,
      fromAddress: '0xRELAY',
      toAddress: '0xDEST',
      slippageBps: 50,
    })
    expect(q.fromChainId).toBe(42161)
    expect(q.toChainId).toBe(8453)

    const url = (fetchSpy.mock.calls[0][0] as string)
    expect(url).toContain('fromChain=42161')
    expect(url).toContain('toChain=8453')
    expect(url).toContain('integrator=b402')
  })

  it('forwards Base→Arb (existing Paul direction) verbatim', async () => {
    const lifi = new LiFiProvider()
    const q = await lifi.getBridgeQuote({
      fromChainId: 8453,
      toChainId: 42161,
      fromToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      toToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      fromAmount: 1_000_000n,
      fromAddress: '0xRELAY',
      toAddress: '0xDEST',
      slippageBps: 50,
    })
    expect(q.fromChainId).toBe(8453)
    expect(q.toChainId).toBe(42161)
  })

  it('supports cross-chain swap (different fromToken/toToken across chains)', async () => {
    // Arb USDC → Base WETH. The quote endpoint already handles this — proves
    // we do not need a separate "swap" endpoint on top of the bridge call.
    const lifi = new LiFiProvider()
    const q = await lifi.getBridgeQuote({
      fromChainId: 42161,
      toChainId: 8453,
      fromToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arb USDC
      toToken: '0x4200000000000000000000000000000000000006',   // Base WETH
      fromAmount: 1_000_000n,
      fromAddress: '0xRELAY',
      toAddress: '0xDEST',
      slippageBps: 50,
    })
    expect(q.fromChainId).toBe(42161)
    expect(q.toChainId).toBe(8453)
    const url = (fetchSpy.mock.calls[0][0] as string)
    expect(url).toContain('fromToken=0xaf88d065e77c8cC2239327C5EDb3A432268e5831')
    expect(url).toContain('toToken=0x4200000000000000000000000000000000000006')
  })

  it('attaches x-lifi-api-key header when provided', async () => {
    const lifi = new LiFiProvider('test-api-key-123')
    await lifi.getBridgeQuote({
      fromChainId: 42161,
      toChainId: 8453,
      fromToken: '0xa', toToken: '0xb',
      fromAmount: 1n,
      fromAddress: '0xRELAY', toAddress: '0xDEST',
      slippageBps: 50,
    })
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['x-lifi-api-key']).toBe('test-api-key-123')
  })
})

describe('B402.privateCrossChain source-chain regression', () => {
  // Static-source assertions. Exercising the full method needs Railgun engine
  // init + RPC; we test the bug class instead: the source chain config must
  // come from this.chainId, not a literal. This is the same shape we used
  // for vault-metrics-chain.
  const src = readFileSync(
    join(__dirname, '..', '..', 'src', 'b402.ts'),
    'utf8',
  )

  // Slice out only the privateCrossChain method body so adjacent code with
  // legitimate literal getChainConfig(8453) elsewhere doesn't false-positive.
  function privateCrossChainBody(): string {
    const start = src.indexOf('async privateCrossChain(')
    expect(start).toBeGreaterThan(0)
    // Naive but sufficient: read until the next `async ` method boundary.
    const tail = src.slice(start)
    const end = tail.indexOf('\n  async ', 1)
    return tail.slice(0, end > 0 ? end : tail.length)
  }

  it('does not call getChainConfig with a literal chainId for the source chain', () => {
    expect(privateCrossChainBody()).not.toMatch(/getChainConfig\(\s*\d+\s*\)/)
  })

  it('threads this.chainId into the source chain config', () => {
    expect(privateCrossChainBody()).toMatch(/getChainConfig\(\s*this\.chainId\s*\)/)
  })
})
