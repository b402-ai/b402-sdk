import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { sequencer } from '../lib/sequencer-client.js'

export function registerCreditTools(server: McpServer) {

  server.tool(
    'check_balance',
    'Check agent credit balance on the b402 sequencer',
    { agentId: z.string().describe('Agent ID (hex string)') },
    async ({ agentId }) => {
      try {
        const bal = await sequencer.getBalance(agentId)
        const usdBalance = (bal.balance / 1_000_000).toFixed(2)
        const usdEffective = (bal.effectiveBalance / 1_000_000).toFixed(2)
        return { content: [{ type: 'text', text:
          `Agent: ${agentId}\n` +
          `Balance: $${usdBalance} USDC (${bal.balance} micros)\n` +
          `Effective: $${usdEffective} (after pending debits)\n` +
          `Nonce: ${bal.nonce}\n` +
          `Pending debits: ${bal.pendingDebits} micros`
        }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'topup_credits',
    'Add USDC credits to an agent on the b402 sequencer',
    {
      agentId: z.string().describe('Agent ID'),
      amount: z.string().describe('Amount in USDC (e.g. "1.00")'),
    },
    async ({ agentId, amount }) => {
      try {
        const micros = Math.round(parseFloat(amount) * 1_000_000).toString()
        const result = await sequencer.topup(agentId, micros)
        const usdBalance = (result.balance / 1_000_000).toFixed(2)
        return { content: [{ type: 'text', text:
          `Topped up ${amount} USDC to agent ${agentId}\n` +
          `New balance: $${usdBalance} USDC`
        }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'open_session',
    'Open a private credit session with a spending cap',
    {
      agentId: z.string().describe('Agent ID'),
      spendingCap: z.string().describe('Spending cap in USDC (e.g. "1.00")'),
      merchantId: z.string().optional().describe('Merchant ID to restrict payments to'),
    },
    async ({ agentId, spendingCap, merchantId }) => {
      try {
        const micros = Math.round(parseFloat(spendingCap) * 1_000_000).toString()
        const result = await sequencer.openSession(agentId, micros, 3600, merchantId)
        return { content: [{ type: 'text', text:
          `Session opened: ${result.sessionId}\n` +
          `Spending cap: $${spendingCap} USDC\n` +
          `Status: ${result.status}\n` +
          `Expires: ${result.expiresAt}`
        }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'pay_privately',
    'Make private API payments via credit session (BLS-signed, off-chain)',
    {
      sessionId: z.string().describe('Active session ID'),
      merchantId: z.string().describe('Merchant receiving payment'),
      amountPerCall: z.string().describe('Amount per API call in USDC (e.g. "0.01")'),
      count: z.number().describe('Number of API calls to pay for'),
      memo: z.string().optional().describe('Payment memo'),
    },
    async ({ sessionId, merchantId, amountPerCall, count, memo }) => {
      try {
        const micros = Math.round(parseFloat(amountPerCall) * 1_000_000).toString()
        const results: string[] = []
        let remaining = 0

        for (let i = 0; i < count; i++) {
          const result = await sequencer.sessionPay(sessionId, merchantId, micros)
          remaining = result.remainingMicros
          results.push(`  #${i + 1}: authId=${result.authId.slice(0, 12)}... BLS=${result.blsSig.slice(0, 16)}...`)
        }

        const totalSpent = (parseFloat(amountPerCall) * count).toFixed(2)
        const remainingUsd = (remaining / 1_000_000).toFixed(2)
        return { content: [{ type: 'text', text:
          `${count} private payments completed${memo ? ` (${memo})` : ''}\n` +
          `Amount per call: $${amountPerCall}\n` +
          `Total spent: $${totalSpent}\n` +
          `Remaining in session: $${remainingUsd}\n\n` +
          `Payments:\n${results.join('\n')}`
        }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'close_session',
    'Close a credit session and refund unspent amount',
    { sessionId: z.string().describe('Session ID to close') },
    async ({ sessionId }) => {
      try {
        const result = await sequencer.closeSession(sessionId)
        const spent = (result.spentMicros / 1_000_000).toFixed(2)
        const refunded = (result.refundedMicros / 1_000_000).toFixed(2)
        return { content: [{ type: 'text', text:
          `Session closed.\n` +
          `Spent: $${spent} USDC\n` +
          `Refunded: $${refunded} USDC`
        }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'settle_batch',
    'Settle all pending payments on-chain and verify BLS aggregate proof',
    {},
    async () => {
      try {
        const settlement = await sequencer.settle()
        const verification = await sequencer.verifyEpoch(settlement.epochId)
        const totalUsd = (settlement.totalMicros / 1_000_000).toFixed(2)

        let payoutLines = ''
        if (settlement.payouts?.length) {
          payoutLines = '\n\nPayouts:\n' + settlement.payouts.map((p: any) =>
            `  ${p.merchantId}: $${(p.amountMicros / 1_000_000).toFixed(2)} → ${p.txHash ? `https://basescan.org/tx/${p.txHash}` : 'pending'}`
          ).join('\n')
        }

        return { content: [{ type: 'text', text:
          `Settlement complete.\n` +
          `Epoch: ${settlement.epochId}\n` +
          `Payments settled: ${settlement.count}\n` +
          `Total: $${totalUsd} USDC\n` +
          `BLS proof valid: ${verification.valid}\n` +
          `Merkle root: ${verification.root}` +
          payoutLines
        }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )
}
