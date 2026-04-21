import { describe, it, expect, vi, beforeEach } from 'vitest'
import { B402 } from '../src/b402'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

describe('B402.execute (unified dispatcher)', () => {
  let b402: B402

  beforeEach(() => {
    b402 = new B402({ privateKey: TEST_KEY })
  })

  it('routes action: "privateSwap" to privateSwap with forwarded params', async () => {
    const spy = vi.spyOn(b402, 'privateSwap').mockResolvedValue({
      txHash: '0xswap',
      amountIn: '100',
      amountOut: '0.03',
      tokenIn: 'USDC',
      tokenOut: 'WETH',
    })

    const result = await b402.execute({
      action: 'privateSwap',
      from: 'USDC',
      to: 'WETH',
      amount: '100',
    })

    expect(spy).toHaveBeenCalledWith({ from: 'USDC', to: 'WETH', amount: '100' })
    expect(result).toEqual({
      txHash: '0xswap',
      amountIn: '100',
      amountOut: '0.03',
      tokenIn: 'USDC',
      tokenOut: 'WETH',
    })
  })

  it('routes action: "privateLend" to privateLend with forwarded params', async () => {
    const spy = vi.spyOn(b402, 'privateLend').mockResolvedValue({
      txHash: '0xlend',
      amount: '100',
      vault: 'steakhouse',
    })

    const result = await b402.execute({
      action: 'privateLend',
      token: 'USDC',
      amount: '100',
      vault: 'steakhouse',
    })

    expect(spy).toHaveBeenCalledWith({ token: 'USDC', amount: '100', vault: 'steakhouse' })
    expect(result.vault).toBe('steakhouse')
  })

  it('routes action: "privateRedeem" to privateRedeem with forwarded params', async () => {
    const spy = vi.spyOn(b402, 'privateRedeem').mockResolvedValue({
      txHash: '0xredeem',
      assetsReceived: '100.5',
      vault: 'steakhouse',
    })

    const result = await b402.execute({
      action: 'privateRedeem',
      vault: 'steakhouse',
    })

    expect(spy).toHaveBeenCalledWith({ vault: 'steakhouse' })
    expect(result.assetsReceived).toBe('100.5')
  })

  it('routes action: "privateCrossChain" to privateCrossChain with forwarded params', async () => {
    const spy = vi.spyOn(b402, 'privateCrossChain').mockResolvedValue({
      txHash: '0xbridge',
      tool: 'across',
      fromChain: 'base',
      toChain: 'arbitrum',
      fromToken: 'USDC',
      toToken: 'USDC',
      amountIn: '50',
      expectedAmountOut: '49.8',
      minAmountOut: '49.5',
      destinationAddress: '0x5A7D750169fB30A28D48eE09a9A5E02E81fd2c53',
      estimatedDurationSec: 120,
    })

    const result = await b402.execute({
      action: 'privateCrossChain',
      toChain: 'arbitrum',
      fromToken: 'USDC',
      toToken: 'USDC',
      amount: '50',
      destinationAddress: '0x5A7D750169fB30A28D48eE09a9A5E02E81fd2c53',
    })

    expect(spy).toHaveBeenCalledWith({
      toChain: 'arbitrum',
      fromToken: 'USDC',
      toToken: 'USDC',
      amount: '50',
      destinationAddress: '0x5A7D750169fB30A28D48eE09a9A5E02E81fd2c53',
    })
    expect(result.tool).toBe('across')
  })

  it('routes action: "shield" to shield with forwarded params', async () => {
    const spy = vi.spyOn(b402, 'shield').mockResolvedValue({
      txHash: '0xshield',
      indexed: true,
    })

    const result = await b402.execute({
      action: 'shield',
      token: 'USDC',
      amount: '10',
    })

    expect(spy).toHaveBeenCalledWith({ token: 'USDC', amount: '10' })
    expect(result.indexed).toBe(true)
  })

  it('routes action: "unshield" to unshield with forwarded params', async () => {
    const spy = vi.spyOn(b402, 'unshield').mockResolvedValue({
      txHash: '0xunshield',
      proofTimeSeconds: 12,
    })

    const result = await b402.execute({
      action: 'unshield',
      token: 'USDC',
      amount: '5',
    })

    expect(spy).toHaveBeenCalledWith({ token: 'USDC', amount: '5' })
    expect(result.proofTimeSeconds).toBe(12)
  })

  it('throws on unknown action at runtime', async () => {
    await expect(
      // @ts-expect-error deliberately invalid action for runtime guard
      b402.execute({ action: 'teleport', amount: '1' }),
    ).rejects.toThrow(/unknown action/i)
  })
})
