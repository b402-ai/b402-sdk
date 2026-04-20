import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getB402 } from '../lib/b402-client.js'

const basescan = (hash: string) => `https://basescan.org/tx/${hash}`

const TOKENS: Record<string, { address: string; decimals: number }> = {
  USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  DAI:  { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
  AERO: { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18 },
  USDT: { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
}

export function registerPrivacyTools(server: McpServer) {

  server.tool(
    'shield_usdc',
    'Move tokens from the wallet into the Railgun privacy pool. Once shielded, tokens are ZK-encrypted as UTXOs — invisible on-chain. This is the entry point for all private operations (swap, lend, strategy). Takes ~30-60 seconds for the shield TX + indexing.',
    {
      amount: z.string().describe('Amount to shield (e.g. "10")'),
      token: z.string().optional().default('USDC').describe('Token to shield'),
    },
    async ({ amount, token }) => {
      try {
        const b402 = getB402()
        const result = await b402.shield({ token, amount })
        return { content: [{ type: 'text', text:
          `Shielded ${amount} ${token} into privacy pool.\n` +
          `TX: ${basescan(result.txHash)}\n` +
          `Indexed: ${result.indexed}`
        }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'check_pool_balance',
    'Check all balances: wallet (public), privacy pool (shielded ZK-encrypted tokens), Morpho vault positions (yield), and Aerodrome LP positions. The privacy pool balance is decrypted client-side using the private key — only the owner can see it.',
    {},
    async () => {
      try {
        const b402 = getB402()
        const s = await b402.status()
        const lines: string[] = [
          `Incognito Wallet: ${s.smartWallet}`,
          `Deployed: ${s.deployed}`,
          '',
        ]

        if (s.balances.length > 0) {
          lines.push('Wallet:')
          for (const b of s.balances) lines.push(`  ${b.token}: ${b.balance}`)
        } else {
          lines.push('Wallet: empty')
        }

        lines.push('')
        if (s.shieldedBalances.length > 0) {
          lines.push('Privacy Pool:')
          for (const b of s.shieldedBalances) {
            if (parseFloat(b.balance) > 0) lines.push(`  ${b.token}: ${b.balance}`)
          }
        } else {
          lines.push('Privacy Pool: empty')
        }

        if (s.positions.length > 0) {
          lines.push('')
          lines.push('Yield Positions:')
          for (const p of s.positions) lines.push(`  ${p.vault}: ${p.assets} (${p.apyEstimate} APY)`)
        }

        if (s.lpPositions.length > 0) {
          lines.push('')
          lines.push('LP Positions:')
          for (const lp of s.lpPositions) lines.push(`  ${lp.pool}: $${lp.usdValue} (${lp.apyEstimate} APY)`)
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'get_swap_quote',
    'Get a swap quote via Odos aggregator (routes across ALL DEXes on Base) without executing. Shows expected output, rate, price impact. Use before private_swap to preview. Minimum ~$3.',
    {
      from: z.string().default('USDC').describe('Token to sell (USDC, WETH, DAI, AERO, USDT)'),
      to: z.string().default('WETH').describe('Token to buy'),
      amount: z.string().describe('Amount to swap (e.g. "10")'),
    },
    async ({ from, to, amount }) => {
      try {
        const { ethers } = await import('ethers')

        const tokenIn = TOKENS[from.toUpperCase()]
        const tokenOut = TOKENS[to.toUpperCase()]
        if (!tokenIn) return { content: [{ type: 'text', text: `Unknown token: ${from}. Available: ${Object.keys(TOKENS).join(', ')}` }], isError: true }
        if (!tokenOut) return { content: [{ type: 'text', text: `Unknown token: ${to}. Available: ${Object.keys(TOKENS).join(', ')}` }], isError: true }

        const sellAmount = ethers.parseUnits(amount, tokenIn.decimals)

        // Odos aggregator — routes across ALL DEXes on Base
        const res = await fetch('https://api.odos.xyz/sor/quote/v2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chainId: 8453,
            inputTokens: [{ tokenAddress: tokenIn.address, amount: sellAmount.toString() }],
            outputTokens: [{ tokenAddress: tokenOut.address, proportion: 1 }],
            slippageLimitPercent: 0.5,
            userAddr: '0x0000000000000000000000000000000000000001',
            referralCode: 0,
            disableRFQs: true,
            compact: true,
          }),
        })

        if (!res.ok) throw new Error(`Odos quote failed: ${res.status}`)
        const data = await res.json() as any
        if (!data.outAmounts?.[0]) throw new Error('No route found')

        const amountOut = ethers.formatUnits(BigInt(data.outAmounts[0]), tokenOut.decimals)
        const rate = parseFloat(amountOut) / parseFloat(amount)
        const priceImpact = Math.abs(data.percentDiff || 0)

        const prices: Record<string, number> = { USDC: 1, USDT: 1, DAI: 1, WETH: 2000, AERO: 0.33 }
        const usdIn = (parseFloat(amount) * (prices[from.toUpperCase()] || 0)).toFixed(2)
        const usdOut = (parseFloat(amountOut) * (prices[to.toUpperCase()] || 0)).toFixed(2)

        return { content: [{ type: 'text', text:
          `Swap Quote — Odos (all Base DEXes)\n\n` +
          `Sell:   ${amount} ${from.toUpperCase()} (~$${usdIn})\n` +
          `Buy:    ${amountOut} ${to.toUpperCase()} (~$${usdOut})\n` +
          `Rate:   1 ${from.toUpperCase()} = ${rate.toPrecision(6)} ${to.toUpperCase()}\n` +
          `Impact: ${priceImpact.toFixed(4)}%\n` +
          `Slippage: 0.5%\n\n` +
          `To execute privately (ZK proof, no wallet trace): use private_swap`
        }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error getting quote: ${e.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'private_swap',
    'Execute a token swap inside the Railgun privacy pool using a ZK proof. The swap goes through Aerodrome DEX via RelayAdapt — on-chain, only the relay contract appears. No wallet is linked to the trade. Takes ~15-30 seconds (ZK proof generation + TX). Minimum ~$3.',
    {
      from: z.string().default('USDC').describe('Token to sell'),
      to: z.string().default('WETH').describe('Token to buy'),
      amount: z.string().describe('Amount to swap'),
    },
    async ({ from, to, amount }) => {
      try {
        const b402 = getB402()
        const result = await b402.privateSwap({ from, to, amount, slippageBps: 300 })
        return { content: [{ type: 'text', text:
          `Private swap executed.\n` +
          `Swapped: ${result.amountIn} ${result.tokenIn} → ${result.amountOut} ${result.tokenOut}\n` +
          `TX: ${basescan(result.txHash)}\n` +
          `On-chain: only RelayAdapt visible. No wallet linked.`
        }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'lend_privately',
    'Deposit USDC from the privacy pool into a Morpho ERC-4626 vault to earn yield (~3-4% APY). Uses ZK proof via RelayAdapt — the vault deposit is real (Morpho on Base) but no wallet is linked. Vault shares are shielded back into the pool. Takes ~15-30 seconds.',
    {
      amount: z.string().describe('Amount to lend in USDC'),
      vault: z.string().default('steakhouse').describe('Vault: steakhouse, moonwell, gauntlet'),
    },
    async ({ amount, vault }) => {
      try {
        const b402 = getB402()
        const result = await b402.privateLend({ token: 'USDC', amount, vault })
        return { content: [{ type: 'text', text:
          `Private lend complete.\n` +
          `Deposited: ${amount} USDC → ${result.vault}\n` +
          `TX: ${basescan(result.txHash)}\n` +
          `Earning yield privately. No wallet linked to vault.`
        }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'cross_chain_privately',
    'Private cross-chain send from the Base privacy pool. Covers three flows in one tool: (1) same-token cross-chain transfer (USDC Base -> USDC Arb), (2) cross-chain swap aka bridge+swap (USDC Base -> ARB Arb in one atomic call), (3) cross-chain payment to any address. Unshield + approve + LI.FI Diamond call happen atomically through RelayAdapt on Base — observer sees "someone used LI.FI", no link to the pool. Funds land at the specified destinationAddress on the target chain. LI.FI routes through ~30 bridges and ~20 DEXes (Eco, Across, Stargate, CCTP, NearIntents, etc.). Destination chains currently: arbitrum. Takes 30-90s total (source TX + destination fill). LI.FI protocol fee 0.25%.',
    {
      toChain: z.string().default('arbitrum').describe('Destination chain: arbitrum'),
      fromToken: z.string().default('USDC').describe('Source token on Base (USDC, WETH, DAI)'),
      toToken: z.string().default('USDC').describe('Destination token. Same as fromToken for pure bridge, different for bridge+swap (e.g. ARB on Arbitrum)'),
      amount: z.string().describe('Amount to bridge in human units (e.g. "1" for 1 USDC). Minimum ~$0.50 — smaller may be rejected by bridge tools.'),
      destinationAddress: z.string().describe('Recipient EOA address on the destination chain. Funds land here. Use a fresh address for stronger unlinkability.'),
    },
    async ({ toChain, fromToken, toToken, amount, destinationAddress }) => {
      try {
        const b402 = getB402()
        const result = await b402.privateCrossChain({
          toChain,
          fromToken,
          toToken,
          amount,
          destinationAddress,
        })

        const arbscan = (hash: string) => `https://arbiscan.io/tx/${hash}`
        const lifiScan = (hash: string) => `https://scan.li.fi/tx/${hash}`

        return { content: [{ type: 'text', text:
          `Private bridge submitted on Base.\n\n` +
          `Source TX:    ${basescan(result.txHash)}\n` +
          `LI.FI status: ${lifiScan(result.txHash)}\n` +
          `Tool chosen:  ${result.tool}\n` +
          `Amount in:    ${result.amountIn} ${result.fromToken} (${result.fromChain})\n` +
          `Expected out: ${result.expectedAmountOut} ${result.toToken} (${result.toChain})\n` +
          `Min out:      ${result.minAmountOut} ${result.toToken}\n` +
          `Destination:  ${result.destinationAddress}\n` +
          `ETA:          ~${result.estimatedDurationSec}s\n\n` +
          `Bridge fill will appear on ${result.toChain}. Track via LI.FI scan link above or poll li.quest/v1/status?txHash=${result.txHash}.\n` +
          `On-chain observer on Base sees only RelayAdapt calling LI.FI — not the pool, not you.`
        }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'redeem_privately',
    'Withdraw from a Morpho vault back to the privacy pool. Burns vault shares (shielded in pool), redeems underlying USDC, and shields it back. Requires that shares were deposited via lend_privately. Takes ~15-30 seconds.',
    {
      vault: z.string().default('steakhouse').describe('Vault to redeem from'),
    },
    async ({ vault }) => {
      try {
        const b402 = getB402()
        const result = await b402.privateRedeem({ vault })
        return { content: [{ type: 'text', text:
          `Private redeem complete.\n` +
          `Received: ${result.assetsReceived} USDC → privacy pool\n` +
          `TX: ${basescan(result.txHash)}`
        }] }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )
}
