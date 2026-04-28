import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getB402, SUPPORTED_CHAINS, MORPHO_CHAINS } from '../lib/b402-client.js'
import { log } from '../lib/logger.js'

const basescan = (hash: string) => `https://basescan.org/tx/${hash}`

function explorerTxLink(chainId: number, hash: string): string {
  switch (chainId) {
    case 8453: return `https://basescan.org/tx/${hash}`
    case 42161: return `https://arbiscan.io/tx/${hash}`
    case 56: return `https://bscscan.com/tx/${hash}`
    default: return hash
  }
}

const TOKENS: Record<string, { address: string; decimals: number }> = {
  USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  DAI:  { address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', decimals: 18 },
  AERO: { address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18 },
  USDT: { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', decimals: 6 },
}

const CHAIN_ENUM = ['base', 'arbitrum', 'bsc'] as const
const MORPHO_CHAIN_ENUM = ['base', 'arbitrum'] as const

export function registerPrivacyTools(server: McpServer) {

  server.tool(
    'shield_usdc',
    'Move tokens from the wallet into the Railgun privacy pool. Once shielded, tokens are ZK-encrypted as UTXOs — invisible on-chain. This is the entry point for all private operations. Takes ~30-60 seconds for the shield TX + indexing. Supported on Base, Arbitrum, BSC — pass `chain` to pick.',
    {
      amount: z.string().describe('Amount to shield (e.g. "10")'),
      token: z.string().optional().default('USDC').describe('Token to shield'),
      chain: z.enum(CHAIN_ENUM).optional().default('base').describe('Chain to shield on. Default: base.'),
    },
    async ({ amount, token, chain }) => {
      log('tool=shield_usdc start', { amount, token, chain })
      try {
        const b402 = getB402(chain)
        const result = await b402.shield({ token, amount })
        log('tool=shield_usdc ok', { chainId: b402.chainId, txHash: result.txHash, indexed: result.indexed })
        return { content: [{ type: 'text', text:
          `Shielded ${amount} ${token} into ${chain} privacy pool.\n` +
          `TX: ${explorerTxLink(b402.chainId, result.txHash)}\n` +
          `Indexed: ${result.indexed}`
        }] }
      } catch (e: any) {
        log('tool=shield_usdc error', { message: e.message })
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'check_pool_balance',
    'Check all balances across Base, Arbitrum, and BSC: wallet (public), privacy pool (shielded ZK-encrypted), Morpho vault positions (Base+Arb), and Aerodrome LP (Base only). Privacy pool decrypted client-side. Pass `chain` to scope to one chain.',
    {
      chain: z.enum(CHAIN_ENUM).optional().describe('Optional: scope to one chain. Default queries all 3.'),
    },
    async ({ chain }) => {
      log('tool=check_pool_balance start', { chain: chain ?? 'all' })
      const _bal_t0 = Date.now()
      try {
        const targets = chain
          ? SUPPORTED_CHAINS.filter((c) => c.name === chain)
          : SUPPORTED_CHAINS

        const reports = await Promise.all(
          targets.map(async (c) => {
            try {
              const b402 = getB402(c.chainId)
              const s = await b402.status()
              return { chain: c.name, status: s, ok: true as const }
            } catch (e: any) {
              return { chain: c.name, ok: false as const, error: e.message }
            }
          }),
        )

        const okReport = reports.find((r) => r.ok)
        const sw = okReport?.ok ? okReport.status.smartWallet : '(unavailable)'

        const lines: string[] = [`Incognito Wallet: ${sw}`, `(same address on all chains)`, '']

        for (const r of reports) {
          lines.push(`── ${r.chain.toUpperCase()} ──`)
          if (!r.ok) {
            lines.push(`  error: ${r.error}`)
            lines.push('')
            continue
          }
          const s = r.status
          if (s.balances.length > 0) {
            lines.push('  Wallet:')
            for (const b of s.balances) lines.push(`    ${b.token}: ${b.balance}`)
          } else {
            lines.push('  Wallet: empty')
          }
          if (s.shieldedBalances.length > 0) {
            const nonZero = s.shieldedBalances.filter((b) => parseFloat(b.balance) > 0)
            if (nonZero.length > 0) {
              lines.push('  Privacy Pool:')
              for (const b of nonZero) lines.push(`    ${b.token}: ${b.balance}`)
            } else {
              lines.push('  Privacy Pool: empty')
            }
          } else {
            lines.push('  Privacy Pool: empty')
          }
          if (s.positions.length > 0) {
            lines.push('  Yield Positions:')
            for (const p of s.positions)
              lines.push(`    ${p.vault}: ${p.assets} (${p.apyEstimate} APY)`)
          }
          if (s.lpPositions.length > 0) {
            lines.push('  LP Positions:')
            for (const lp of s.lpPositions)
              lines.push(`    ${lp.pool}: $${lp.usdValue} (${lp.apyEstimate} APY)`)
          }
          lines.push('')
        }

        log('tool=check_pool_balance ok', { chains: reports.map((r) => r.chain), ms: Date.now() - _bal_t0 })
        return { content: [{ type: 'text', text: lines.join('\n').trimEnd() }] }
      } catch (e: any) {
        log('tool=check_pool_balance error', { message: e.message })
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
      log('tool=private_swap start', { from, to, amount })
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
    'Deposit USDC from the privacy pool into a yield-earning protocol. Two protocols supported: (a) Morpho ERC-4626 MetaMorpho vaults — Steakhouse, Moonwell (Base), Gauntlet, Steakhouse High Yield. (b) Aave V3 — much larger TVL, native USDC market on both Base and Arbitrum; aToken interest accrued *while shielded* leaks to the protocol vault (sub-bps for short holds, documented). Uses ZK proof via RelayAdapt — deposit is real, no wallet linked. Receipt token (vault shares or aToken) shielded back into pool. Takes ~15-30 seconds.',
    {
      amount: z.string().describe('Amount to lend in USDC'),
      protocol: z.enum(['morpho', 'aave']).optional().default('morpho').describe('Protocol: morpho (default) or aave.'),
      vault: z.string().optional().describe('Morpho vault key (default: steakhouse-hy). Base: steakhouse | moonwell | gauntlet | steakhouse-hy. Arb: steakhouse-hy | steakhouse | gauntlet | gauntlet-prime. Ignored when protocol=aave.'),
      market: z.string().optional().describe('Aave market key (default: usdc). Ignored when protocol=morpho.'),
      chain: z.enum(MORPHO_CHAIN_ENUM).optional().default('base').describe('Chain for the lend op. Base or Arbitrum.'),
    },
    async ({ amount, protocol, vault, market, chain }) => {
      log('tool=lend_privately start', { amount, protocol, vault, market, chain })
      try {
        const b402 = getB402(chain)
        const result = await b402.privateLend({
          token: 'USDC',
          amount,
          protocol,
          vault: vault ?? 'steakhouse-hy',
          market: market ?? 'usdc',
        })
        log('tool=lend_privately ok', { chainId: b402.chainId, txHash: result.txHash, protocol: result.protocol, vault: result.vault })
        return { content: [{ type: 'text', text:
          `Private lend complete on ${chain} via ${result.protocol.toUpperCase()}.\n` +
          `Deposited: ${amount} USDC → ${result.vault}\n` +
          `TX: ${explorerTxLink(b402.chainId, result.txHash)}\n` +
          `Earning yield privately. No wallet linked to position.`
        }] }
      } catch (e: any) {
        log('tool=lend_privately error', { message: e.message })
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
      log('tool=cross_chain_privately start', { toChain, fromToken, toToken, amount, destinationAddress })
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
    'cross_chain_status',
    'Poll the status of a cross-chain transfer kicked off via cross_chain_privately. Returns pending | done | failed plus the destination-chain tx hash once the bridge fills. Pass the source-chain tx hash returned by the original call.',
    {
      txHash: z.string().describe('Source-chain tx hash returned by cross_chain_privately'),
    },
    async ({ txHash }) => {
      log('tool=cross_chain_status start', { txHash })
      try {
        const b402 = getB402()
        const result = await b402.getCrossChainStatus(txHash)
        log('tool=cross_chain_status ok', { status: result.status, dest: result.destTxHash })
        const lines = [
          `Status:   ${result.status}`,
          result.substatus ? `Sub:      ${result.substatus}` : null,
          `Source:   ${result.srcTxHash ?? txHash}`,
          result.destTxHash ? `Dest TX:  ${result.destTxHash}` : 'Dest TX:  (not filled yet)',
        ].filter((l): l is string => l !== null)
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      } catch (e: any) {
        log('tool=cross_chain_status error', { message: e.message })
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )

  server.tool(
    'redeem_privately',
    'Withdraw a yield position back to the privacy pool. Works for both Morpho vault shares and Aave V3 aToken positions — pass the same `protocol` you used for lend_privately. Burns the receipt token (shielded in pool), redeems underlying USDC, shields back. Supported on Base + Arbitrum. Takes ~15-30 seconds.',
    {
      protocol: z.enum(['morpho', 'aave']).optional().default('morpho').describe('Protocol: morpho (default) or aave. Must match the lend_privately call.'),
      vault: z.string().optional().describe('Morpho vault key (default: steakhouse-hy). Ignored when protocol=aave.'),
      market: z.string().optional().describe('Aave market key (default: usdc). Ignored when protocol=morpho.'),
      chain: z.enum(MORPHO_CHAIN_ENUM).optional().default('base').describe('Chain for the redeem op. Must match where lend_privately was called.'),
    },
    async ({ protocol, vault, market, chain }) => {
      log('tool=redeem_privately start', { protocol, vault, market, chain })
      try {
        const b402 = getB402(chain)
        const result = await b402.privateRedeem({
          protocol,
          vault: vault ?? 'steakhouse-hy',
          market: market ?? 'usdc',
        })
        log('tool=redeem_privately ok', { chainId: b402.chainId, txHash: result.txHash, protocol: result.protocol, assetsReceived: result.assetsReceived })
        return { content: [{ type: 'text', text:
          `Private redeem complete on ${chain} via ${result.protocol.toUpperCase()}.\n` +
          `Received: ${result.assetsReceived} USDC → privacy pool\n` +
          `Position: ${result.vault}\n` +
          `TX: ${explorerTxLink(b402.chainId, result.txHash)}`
        }] }
      } catch (e: any) {
        log('tool=redeem_privately error', { message: e.message })
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }
      }
    }
  )
}
