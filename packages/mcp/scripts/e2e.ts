#!/usr/bin/env tsx
/**
 * End-to-end MCP smoke test.
 *
 * Spawns dist/index.js over stdio, lists tools, and exercises every
 * read-only tool. Read-only means: no shielded balance is moved, no
 * gas is paid, no sequencer credits are spent. Safe to run against the
 * real wallet at ~/.b402/wallet.json.
 *
 * Run from packages/mcp/:
 *   npm run build && npm run test:e2e
 *
 * Optional env:
 *   B402_E2E_CHAIN=arbitrum    # restrict to one chain (default: both)
 *   B402_E2E_SKIP_NETWORK=1    # skip tools that hit external APIs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import 'dotenv/config'

const here = dirname(fileURLToPath(import.meta.url))
// scripts/e2e.ts → ../dist/index.js
const MCP_ENTRY = join(here, '..', 'dist', 'index.js')

const SKIP_NETWORK = process.env.B402_E2E_SKIP_NETWORK === '1'
const ONLY_CHAIN = process.env.B402_E2E_CHAIN

interface ToolCallSpec {
  name: string
  args: Record<string, unknown>
  expectText?: RegExp
  network?: boolean
  chains?: Array<'base' | 'arbitrum'>
}

const TESTS: ToolCallSpec[] = [
  // 1. Wallet/pool balance — read-only, hits chain RPC
  { name: 'check_pool_balance', args: {}, expectText: /chain|balance|pool/i, network: true },
  { name: 'check_pool_balance', args: { chain: 'base' }, expectText: /base/i, network: true, chains: ['base'] },
  { name: 'check_pool_balance', args: { chain: 'arbitrum' }, expectText: /arbitrum/i, network: true, chains: ['arbitrum'] },

  // 2. b402 wallet/credits balance — read-only, hits sequencer + chain RPC
  { name: 'b402_balance', args: {}, expectText: /chain|wallet|pool|credit/i, network: true },

  // 3. Odos swap quote — read-only, hits Odos API
  {
    name: 'get_swap_quote',
    args: { from: 'USDC', to: 'WETH', amount: '0.01' },
    expectText: /quote|amount|impact|odos/i,
    network: true,
    chains: ['base'],
  },
]

function fmt(s: unknown, n = 200): string {
  const str = typeof s === 'string' ? s : JSON.stringify(s)
  return str.length > n ? str.slice(0, n) + '…' : str
}

async function main() {
  console.log(`\nb402-mcp end-to-end smoke\n`)
  console.log(`  entry: ${MCP_ENTRY}`)
  console.log(`  skip-network: ${SKIP_NETWORK}`)
  console.log(`  only-chain: ${ONLY_CHAIN ?? '(all)'}\n`)

  // Pass through any env the MCP needs (BASE_RPC_URL, ARB_RPC_URL, etc.)
  const transport = new StdioClientTransport({
    command: 'node',
    args: [MCP_ENTRY],
    env: { ...process.env } as Record<string, string>,
  })

  const client = new Client(
    { name: 'b402-e2e-smoke', version: '0.0.0' },
    { capabilities: {} },
  )

  await client.connect(transport)
  console.log('✓ connected')

  // ── 1. List tools ──
  const { tools } = await client.listTools()
  console.log(`\n[listTools] returned ${tools.length} tools:`)
  for (const t of tools) console.log(`  - ${t.name}`)

  const expected = [
    'b402_balance', 'b402_create_invoice', 'b402_pay', 'pay_via_b402',
    'check_pool_balance', 'get_swap_quote', 'private_swap',
    'lend_privately', 'redeem_privately', 'shield_usdc', 'run_strategy',
    'cross_chain_privately',
  ]
  const missing = expected.filter((n) => !tools.some((t) => t.name === n))
  if (missing.length) {
    console.error(`\n✗ missing tools: ${missing.join(', ')}`)
    process.exit(1)
  }
  console.log(`✓ all ${expected.length} expected tools present`)

  // ── 2. Server info / version ──
  // The Client doesn't have a built-in "server info" call, but version
  // surfaces via the implementation field on initialize. Print what we got.
  const serverInfo = (client as any).getServerVersion?.() ?? '(unknown)'
  console.log(`\n[serverInfo] ${JSON.stringify(serverInfo)}`)

  // ── 3. Exercise each tool spec ──
  let passed = 0
  let failed = 0
  let skipped = 0

  for (const spec of TESTS) {
    if (SKIP_NETWORK && spec.network) {
      console.log(`\n[skip] ${spec.name}(${fmt(spec.args)}) — network skipped`)
      skipped++
      continue
    }
    if (ONLY_CHAIN && spec.chains && !spec.chains.includes(ONLY_CHAIN as 'base' | 'arbitrum')) {
      console.log(`\n[skip] ${spec.name}(${fmt(spec.args)}) — chain filter`)
      skipped++
      continue
    }

    process.stdout.write(`\n[call] ${spec.name}(${fmt(spec.args)}) … `)
    try {
      const result = await client.callTool({
        name: spec.name,
        arguments: spec.args,
      })
      const text = (result.content ?? [])
        .map((c: any) => c.type === 'text' ? c.text : '')
        .join('\n')
      if (result.isError) {
        console.log(`✗ tool returned isError`)
        console.log(`  ${fmt(text, 600)}`)
        failed++
        continue
      }
      if (spec.expectText && !spec.expectText.test(text)) {
        console.log(`✗ output did not match ${spec.expectText}`)
        console.log(`  ${fmt(text, 600)}`)
        failed++
        continue
      }
      console.log(`✓`)
      console.log(`  ${fmt(text, 600).split('\n').slice(0, 4).join('\n  ')}`)
      passed++
    } catch (err: any) {
      console.log(`✗ threw`)
      console.log(`  ${err.message}`)
      failed++
    }
  }

  await client.close()

  console.log(`\n${'='.repeat(50)}`)
  console.log(`passed: ${passed}    failed: ${failed}    skipped: ${skipped}`)
  console.log(`${'='.repeat(50)}\n`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('\nFATAL:', err)
  process.exit(2)
})
