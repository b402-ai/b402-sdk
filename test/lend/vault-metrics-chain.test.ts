import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Vault-metrics chain regression: src/b402.ts:1805 used to call
 * `fetchAllVaultMetrics(8453)` with a hardcoded chainId while the rest of the
 * SDK uses `this.chainId`. The two callers must stay consistent, otherwise
 * lifting requireBase('rebalance') would silently quote Base APYs on Arb.
 *
 * This is a static-source assertion (the rebalance path is requireBase-gated
 * so we can't easily exercise it for chainId=42161 without lifting the gate,
 * which is out of scope for this spike).
 */
describe('fetchAllVaultMetrics callers chain-scope', () => {
  const src = readFileSync(
    join(__dirname, '..', '..', 'src', 'b402.ts'),
    'utf8',
  )

  it('never calls fetchAllVaultMetrics with a literal chainId', () => {
    // Forbid any literal numeric arg (8453, 42161, etc.). All callers must
    // thread `this.chainId` through.
    expect(src).not.toMatch(/fetchAllVaultMetrics\(\s*\d+/)
  })

  it('all fetchAllVaultMetrics call sites use this.chainId', () => {
    const calls = src.match(/fetchAllVaultMetrics\(([^)]*)\)/g) || []
    expect(calls.length).toBeGreaterThanOrEqual(1)
    for (const call of calls) {
      expect(call).toMatch(/this\.chainId/)
    }
  })
})
