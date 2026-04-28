import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getAggregatorQuote } from '../../src/swap/dex-aggregator'

const QUOTE_OK = {
  outAmounts: ['1000000'],
  pathId: 'fake-path',
  percentDiff: 0,
  gasEstimate: 100000,
}

describe('dex-aggregator chainId routing', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(QUOTE_OK), { status: 200 }),
    )
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('forwards chainId=8453 to Odos when called for Base', async () => {
    await getAggregatorQuote(
      '0xUSDC_BASE',
      '0xWETH_BASE',
      1_000_000n,
      '0xRECEIVER',
      8453,
    )
    expect(fetchSpy).toHaveBeenCalledOnce()
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.chainId).toBe(8453)
  })

  it('forwards chainId=42161 to Odos when called for Arbitrum', async () => {
    await getAggregatorQuote(
      '0xUSDC_ARB',
      '0xWETH_ARB',
      1_000_000n,
      '0xRECEIVER',
      42161,
    )
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.chainId).toBe(42161)
  })

  it('chainId is a required parameter (no silent Base default)', () => {
    // Function.length counts required leading args (those without defaults).
    // We expect (tokenIn, tokenOut, amountIn, userAddr, chainId) to be 5.
    expect(getAggregatorQuote.length).toBeGreaterThanOrEqual(5)
  })
})
