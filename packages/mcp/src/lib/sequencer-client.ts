const SEQUENCER_URL = process.env.SEQUENCER_URL || 'http://localhost:3200'

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${SEQUENCER_URL}${path}`
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json() as any
  if (!res.ok) {
    throw new Error(data.error || data.message || `Sequencer returned ${res.status}`)
  }
  return data as T
}

export const sequencer = {
  getBalance: (agentId: string) =>
    request<{ balance: number; nonce: number; pendingDebits: number; effectiveBalance: number }>(
      'GET', `/v1/credit/balance/${agentId}`
    ),

  topup: (agentId: string, amountMicros: string) =>
    request<{ ok: boolean; balance: number }>(
      'POST', '/v1/credit/topup', { agentId, amountMicros: parseInt(amountMicros) }
    ),

  openSession: (agentId: string, spendingCapMicros: string, ttlSeconds = 3600, merchantId?: string) =>
    request<{ sessionId: string; spendingCapMicros: number; remainingMicros: number; status: string; expiresAt: string }>(
      'POST', '/v1/session/open', { agentId, spendingCapMicros: parseInt(spendingCapMicros), ttlSeconds, merchantId }
    ),

  sessionPay: (sessionId: string, merchantId: string, amountMicros: string) =>
    request<{ authId: string; remainingMicros: number; blsSig: string }>(
      'POST', '/v1/session/pay', { sessionId, merchantId, amountMicros: parseInt(amountMicros) }
    ),

  closeSession: (sessionId: string) =>
    request<{ refundedMicros: number; spentMicros: number }>(
      'POST', '/v1/session/close', { sessionId }
    ),

  settle: () =>
    request<{ epochId: number; count: number; totalMicros: number; payouts?: any[] }>(
      'POST', '/v1/credit/settle/onchain'
    ),

  verifyEpoch: (epochId: number) =>
    request<{ valid: boolean; count: number; root: string; aggregatedSig: string; publicKey: string }>(
      'GET', `/v1/epochs/${epochId}/verify`
    ),

  getSummary: () =>
    request<any>('GET', '/v1/summary'),
}
