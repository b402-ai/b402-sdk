import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getB402, SUPPORTED_CHAINS } from '../lib/b402-client.js'
import { sequencer } from '../lib/sequencer-client.js'

const PAYMENT_TOKEN = 'USDC'
const PAYMENT_REQUIRED_HEADERS = ['x-payment-required', 'payment-required']
const SUPPORTED_NETWORKS = ['base-mainnet', 'eip155:8453', 'base', 'bnb-mainnet', 'eip155:56', 'bnb']
const DEFAULT_BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org'
const DEFAULT_BNB_RPC = process.env.BNB_RPC_URL || 'https://bsc-dataseed.binance.org'

function formatUsdMicros(micros: number): string {
  return (micros / 1_000_000).toFixed(2)
}

type X402Requirement = {
  x402Version?: number
  scheme: string
  network: string
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds?: number
  extra?: Record<string, any>
}

function getPaymentSignatureHeaderName(version = 1): string {
  return version >= 2 ? 'payment-signature' : 'x-payment'
}

function pickRequirement(accepts: X402Requirement[]): X402Requirement {
  const match = accepts.find((entry) => SUPPORTED_NETWORKS.includes(entry.network))
  if (!match) {
    throw new Error(`No supported network in payment requirement. Got: ${accepts.map((a) => a.network).join(', ')}`)
  }
  return match
}

async function extractPaymentRequirement(response: Response): Promise<X402Requirement | null> {
  if (response.status !== 402) return null

  for (const headerName of PAYMENT_REQUIRED_HEADERS) {
    const rawHeader = response.headers.get(headerName)
    if (rawHeader) {
      try {
        const decoded = Buffer.from(rawHeader.trim(), 'base64').toString('utf8')
        const envelope = JSON.parse(decoded) as { x402Version?: number; accepts: X402Requirement[] }
        if (Array.isArray(envelope.accepts) && envelope.accepts.length > 0) {
          const req = pickRequirement(envelope.accepts)
          return {
            ...req,
            x402Version: req.x402Version ?? envelope.x402Version ?? 2,
          }
        }
      } catch {
        // fall through to body parse
      }
    }
  }

  try {
    const body = await response.clone().json() as { x402Version?: number; accepts?: X402Requirement[] }
    if (Array.isArray(body.accepts) && body.accepts.length > 0) {
      const req = pickRequirement(body.accepts)
      return {
        ...req,
        x402Version: req.x402Version ?? body.x402Version ?? 1,
      }
    }
  } catch {
    // non-json body
  }

  return null
}

