#!/usr/bin/env tsx
/**
 * Live Demo — "Giving an AI agent its own private treasury"
 *
 * Run this on camera. Each step pauses so you can talk through it.
 *
 *   npx tsx examples/demo-live.ts           # full flow (shield → swap → lend)
 *   npx tsx examples/demo-live.ts quick     # skip shield (use existing pool balance)
 *
 * Env: WORKER_PRIVATE_KEY in .env
 */

import { B402 } from '../src/b402'
import * as dotenv from 'dotenv'
import * as readline from 'readline'
dotenv.config()

// ── Config ──
const SHIELD_AMOUNT = '1'
const SWAP_AMOUNT = '0.1'
const LEND_AMOUNT = '0.1'
const skipShield = process.argv[2] === 'quick'

// ── Helpers ──
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

function log(msg = '') { console.log(msg) }

function banner(title: string) {
  log()
  log(bold(`  ${'━'.repeat(56)}`))
  log(bold(`  ${title}`))
  log(bold(`  ${'━'.repeat(56)}`))
  log()
}

function code(lines: string[]) {
  for (const line of lines) {
    log(`  ${dim('│')} ${cyan(line)}`)
  }
  log()
}

function result(label: string, value: string) {
  log(`  ${dim('→')} ${label}: ${bold(value)}`)
}

async function pause(msg = 'Press Enter to continue...') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  await new Promise<void>(r => rl.question(`  ${dim(msg)}`, () => { rl.close(); r() }))
  log()
}

// ── SDK ──
const b402 = new B402({
  privateKey: process.env.WORKER_PRIVATE_KEY!,
  rpcUrl: process.env.BASE_RPC_URL,
  onProgress: (e) => {
    if (e.type === 'step') log(`    ${dim(`[${e.step}/${e.totalSteps}]`)} ${e.title}`)
    else if (e.type === 'done') log(`    ${green('✓')} ${e.message}`)
  },
})

const scan = (hash: string) => `https://basescan.org/tx/${hash}`

