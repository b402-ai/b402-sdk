import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getB402 } from '../lib/b402-client.js'

const basescan = (hash: string) => `https://basescan.org/tx/${hash}`
const MIN_SWAP = 3 // Aerodrome minimum ~$3 for reliable routing

export function registerStrategyTools(server: McpServer) {

  server.tool(
    'run_strategy',
    'Deploy a multi-step private DeFi strategy — all from the Railgun privacy pool using ZK proofs. ' +
    'Splits USDC across: (1) private swap to WETH for ETH exposure, (2) private lend to Morpho vault for ~3% APY yield, (3) USDC reserve kept shielded in pool. ' +
    'Each step is a separate ZK-proven transaction. On-chain, only RelayAdapt appears — no wallet linked. ' +
    'Minimum $15 total recommended ($3 minimum per swap leg). Set any percentage to 0 to skip that step.',
    {
      amount: z.string().describe('Total USDC to deploy (minimum 15 recommended)'),
      swapPct: z.number().default(20).describe('Percent to swap to WETH (0 to skip)'),
      lendPct: z.number().default(40).describe('Percent to lend to Morpho vault (0 to skip)'),
      vault: z.string().default('steakhouse').describe('Vault: steakhouse, moonwell, gauntlet'),
      reservePct: z.number().default(40).describe('Percent to keep as USDC reserve'),
    },
    async ({ amount, swapPct, lendPct, vault, reservePct }) => {
      try {
        const b402 = getB402()
        const total = parseFloat(amount)

        // Validate total percentages
        if (swapPct + lendPct + reservePct !== 100) {
          return { content: [{ type: 'text', text:
            `Allocation must total 100%. Got: swap ${swapPct}% + lend ${lendPct}% + reserve ${reservePct}% = ${swapPct + lendPct + reservePct}%`
          }], isError: true }
        }

        const swapAmt = total * swapPct / 100
        const lendAmt = total * lendPct / 100
        const reserveAmt = total * reservePct / 100

        // Validate minimums
        if (swapPct > 0 && swapAmt < MIN_SWAP) {
          return { content: [{ type: 'text', text:
            `Swap amount $${swapAmt.toFixed(2)} is below $${MIN_SWAP} minimum for Aerodrome routing.\n` +
            `Either increase total amount to $${(MIN_SWAP / (swapPct / 100)).toFixed(0)}+ or set swapPct to 0.`
          }], isError: true }
        }
        if (lendPct > 0 && lendAmt < 0.5) {
          return { content: [{ type: 'text', text:
            `Lend amount $${lendAmt.toFixed(2)} is too small. Minimum $0.50 for Morpho deposit.`
          }], isError: true }
        }

        // Check pool balance
        const status = await b402.status()
        const poolUsdc = status.shieldedBalances.find(b => b.token === 'USDC')
        const poolBal = poolUsdc ? parseFloat(poolUsdc.balance) : 0

        // Build plan
        const plan: string[] = [
          `Strategy Plan: ${total} USDC`,
          ``,
        ]
        if (poolBal < total) {
          const needed = total - poolBal
          const walletUsdc = status.balances.find(b => b.token === 'USDC')
          const walletBal = walletUsdc ? parseFloat(walletUsdc.balance) : 0
          if (poolBal + walletBal < total) {
            return { content: [{ type: 'text', text:
              `Insufficient USDC. Need $${total}, have $${poolBal.toFixed(2)} in pool + $${walletBal.toFixed(2)} in wallet.\n` +
              `Send USDC to your incognito wallet (${status.smartWallet}) on Base.`
            }], isError: true }
          }
          plan.push(`  1. Shield ${needed.toFixed(2)} USDC into privacy pool`)
        } else {
          plan.push(`  1. Pool has ${poolBal.toFixed(2)} USDC ✓`)
        }
        if (swapPct > 0) plan.push(`  2. Private swap ${swapAmt.toFixed(2)} USDC → WETH (ZK proof)`)
        if (lendPct > 0) plan.push(`  ${swapPct > 0 ? '3' : '2'}. Private lend ${lendAmt.toFixed(2)} USDC → ${vault} (~3% APY)`)
        plan.push(`  ${(swapPct > 0 ? 2 : 1) + (lendPct > 0 ? 1 : 0) + 1}. Reserve ${reserveAmt.toFixed(2)} USDC in pool`)

        // Execute
        const steps: string[] = []
        const txLinks: string[] = []

        // Shield if needed
        if (poolBal < total) {
          const needed = (total - poolBal).toFixed(2)
          const shieldResult = await b402.shield({ token: 'USDC', amount: needed })
          steps.push(`Shielded ${needed} USDC into privacy pool`)
          txLinks.push(basescan(shieldResult.txHash))
        } else {
          steps.push(`Pool has ${poolBal.toFixed(2)} USDC — sufficient`)
        }

        // Swap
        if (swapPct > 0) {
          const swapResult = await b402.privateSwap({
            from: 'USDC', to: 'WETH', amount: swapAmt.toFixed(2), slippageBps: 300,
          })
          steps.push(`Private swap: ${swapAmt.toFixed(2)} USDC → ${swapResult.amountOut} WETH`)
          txLinks.push(basescan(swapResult.txHash))
        }

        // Lend
        if (lendPct > 0) {
          const lendResult = await b402.privateLend({ token: 'USDC', amount: lendAmt.toFixed(2), vault })
          steps.push(`Private lend: ${lendAmt.toFixed(2)} USDC → ${vault}`)
          txLinks.push(basescan(lendResult.txHash))
        }

        // Reserve
        steps.push(`Reserve: ${reserveAmt.toFixed(2)} USDC stays shielded`)

        return { content: [{ type: 'text', text:
          `Strategy deployed: ${amount} USDC\n\n` +
          `Execution:\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n\n` +
          `Allocation:\n` +
          (swapPct > 0 ? `  ${swapPct}% → WETH (private swap)\n` : '') +
          (lendPct > 0 ? `  ${lendPct}% → ${vault} vault (~3% APY)\n` : '') +
          `  ${reservePct}% → USDC reserve (shielded)\n\n` +
          `Transactions:\n${txLinks.map(l => `  ${l}`).join('\n')}\n\n` +
          `On-chain: only RelayAdapt visible. No wallet linked.`
        }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )
}
