import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Wallet-store overwrite safety. The MCP must NEVER silently regenerate
 * a user's wallet.json. Customer impact: lost funds at the old address.
 *
 * Tests use a per-test tmp HOME so wallet-store paths land in a sandbox.
 */

// Anvil/Hardhat well-known test accounts (mnemonic: "test test test test test
// test test test test test test junk"). Public fixtures, not secrets.
const KEY_A = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' // anvil #1
const KEY_B = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' // anvil #2

const ADDR_A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // anvil #1

function makeStubWallet(key: string, address = ADDR_A) {
  return {
    privateKey: key,
    address,
    incognitoEOA: address,   // not asserted on
    smartWallet: address,    // not asserted on
    createdAt: new Date().toISOString(),
  }
}

describe('wallet-store overwrite safety', () => {
  let tmpHome: string
  let prevHome: string | undefined
  let prevForce: string | undefined

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'b402-walletstore-'))
    prevHome = process.env.HOME
    prevForce = process.env.B402_FORCE_WALLET_RESET
    process.env.HOME = tmpHome
    delete process.env.B402_FORCE_WALLET_RESET
    delete process.env.WORKER_PRIVATE_KEY
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevForce === undefined) delete process.env.B402_FORCE_WALLET_RESET
    else process.env.B402_FORCE_WALLET_RESET = prevForce
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  })

  function walletDir() { return join(tmpHome, '.b402') }
  function walletFile() { return join(walletDir(), 'wallet.json') }

  function preWrite(key: string) {
    mkdirSync(walletDir(), { recursive: true })
    writeFileSync(walletFile(), JSON.stringify(makeStubWallet(key), null, 2))
  }

  function listBackups(): string[] {
    if (!existsSync(walletDir())) return []
    return readdirSync(walletDir()).filter((f) => f.startsWith('wallet.json.bak.'))
  }

  it('readWallet returns null when nothing exists', async () => {
    const { readWallet } = await import('../../packages/mcp/src/lib/wallet-store')
    expect(readWallet()).toBeNull()
  })

  it('readWallet returns existing wallet content', async () => {
    preWrite(KEY_A)
    const { readWallet } = await import('../../packages/mcp/src/lib/wallet-store')
    expect(readWallet()?.privateKey).toBe(KEY_A)
  })

  it('importWallet is idempotent when key matches existing', async () => {
    preWrite(KEY_A)
    const before = readFileSync(walletFile(), 'utf8')
    const { importWallet } = await import('../../packages/mcp/src/lib/wallet-store')
    const out = await importWallet(KEY_A)
    expect(out.privateKey).toBe(KEY_A)
    expect(readFileSync(walletFile(), 'utf8')).toBe(before)
    expect(listBackups()).toEqual([])
  })

  it('importWallet refuses when key differs and no force flag', async () => {
    preWrite(KEY_A)
    const before = readFileSync(walletFile(), 'utf8')
    const { importWallet } = await import('../../packages/mcp/src/lib/wallet-store')
    await expect(importWallet(KEY_B)).rejects.toThrow(/B402_FORCE_WALLET_RESET/)
    // Original file untouched, no backup created.
    expect(readFileSync(walletFile(), 'utf8')).toBe(before)
    expect(listBackups()).toEqual([])
  })

  it('createWallet refuses when wallet.json already exists', async () => {
    preWrite(KEY_A)
    const before = readFileSync(walletFile(), 'utf8')
    const { createWallet } = await import('../../packages/mcp/src/lib/wallet-store')
    await expect(createWallet()).rejects.toThrow(/already exists|B402_FORCE_WALLET_RESET/)
    expect(readFileSync(walletFile(), 'utf8')).toBe(before)
    expect(listBackups()).toEqual([])
  })

  it('refuses overwrite when wallet.json is malformed', async () => {
    mkdirSync(walletDir(), { recursive: true })
    writeFileSync(walletFile(), 'not valid json {{{')
    const before = readFileSync(walletFile(), 'utf8')
    const { importWallet } = await import('../../packages/mcp/src/lib/wallet-store')
    await expect(importWallet(KEY_A)).rejects.toThrow(/B402_FORCE_WALLET_RESET|unreadable|malformed/i)
    expect(readFileSync(walletFile(), 'utf8')).toBe(before)
  })

  // The two tests below exercise the actual write path which calls into
  // ethers + RPC to compute the smart-wallet CREATE2 address. We isolate them
  // behind a guard so unit-test runs without network still pass; the full
  // suite runs with WALLET_STORE_LIVE_RPC=1 to verify backup + write.
  const liveRpc = process.env.WALLET_STORE_LIVE_RPC === '1'
  const itLive = liveRpc ? it : it.skip

  itLive('importWallet writes timestamped backup when forced and key differs', async () => {
    preWrite(KEY_A)
    const original = readFileSync(walletFile(), 'utf8')
    process.env.B402_FORCE_WALLET_RESET = '1'
    const { importWallet } = await import('../../packages/mcp/src/lib/wallet-store')
    const out = await importWallet(KEY_B)
    expect(out.privateKey).toBe(KEY_B)
    const backups = listBackups()
    expect(backups.length).toBe(1)
    expect(/^wallet\.json\.bak\.\d+$/.test(backups[0])).toBe(true)
    expect(readFileSync(join(walletDir(), backups[0]), 'utf8')).toBe(original)
  })

  itLive('repeated forced overwrites preserve all backups', async () => {
    preWrite(KEY_A)
    const orig = readFileSync(walletFile(), 'utf8')
    process.env.B402_FORCE_WALLET_RESET = '1'
    const { importWallet } = await import('../../packages/mcp/src/lib/wallet-store')

    await importWallet(KEY_B)
    // bump clock so the second backup gets a distinct unix-second filename
    await new Promise((r) => setTimeout(r, 1100))
    await importWallet(KEY_A)

    const backups = listBackups().sort()
    expect(backups.length).toBe(2)
    // Earliest backup is the original KEY_A wallet
    expect(readFileSync(join(walletDir(), backups[0]), 'utf8')).toBe(orig)
  })
})
