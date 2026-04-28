import { B402 } from '@b402ai/sdk'
import { getPrivateKey } from './wallet-store.js'

export type SupportedChain = 'base' | 'arbitrum' | 'arb' | 'bsc'

const CHAIN_ID_BY_NAME: Record<SupportedChain, number> = {
  base: 8453,
  arbitrum: 42161,
  arb: 42161,
  bsc: 56,
}

const RPC_ENV: Record<number, string | undefined> = {
  8453: process.env.BASE_RPC_URL,
  42161: process.env.ARB_RPC_URL,
  56: process.env.BSC_RPC_URL,
}

const FACILITATOR_ENV: Record<number, string | undefined> = {
  8453: process.env.FACILITATOR_URL || process.env.BASE_FACILITATOR_URL,
  42161: process.env.ARB_FACILITATOR_URL,
  // BSC facilitator falls back to SDK default if env not set
  56: process.env.BSC_FACILITATOR_URL,
}

const instances = new Map<number, B402>()

export function resolveChainId(chain?: SupportedChain | number): number {
  if (chain === undefined) return 8453 // default Base
  if (typeof chain === 'number') return chain
  const id = CHAIN_ID_BY_NAME[chain.toLowerCase() as SupportedChain]
  if (!id) throw new Error(`Unsupported chain: ${chain}. Use base | arbitrum | bsc.`)
  return id
}

/**
 * Get a per-chain B402 SDK instance. Same private key, different chain config.
 *
 * Cached after first construction. Pass `chain` (name or chainId) to target a
 * specific chain; omit for Base (default).
 */
export function getB402(chain?: SupportedChain | number): B402 {
  const chainId = resolveChainId(chain)
  let instance = instances.get(chainId)
  if (instance) return instance

  const privateKey = getPrivateKey()
  if (!privateKey) {
    throw new Error('No wallet found. Run: npx b402-mcp --claude')
  }

  instance = new B402({
    privateKey,
    chainId,
    rpcUrl: RPC_ENV[chainId],
    facilitatorUrl: FACILITATOR_ENV[chainId],
  })
  instances.set(chainId, instance)
  // Log to stderr so MCP-host log capture shows which chain we resolved.
  // Fires once per chain per process.
  console.error(
    `[b402-mcp] resolved B402 instance for chainId=${chainId} ` +
      `rpc=${instance.rpcUrl} facilitator=${(instance as any).facilitatorUrl} ` +
      `wallet-pending=true`,
  )
  return instance
}

/** Chains b402 supports for balance/shield queries. */
export const SUPPORTED_CHAINS: ReadonlyArray<{ name: SupportedChain; chainId: number }> = [
  { name: 'base', chainId: 8453 },
  { name: 'arbitrum', chainId: 42161 },
  { name: 'bsc', chainId: 56 },
]

/** Chains where Morpho privateLend / privateRedeem are supported. */
export const MORPHO_CHAINS: ReadonlyArray<{ name: SupportedChain; chainId: number }> = [
  { name: 'base', chainId: 8453 },
  { name: 'arbitrum', chainId: 42161 },
]
