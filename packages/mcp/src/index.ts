#!/usr/bin/env node
import 'dotenv/config'

const args = process.argv.slice(2)
const isTTY = process.stdin.isTTY
const cmd = args[0]

// ── CLI commands ────────────────────────────────────────────────────

if (cmd === '--claude' || cmd === 'install') {
  const { walletExists, readWallet, createWallet, importWallet } = await import('./lib/wallet-store.js')

  // Check for --key flag: npx b402-mcp --claude --key 0x...
  const keyIdx = args.indexOf('--key')
  const providedKey = keyIdx !== -1 ? args[keyIdx + 1] : undefined

  let wallet = readWallet()

  if (providedKey) {
    console.log('\nb402 — Private DeFi for AI agents\n')
    console.log('Importing your wallet...\n')
    wallet = await importWallet(providedKey)
    console.log(`  Wallet imported and saved to ~/.b402/wallet.json\n`)
  } else if (!wallet) {
    console.log('\nb402 — Private DeFi for AI agents\n')
    console.log('Creating your private wallet...\n')
    wallet = await createWallet()
    console.log(`  Wallet created and saved to ~/.b402/wallet.json\n`)
  } else {
    console.log('\nb402 — Private DeFi for AI agents\n')
  }

  console.log(`  Incognito Wallet:   ${wallet.smartWallet}`)
  console.log(`  Incognito EOA:  ${wallet.incognitoEOA}`)
  console.log(``)
  console.log(`  Fund with USDC — same address on Base, Arbitrum, BSC:`)
  console.log(`  → Send USDC to ${wallet.smartWallet}`)
  console.log(`  → Or: https://b402.ai/fund?address=${wallet.smartWallet}`)
  console.log(``)

  // Auto-detect and install to ALL MCP clients
  const { installToAllClients } = await import('./lib/installer.js')
  const results = installToAllClients()

  if (results.length > 0) {
    console.log(`  Installed:`)
    for (const r of results) console.log(`    ${r}`)
  } else {
    console.log(`  No MCP clients detected. Add manually:`)
    console.log(`  { "command": "b402-mcp" }`)
  }

  console.log(`\n  Open your agent and say: "check my private balance"\n`)
  process.exit(0)
}

if (cmd === 'status') {
  const { readWallet } = await import('./lib/wallet-store.js')
  const wallet = readWallet()
  if (!wallet) {
    console.log('No wallet found. Run: npx b402-mcp --claude')
    process.exit(1)
  }
  console.log(`\nb402 wallet`)
  console.log(`  Incognito Wallet:   ${wallet.smartWallet}`)
  console.log(`  Incognito EOA:  ${wallet.incognitoEOA}`)
  console.log(`  Created:        ${wallet.createdAt}`)
  console.log(`  Key file:       ~/.b402/wallet.json`)
  console.log(`\n  Fund: https://b402.ai/fund?address=${wallet.smartWallet}\n`)
  process.exit(0)
}

if (cmd === '--help' || cmd === '-h') {
  console.log(`
b402 — Private DeFi MCP server for AI agents

Core payment tools + private DeFi tools. ZK proofs. Gasless. Base mainnet.
Works with Claude, Cursor, Windsurf, Cline — any MCP client.

Usage:
  b402-mcp --claude         Create wallet + install into Claude Code
  b402-mcp install          Same as --claude
  b402-mcp status           Show wallet info
  b402-mcp --help           Show this help

Tools:
  b402_balance        Payment balance (credits or wallet/pool)
  b402_create_invoice Create payment invoice
  b402_pay            Make gasless payment via sequencer credits
  pay_via_b402        Standard HTTP 402 verify+settle flow
  check_pool_balance    Shielded balances, wallet, positions
  get_swap_quote        DEX quote (Odos aggregator, all Base DEXes)
  private_swap          Swap inside privacy pool (ZK proof)
  lend_privately        Deposit to Morpho vault from pool (~3% APY)
  redeem_privately      Withdraw from vault to pool
  shield_usdc           Move tokens into privacy pool
  run_strategy          Autonomous: swap + lend + reserve

Wallet stored at ~/.b402/wallet.json (auto-created on install)
Logs written to ~/.b402/mcp.log (tail -f to debug)

npm: https://npmjs.com/package/b402-mcp
docs: https://b402.ai
`)
  process.exit(0)
}

if (isTTY && args.length === 0) {
  console.log('b402 — Private DeFi MCP server\n')
  console.log('  b402-mcp --claude    Create wallet + install')
  console.log('  b402-mcp status      Show wallet info')
  console.log('  b402-mcp --help      All options\n')
  process.exit(0)
}

// ── Patch railgun at startup: exports + Base network config ────────
import './patch-railgun.js'

// ── MCP Server (stdio) ─────────────────────────────────────────────
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { registerCompatibilityTools } from './tools/compat.js'
import { registerCreditTools } from './tools/credit.js'
import { registerPrivacyTools } from './tools/privacy.js'
import { registerStrategyTools } from './tools/strategy.js'

const server = new McpServer({
  name: 'b402',
  version: '0.5.0',
  description: [
    'b402 — Private DeFi execution for AI agents on Base.',
    '',
    'How it works:',
    '- A private key derives an anonymous "incognito" wallet via deterministic signature (sign a fixed message → keccak256 → new key). No on-chain link to the original key.',
    '- That incognito key derives a gasless incognito wallet (ERC-4337 Nexus, counterfactual). Gas is sponsored — no ETH needed.',
    '- Tokens are shielded into a Railgun privacy pool as ZK-encrypted UTXOs. Only the owner can decrypt balances (client-side).',
    '- Private operations (swap, lend, redeem) use ZK proofs via RelayAdapt. On-chain, only the relay contract appears — no wallet is linked.',
    '',
    'What this means for the user:',
    '- Their wallet address never appears on-chain for DeFi operations',
    '- Block explorers show RelayAdapt, not them',
    '- Balances are invisible to anyone without the private key',
    '- All operations are gasless (no ETH required)',
    '',
    'Available DeFi:',
    '- Swap: any token pair on Base via Odos aggregator (routes across all DEXes)',
    '- Lend: Morpho vaults (Steakhouse, Moonwell, Gauntlet) — 3-4% APY',
    '- Shield/Unshield: move tokens in/out of the privacy pool',
    '- Strategy: autonomous multi-step deployment (swap + lend + reserve)',
    '',
    'Wallet is stored at ~/.b402/wallet.json. Fund the incognito wallet with USDC on Base to get started.',
  ].join('\n'),
})

if (process.env.SEQUENCER_URL) {
  registerCreditTools(server)
}

registerCompatibilityTools(server)
registerPrivacyTools(server)
registerStrategyTools(server)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
main().catch(console.error)
