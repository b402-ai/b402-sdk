import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { LiFiProvider, type LiFiStatus } from '../../src/bridge/lifi-provider'

describe('LiFiProvider.getStatus', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch')
  })
  afterEach(() => fetchSpy.mockRestore())

  it('hits /v1/status with the txHash and forwards integrator/api-key', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      status: 'DONE',
      receiving: { txHash: '0xdest123' },
    }), { status: 200 }))

    const lifi = new LiFiProvider('test-key')
    const out = await lifi.getStatus('0xsrc456')

    const url = fetchSpy.mock.calls[0][0] as string
    expect(url).toContain('/v1/status')
    expect(url).toContain('txHash=0xsrc456')
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['x-lifi-api-key']).toBe('test-key')
    expect(out.status).toBe('done')
    expect(out.destTxHash).toBe('0xdest123')
  })

  it('maps LiFi status string variants to our enum', async () => {
    const cases: Array<[string, LiFiStatus['status']]> = [
      ['NOT_FOUND', 'pending'],
      ['INVALID', 'failed'],
      ['PENDING', 'pending'],
      ['DONE', 'done'],
      ['FAILED', 'failed'],
    ]
    for (const [input, expected] of cases) {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ status: input }), { status: 200 }))
      const lifi = new LiFiProvider()
      const out = await lifi.getStatus('0xabc')
      expect(out.status, `for input ${input}`).toBe(expected)
    }
  })

  it('surfaces substatus when present', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({
      status: 'PENDING',
      substatus: 'WAIT_DESTINATION_TRANSACTION',
    }), { status: 200 }))
    const lifi = new LiFiProvider()
    const out = await lifi.getStatus('0xabc')
    expect(out.substatus).toBe('WAIT_DESTINATION_TRANSACTION')
  })
})