// ── Demo ──
async function main() {
  console.clear()
  log()
  log(bold('  b402 SDK — Private AI Agent Treasury'))
  log(dim('  Give an AI agent its own untraceable wallet on Base'))
  log()
  log(dim('  Everything is gasless. Everything is private.'))
  log(dim('  No one can see what the agent is doing on-chain.'))

  // ── Step 1: The Code ──
  await pause()
  banner('Step 1 — The Code')
  log(dim('  This is all an agent needs:'))
  log()
  code([
    'import { B402 } from "@b402ai/sdk"',
    '',
    'const b402 = new B402({ privateKey: AGENT_KEY })',
    '',
    'await b402.shield({ token: "USDC", amount: "1" })',
    'await b402.privateSwap({ from: "USDC", to: "WETH", amount: "0.1" })',
    'await b402.privateLend({ token: "USDC", amount: "0.1", vault: "steakhouse" })',
  ])
  log(dim('  5 lines. Private treasury. Autonomous capital deployment.'))

  // ── Step 2: Status ──
  await pause()
  banner('Step 2 — Agent Treasury Status')
  code(['const status = await b402.status()'])

  const status = await b402.status()
  log()
  result('Smart Wallet', status.smartWallet)
  result('Owner EOA', status.ownerEOA)
  result('Wallet Balance', status.balances.map(b => `${b.balance} ${b.token}`).join(', ') || 'empty')
  result('Privacy Pool', status.shieldedBalances.length > 0
    ? status.shieldedBalances.map(b => `${b.balance} ${b.token}`).join(', ')
    : 'empty')
  result('Yield Positions', status.positions.length > 0
    ? status.positions.map(p => `${p.assets} in ${p.vault} (${p.apyEstimate} APY${p.tvl ? ', ' + p.tvl + ' TVL' : ''})`).join(', ')
    : 'none')
  log()
  log(dim('  The smart wallet is derived from the agent key.'))
  log(dim('  No deployment cost. No gas needed. Ready to go.'))

  // ── Step 3: Shield ──
  if (!skipShield) {
    await pause()
    banner(`Step 3 — Shield ${SHIELD_AMOUNT} USDC into Privacy Pool`)
    log(dim('  This breaks the on-chain link between the funding source and the agent.'))
    log(dim('  After this, the USDC is inside a ZK privacy pool — untraceable.'))
    log()
    code([`await b402.shield({ token: "USDC", amount: "${SHIELD_AMOUNT}" })`])

    const shield = await b402.shield({ token: 'USDC', amount: SHIELD_AMOUNT })
    log()
    result('TX', scan(shield.txHash))
    result('Indexed', shield.indexed ? 'yes' : 'cached locally (instant)')
    log()
    log(green('  ✓ USDC is now in the privacy pool. No trace back to the funder.'))
  }

  // ── Step 4: Private Swap ──
  await pause()
  banner(`Step ${skipShield ? 3 : 4} — Private Swap: ${SWAP_AMOUNT} USDC → WETH`)
  log(dim('  Swapping from inside the privacy pool via Aerodrome DEX.'))
  log(dim('  Nobody can see who is making this trade.'))
  log()
  code([`await b402.privateSwap({ from: "USDC", to: "WETH", amount: "${SWAP_AMOUNT}" })`])

  const swap = await b402.privateSwap({
    from: 'USDC', to: 'WETH', amount: SWAP_AMOUNT, slippageBps: 300,
  })
  log()
  result('TX', scan(swap.txHash))
  result('Swapped', `${swap.amountIn} ${swap.tokenIn} → ${swap.amountOut} ${swap.tokenOut}`)
  log()
  log(green('  ✓ Swap executed from privacy pool. On-chain: anonymous.'))

  // ── Step 5: Private Lend ──
  await pause()
  banner(`Step ${skipShield ? 4 : 5} — Private Lend: ${LEND_AMOUNT} USDC → Morpho Vault`)
  log(dim('  Deploying capital into a yield vault — directly from the privacy pool.'))
  log(dim('  The agent is earning yield and nobody knows it\'s the agent.'))
  log()
  code([`await b402.privateLend({ token: "USDC", amount: "${LEND_AMOUNT}", vault: "steakhouse" })`])

  const lend = await b402.privateLend({
    token: 'USDC', amount: LEND_AMOUNT, vault: 'steakhouse',
  })
  log()
  result('TX', scan(lend.txHash))
  result('Vault', `${lend.vault}`)
  log()
  log(green('  ✓ Capital deployed to yield vault. Earning yield. Privately.'))

  // ── Step 6: Final Status ──
  await pause()
  banner(`Step ${skipShield ? 5 : 6} — Final Treasury State`)

  const final = await b402.status()
  log()
  result('Wallet Balance', final.balances.map(b => `${b.balance} ${b.token}`).join(', ') || 'empty')
  result('Privacy Pool', final.shieldedBalances.length > 0
    ? final.shieldedBalances.map(b => `${b.balance} ${b.token}`).join(', ')
    : 'empty')
  result('Yield Positions', final.positions.length > 0
    ? final.positions.map(p => `${p.assets} in ${p.vault} (${p.apyEstimate} APY${p.tvl ? ', ' + p.tvl + ' TVL' : ''})`).join(', ')
    : 'none')

  // ── Summary ──
  log()
  log(bold('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
  log()
  log(bold('  What just happened:'))
  log(`    ${green('1.')} Agent shielded USDC — broke the on-chain funding link`)
  log(`    ${green('2.')} Agent swapped USDC → WETH — from inside the privacy pool`)
  log(`    ${green('3.')} Agent deployed USDC to yield — from inside the privacy pool`)
  log()
  log(`  ${yellow('Gas cost:')}        ${bold('$0.00')}`)
  log(`  ${yellow('On-chain trace:')}  ${bold('none')}`)
  log(`  ${yellow('Lines of code:')}   ${bold('5')}`)
  log()
  log(dim('  npm install @b402ai/sdk'))
  log(dim('  https://github.com/b402ai/sdk'))
  log()
}

main().catch(err => {
  console.error(`\n  ${err.message}`)
  process.exit(1)
})