export function registerCompatibilityTools(server: McpServer) {
  server.tool(
    'b402_balance',
    'Check b402 balance for payments. Reads sequencer credits when `agentId` is provided. Otherwise queries wallet + shielded balances across Base, Arbitrum, and BSC. Pass `chain` to scope to a single chain.',
    {
      agentId: z.string().optional().describe('Optional sequencer agent id for credit balance lookup'),
      chain: z.enum(['base', 'arbitrum', 'bsc']).optional().describe('Optional: scope to a single chain. Default queries all 3.'),
    },
    async ({ agentId, chain }) => {
      try {
        if (agentId) {
          const bal = await sequencer.getBalance(agentId)
          return {
            content: [{
              type: 'text',
              text:
                `b402 credits (${agentId})\n` +
                `Balance: $${formatUsdMicros(bal.balance)} ${PAYMENT_TOKEN}\n` +
                `Effective: $${formatUsdMicros(bal.effectiveBalance)} ${PAYMENT_TOKEN}\n` +
                `Pending debits: ${bal.pendingDebits} micros\n` +
                `Nonce: ${bal.nonce}`,
            }],
          }
        }

        // Wallet/pool balance — multi-chain (or scoped to one if `chain` given).
        const targets = chain
          ? SUPPORTED_CHAINS.filter((c) => c.name === chain)
          : SUPPORTED_CHAINS

        const results = await Promise.all(
          targets.map(async (c) => {
            try {
              const b402 = getB402(c.chainId)
              const status = await b402.status()
              const walletUsdc =
                status.balances.find((b) => b.token === PAYMENT_TOKEN)?.balance ?? '0'
              const poolUsdc =
                status.shieldedBalances.find((b) => b.token === PAYMENT_TOKEN)?.balance ?? '0'
              return {
                chain: c.name,
                smartWallet: status.smartWallet,
                walletUsdc,
                poolUsdc,
                ok: true as const,
              }
            } catch (e: any) {
              return { chain: c.name, ok: false as const, error: e.message }
            }
          }),
        )

        // Smart wallet address is the same on all chains (Nexus CREATE2 deterministic).
        const sw = results.find((r) => r.ok)?.smartWallet ?? '(unavailable)'

        const lines = [`b402 wallet balance`, `Incognito wallet: ${sw}`, '']
        for (const r of results) {
          if (r.ok) {
            lines.push(
              `${r.chain.padEnd(9)} wallet: ${r.walletUsdc} ${PAYMENT_TOKEN}, shielded: ${r.poolUsdc} ${PAYMENT_TOKEN}`,
            )
          } else {
            lines.push(`${r.chain.padEnd(9)} (error: ${r.error})`)
          }
        }
        lines.push('')
        lines.push(`Same address on all chains. Send USDC to ${sw} on any of: Base, Arbitrum, BSC.`)

        return { content: [{ type: 'text', text: lines.join('\n') }] }
      } catch (e: any) {
        return {
          content: [{ type: 'text', text: `Error: ${e.message}` }],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'b402_create_invoice',
    'Create a b402 payment invoice that can be paid with gasless credits or directly to an incognito address.',
    {
      amount: z.string().describe('Invoice amount in USDC (e.g. "0.25")'),
      memo: z.string().optional().describe('Optional memo shown to payer'),
      merchantId: z.string().optional().describe('Optional merchant id for sequencer-based settlement'),
      recipientAddress: z.string().optional().describe('Optional explicit recipient address'),
      expiresInMinutes: z.number().optional().default(60).describe('Invoice expiry in minutes'),
    },
    async ({ amount, memo, merchantId, recipientAddress, expiresInMinutes }) => {
      try {
        const b402 = getB402()
        const payTo = recipientAddress ?? await b402.getIncognitoAddress()
        const invoiceId = `inv_${randomUUID().replace(/-/g, '')}`
        const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000).toISOString()

        const query = new URLSearchParams({
          amount,
          token: PAYMENT_TOKEN,
          payTo,
          expiresAt,
        })
        if (merchantId) query.set('merchantId', merchantId)
        if (memo) query.set('memo', memo)

        const payUrl = `b402://pay?${query.toString()}`

        return {
          content: [{
            type: 'text',
            text:
              `Invoice created.\n` +
              `Invoice ID: ${invoiceId}\n` +
              `Amount: ${amount} ${PAYMENT_TOKEN}\n` +
              `Recipient: ${payTo}\n` +
              `Expires: ${expiresAt}\n` +
              `${merchantId ? `Merchant: ${merchantId}\n` : ''}` +
              `${memo ? `Memo: ${memo}\n` : ''}` +
              `Pay URL: ${payUrl}`,
          }],
        }
      } catch (e: any) {
        return {
          content: [{ type: 'text', text: `Error: ${e.message}` }],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'b402_pay',
    'Make a gasless b402 payment through sequencer credits. If no `sessionId` is provided, this tool opens and closes a one-shot session automatically.',
    {
      agentId: z.string().describe('Agent id used for credit debit'),
      merchantId: z.string().describe('Merchant receiving payment'),
      amount: z.string().describe('Amount in USDC (e.g. "0.01")'),
      sessionId: z.string().optional().describe('Optional existing session id'),
      memo: z.string().optional().describe('Optional payment memo'),
    },
    async ({ agentId, merchantId, amount, sessionId, memo }) => {
      try {
        const amountMicros = Math.round(parseFloat(amount) * 1_000_000)
        if (!Number.isFinite(amountMicros) || amountMicros <= 0) {
          throw new Error('Amount must be a positive number')
        }

        let ownedSessionId = sessionId
        if (!ownedSessionId) {
          const opened = await sequencer.openSession(agentId, amountMicros.toString(), 900, merchantId)
          ownedSessionId = opened.sessionId
        }

        const payment = await sequencer.sessionPay(ownedSessionId, merchantId, amountMicros.toString())

        let closeSummary = ''
        if (!sessionId) {
          const closed = await sequencer.closeSession(ownedSessionId)
          closeSummary =
            `\nSession closed: ${ownedSessionId}` +
            `\nSpent: $${formatUsdMicros(closed.spentMicros)} ${PAYMENT_TOKEN}` +
            `\nRefunded: $${formatUsdMicros(closed.refundedMicros)} ${PAYMENT_TOKEN}`
        }

        return {
          content: [{
            type: 'text',
            text:
              `Payment sent.\n` +
              `Merchant: ${merchantId}\n` +
              `Amount: $${amount} ${PAYMENT_TOKEN}\n` +
              `Auth ID: ${payment.authId}\n` +
              `${memo ? `Memo: ${memo}\n` : ''}` +
              `Remaining session credits: $${formatUsdMicros(payment.remainingMicros)} ${PAYMENT_TOKEN}` +
              closeSummary,
          }],
        }
      } catch (e: any) {
        return {
          content: [{ type: 'text', text: `Error: ${e.message}` }],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'pay_via_b402',
    'Standard HTTP 402 flow (request -> payment required -> sign authorization -> retry). Supports Base and BNB payment requirements; auto-funding currently supports Base only.',
    {
      url: z.string().describe('Paid HTTP endpoint URL'),
      method: z.string().optional().default('GET').describe('HTTP method'),
      body: z.string().optional().describe('Optional request body (JSON string for POST/PUT/PATCH)'),
      headers: z.record(z.string()).optional().describe('Optional request headers'),
      maxAmountRaw: z.string().optional().describe('Optional max payment amount in token base units'),
      fundIfNeeded: z.boolean().optional().default(true).describe('Auto-fund incognito wallet when insufficient balance'),
      fundingAmountUsdc: z.string().optional().default('5.00').describe('Default Base USDC top-up amount'),
    },
    async ({ url, method, body, headers, maxAmountRaw, fundIfNeeded, fundingAmountUsdc }) => {
      try {
        const { ethers } = await import('ethers')
        const b402 = getB402()
        const normalizedMethod = method.toUpperCase()
        const baseHeaders = new Headers(headers ?? {})

        const first = await fetch(url, {
          method: normalizedMethod,
          headers: baseHeaders,
          body: body,
        })

        if (first.status !== 402) {
          const text = await first.text()
          return {
            content: [{
              type: 'text',
              text:
                `No payment required. Response status: ${first.status}\n` +
                `Response body:\n${text}`,
            }],
          }
        }

        const requirement = await extractPaymentRequirement(first)
        if (!requirement) {
          const raw = await first.text()
          throw new Error(`Got 402 but could not parse payment requirement. Body: ${raw}`)
        }

        const requiredAmount = BigInt(requirement.amount)
        if (maxAmountRaw && requiredAmount > BigInt(maxAmountRaw)) {
          throw new Error(`Required amount ${requirement.amount} exceeds maxAmountRaw ${maxAmountRaw}`)
        }

        const isBase = ['base-mainnet', 'eip155:8453', 'base'].includes(requirement.network)
        const isBnb = ['bnb-mainnet', 'eip155:56', 'bnb'].includes(requirement.network)
        const chainId = isBnb ? 56 : 8453
        const rpcUrl = isBnb ? DEFAULT_BNB_RPC : DEFAULT_BASE_RPC

        const incognitoAddress = await b402.getIncognitoAddress()
        const provider = new ethers.JsonRpcProvider(rpcUrl)
        const token = new ethers.Contract(requirement.asset, ['function balanceOf(address) view returns (uint256)'], provider)
        const tokenBalance: bigint = await token.balanceOf(incognitoAddress)

        let fundingSummary = 'No funding needed'
        if (tokenBalance < requiredAmount) {
          if (!fundIfNeeded) {
            throw new Error(`Insufficient balance (${tokenBalance}) for required payment (${requiredAmount}) and fundIfNeeded=false`)
          }
          if (!isBase) {
            throw new Error(`Auto-funding is currently Base-only. Requirement network: ${requirement.network}`)
          }

          const usdcTopUp = ethers.parseUnits(fundingAmountUsdc, 6)
          const doubled = requiredAmount * 2n
          const topUpRaw = usdcTopUp > doubled ? usdcTopUp : doubled
          const topUpHuman = ethers.formatUnits(topUpRaw, 6)
          const funded = await b402.fundIncognito({ token: PAYMENT_TOKEN, amount: topUpHuman })
          fundingSummary = `Funded ${topUpHuman} USDC on Base (tx: https://basescan.org/tx/${funded.txHash})`
        }

        const signer = await b402.getIncognitoSigner()
        const now = Math.floor(Date.now() / 1000)
        const validAfter = now - 600
        const validBefore = now + (requirement.maxTimeoutSeconds || 3600)
        const nonce = '0x' + Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('hex')

        const domain = {
          name: requirement.extra?.name ?? 'USD Coin',
          version: requirement.extra?.version ?? '2',
          chainId,
          verifyingContract: requirement.asset,
        }
        const types = {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        }
        const message = {
          from: signer.address,
          to: requirement.payTo,
          value: requiredAmount,
          validAfter: BigInt(validAfter),
          validBefore: BigInt(validBefore),
          nonce,
        }
        const signature = await signer.signTypedData(domain, types, message)

        const payload = {
          x402Version: requirement.x402Version ?? 2,
          accepted: requirement,
          payload: {
            authorization: {
              from: signer.address,
              to: requirement.payTo,
              value: requirement.amount,
              validAfter: validAfter.toString(),
              validBefore: validBefore.toString(),
              nonce,
            },
            signature,
          },
        }
        const paymentHeader = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
        const headerName = getPaymentSignatureHeaderName(requirement.x402Version ?? 1)

        const retryHeaders = new Headers(baseHeaders)
        retryHeaders.set(headerName, paymentHeader)

        const retried = await fetch(url, {
          method: normalizedMethod,
          headers: retryHeaders,
          body: body,
        })

        const retriedBody = await retried.text()
        return {
          content: [{
            type: 'text',
            text:
              `pay_via_b402 complete\n` +
              `Initial status: 402\n` +
              `Network: ${requirement.network}\n` +
              `Asset: ${requirement.asset}\n` +
              `Amount (raw): ${requirement.amount}\n` +
              `Funding: ${fundingSummary}\n` +
              `Retry status: ${retried.status}\n` +
              `Response body:\n${retriedBody}`,
          }],
        }
      } catch (e: any) {
        return {
          content: [{ type: 'text', text: `Error: ${e.message}` }],
          isError: true,
        }
      }
    },
  )
}
