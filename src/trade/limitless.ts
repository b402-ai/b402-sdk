/**
 * Limitless Exchange — Prediction markets on Base
 *
 * Direct ethers v6 integration — no SDK dependency.
 * Limitless is a Polymarket fork using Gnosis Conditional Tokens Framework (CTF).
 *
 * Architecture:
 *   - CTF Exchange: order book settlement (EIP-712 signed orders)
 *   - Conditional Tokens: ERC-1155 outcome tokens (YES/NO)
 *   - REST API for order submission + market browsing
 *   - On-chain: split/merge/redeem positions, verify holdings
 *
 * Flow to BUY YES shares:
 *   1. Approve USDC → CTF Exchange
 *   2. Sign EIP-712 order (BUY, tokenId=YES, price, amount)
 *   3. Submit to API (FOK for market order, GTC for limit)
 *   4. Exchange matches + settles on-chain
 *   5. You now hold YES tokens (ERC-1155)
 *
 * Flow when market resolves:
 *   - If YES wins → redeem YES tokens → get $1/share USDC
 *   - If NO wins → YES tokens worth $0
 *
 * Contracts (Base mainnet):
 *   CTF Exchange v3:      0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5
 *   Conditional Tokens:   0xC9c98965297Bc527861c898329Ee280632B76e18
 *   NegRisk Exchange v3:  0xe3E00BA3a9888d1DE4834269f62ac008b4BB5C47
 *   NegRisk Adapter v3:   0x6151EF8368b6316c1aa3C68453EF083ad31E712D
 *   USDC:                 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 */

import { ethers } from 'ethers'

// ── Contract addresses ──────────────────────────────────────────────

export const LIMITLESS_CONTRACTS = {
  CTF_EXCHANGE: '0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5',
  CONDITIONAL_TOKENS: '0xC9c98965297Bc527861c898329Ee280632B76e18',
  NEGRISK_EXCHANGE: '0xe3E00BA3a9888d1DE4834269f62ac008b4BB5C47',
  NEGRISK_ADAPTER: '0x6151EF8368b6316c1aa3C68453EF083ad31E712D',
  WRAPPED_COLLATERAL: '0xBd8Ff5Ac78A3739037FEaA18278cC157C4798B01',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
} as const

const API_BASE = 'https://api.limitless.exchange'

// ── ABIs ────────────────────────────────────────────────────────────

const CTF_EXCHANGE_ABI = [
  'function getCtf() view returns (address)',
  'function getCollateral() view returns (address)',
  'function paused() view returns (bool)',
  'function domainSeparator() view returns (bytes32)',
  'function nonces(address) view returns (uint256)',
  'function getComplement(uint256 token) view returns (uint256)',
  'function getConditionId(uint256 token) view returns (bytes32)',
]

const CONDITIONAL_TOKENS_ABI = [
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function balanceOfBatch(address[] owners, uint256[] ids) view returns (uint256[])',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function getConditionId(address oracle, bytes32 questionId, uint256 outcomeSlotCount) view returns (bytes32)',
]

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]

// ── EIP-712 ─────────────────────────────────────────────────────────

const EIP712_DOMAIN = {
  name: 'Limitless CTF Exchange',
  version: '1',
  chainId: 8453,
}

const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ],
}

// ── Types ───────────────────────────────────────────────────────────

export interface LimitlessMarket {
  slug: string
  title: string
  conditionId: string
  status: string
  /** [yesPrice, noPrice] — each 0 to 1 */
  prices: [number, number]
  /** YES and NO ERC-1155 token IDs */
  tokens: { yes: string; no: string }
  /** Volume in USDC (formatted) */
  volume: string
  /** Venue exchange contract address */
  exchange: string
  /** NegRisk adapter address (null for simple markets) */
  adapter: string | null
  /** Expiration date */
  expirationDate: string
  /** Market type: 'single' or 'group' */
  marketType: string
  /** Collateral token info */
  collateral: { address: string; decimals: number; symbol: string }
}

export interface LimitlessOrder {
  /** Market slug */
  market: string
  /** Buy YES or NO outcome */
  outcome: 'yes' | 'no'
  /** Amount in USDC to spend */
  amount: string
  /** Price per share (0.01 to 0.99) — for limit orders */
  price?: number
  /** 'FOK' for market order, 'GTC' for limit order (default: 'FOK') */
  orderType?: 'FOK' | 'GTC'
}

export interface LimitlessPosition {
  market: string
  outcome: string
  shares: string
  tokenId: string
  currentPrice: number
  value: string
}

export interface LimitlessBuyResult {
  market: string
  outcome: string
  amount: string
  price: number
  shares: string
  orderSubmitted: boolean
}

// ── API Functions ───────────────────────────────────────────────────

/**
 * Fetch active markets from Limitless API.
 * No API key required.
 */
export async function fetchMarkets(limit = 20): Promise<Array<{ slug: string; deadline: string }>> {
  const res = await fetch(`${API_BASE}/markets/active/slugs`)
  if (!res.ok) throw new Error(`Limitless API error: ${res.status}`)
  const data = (await res.json()) as any[]
  return data.slice(0, limit)
}

/**
 * Fetch full market details by slug.
 * No API key required.
 */
export async function fetchMarket(slug: string): Promise<LimitlessMarket> {
  const res = await fetch(`${API_BASE}/markets/${slug}`)
  if (!res.ok) throw new Error(`Market not found: ${slug}`)
  const d: any = await res.json()

  return {
    slug: d.slug,
    title: d.title,
    conditionId: d.conditionId,
    status: d.status,
    prices: d.prices as [number, number],
    tokens: d.tokens,
    volume: d.volumeFormatted || '0',
    exchange: d.venue?.exchange || LIMITLESS_CONTRACTS.CTF_EXCHANGE,
    adapter: d.venue?.adapter || null,
    expirationDate: d.expirationDate,
    marketType: d.marketType,
    collateral: d.collateralToken || { address: LIMITLESS_CONTRACTS.USDC, decimals: 6, symbol: 'USDC' },
  }
}

/**
 * Search markets by query.
 */
export async function searchMarkets(query: string): Promise<LimitlessMarket[]> {
  const res = await fetch(`${API_BASE}/markets/search?query=${encodeURIComponent(query)}`)
  if (!res.ok) return []
  const json = (await res.json()) as any
  const data = (json.markets || json) as any[]
  return data.map((d: any) => ({
    slug: d.slug,
    title: d.title,
    conditionId: d.conditionId || '',
    status: d.status || '',
    prices: d.prices || [0, 0],
    tokens: d.tokens || { yes: '', no: '' },
    volume: d.volumeFormatted || '0',
    exchange: d.venue?.exchange || LIMITLESS_CONTRACTS.CTF_EXCHANGE,
    adapter: d.venue?.adapter || null,
    expirationDate: d.expirationDate || '',
    marketType: d.marketType || 'single',
    collateral: d.collateralToken || { address: LIMITLESS_CONTRACTS.USDC, decimals: 6, symbol: 'USDC' },
  }))
}

// ── User Profile & Fee Rate ─────────────────────────────────────────

/**
 * Get the fee rate (in bps) for a wallet address from their Limitless profile.
 * Default is 300 bps (3%) for Bronze rank.
 */
export async function getFeeRate(account: string): Promise<number> {
  try {
    const res = await fetch(`${API_BASE}/profiles/public/${ethers.getAddress(account)}`)
    if (!res.ok) return 300 // default
    const data = await res.json() as any
    return data.rank?.feeRateBps ?? 300
  } catch {
    return 300
  }
}

// ── Order Building & Signing ────────────────────────────────────────

/**
 * Build and sign a Limitless order using EIP-712.
 *
 * @param wallet - ethers Wallet (must have signing capability)
 * @param market - Market data from fetchMarket()
 * @param params - Order parameters
 * @param nonce - Current nonce from exchange contract
 */
export async function buildSignedOrder(
  wallet: ethers.Wallet,
  market: LimitlessMarket,
  params: LimitlessOrder,
  nonce: bigint,
): Promise<{
  signedOrder: Record<string, any>
  price: number
  shares: string
}> {
  const amount = parseFloat(params.amount)
  const tokenId = params.outcome === 'yes' ? market.tokens.yes : market.tokens.no
  const priceIndex = params.outcome === 'yes' ? 0 : 1

  // Price: use specified price for GTC, or current market price for FOK
  const price = params.price ?? market.prices[priceIndex]
  if (price <= 0 || price >= 1) {
    throw new Error(`Invalid price: ${price}. Must be between 0.01 and 0.99`)
  }

  // Fetch user's fee rate from their profile
  const feeRateBps = await getFeeRate(wallet.address)

  // Calculate shares and amounts
  // CLOB: for FOK, takerAmount=1 (unit share), makerAmount=price in USDC units
  const sharesFloat = amount / price
  const makerAmountRaw = BigInt(Math.round(price * 1e6))
  const takerAmountRaw = 1n

  // BUY: maker provides USDC (makerAmount), wants shares (takerAmount)
  const side = 0 // BUY

  const salt = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))
  const maker = ethers.getAddress(wallet.address) // checksummed

  const orderData = {
    salt,
    maker,
    signer: maker,
    taker: ethers.ZeroAddress,
    tokenId: BigInt(tokenId),
    makerAmount: makerAmountRaw,
    takerAmount: takerAmountRaw,
    expiration: 0n, // never expires
    nonce,
    feeRateBps: BigInt(feeRateBps),
    side,
    signatureType: 0, // EOA
  }

  const domain = {
    ...EIP712_DOMAIN,
    verifyingContract: market.exchange as `0x${string}`,
  }

  const signature = await wallet.signTypedData(domain, ORDER_TYPES, orderData)

  const signedOrder: Record<string, any> = {
    salt: Number(orderData.salt),
    maker,
    signer: maker,
    taker: ethers.ZeroAddress,
    tokenId: tokenId.toString(),
    makerAmount: Number(orderData.makerAmount),
    takerAmount: Number(orderData.takerAmount),
    expiration: "0",
    nonce: Number(nonce),
    feeRateBps,
    side,
    signatureType: 0,
    signature,
  }

  return {
    signedOrder,
    price,
    shares: (sharesFloat).toFixed(2),
  }
}

/**
 * Submit a signed order to the Limitless API.
 *
 * @param apiKey - Limitless API key (starts with 'lmts_')
 * @param marketSlug - Market slug
 * @param signedOrder - The signed order from buildSignedOrder()
 * @param orderType - 'FOK' for market order, 'GTC' for limit order
 */
/**
 * Get the Limitless user ID for a wallet address.
 * Uses the public profile endpoint — no auth needed.
 */
export async function getOwnerId(account: string): Promise<number> {
  const res = await fetch(`${API_BASE}/profiles/public/${ethers.getAddress(account)}`)
  if (!res.ok) throw new Error(`Failed to get profile for ${account}: ${res.status}`)
  const data = await res.json() as any
  return data.id
}

export async function submitOrder(
  apiKey: string,
  marketSlug: string,
  signedOrder: Record<string, any>,
  orderType: 'FOK' | 'GTC' = 'FOK',
): Promise<{ success: boolean; data?: any; error?: string }> {
  // Get ownerId from public profile
  const ownerId = await getOwnerId(signedOrder.maker)

  const body: any = {
    order: signedOrder,
    orderType,
    marketSlug,
    ownerId,
  }

  // Add price for GTC orders
  if (orderType === 'GTC' && signedOrder.makerAmount && signedOrder.takerAmount) {
    body.price = signedOrder.makerAmount / signedOrder.takerAmount
  }

  const res = await fetch(`${API_BASE}/orders`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
      'x-account': signedOrder.maker,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text()
    return { success: false, error: `${res.status}: ${text}` }
  }

  const data = await res.json()
  return { success: true, data }
}

// ── On-Chain Functions ──────────────────────────────────────────────

/**
 * Build the USDC approval call for the CTF Exchange.
 */
export function buildApprovalCalls(
  usdcAmount: bigint,
  exchange: string = LIMITLESS_CONTRACTS.CTF_EXCHANGE,
): Array<{ to: string; data: string; value: string }> {
  const erc20 = new ethers.Interface(ERC20_ABI)
  return [{
    to: LIMITLESS_CONTRACTS.USDC,
    data: erc20.encodeFunctionData('approve', [exchange, usdcAmount]),
    value: '0',
  }]
}

/**
 * Build the setApprovalForAll call for conditional tokens.
 * Required before selling positions.
 */
export function buildCtfApprovalCalls(
  exchange: string = LIMITLESS_CONTRACTS.CTF_EXCHANGE,
): Array<{ to: string; data: string; value: string }> {
  const ctf = new ethers.Interface(CONDITIONAL_TOKENS_ABI)
  return [{
    to: LIMITLESS_CONTRACTS.CONDITIONAL_TOKENS,
    data: ctf.encodeFunctionData('setApprovalForAll', [exchange, true]),
    value: '0',
  }]
}

/**
 * Build calls to redeem winning positions after market resolution.
 */
export function buildRedeemCalls(
  conditionId: string,
): Array<{ to: string; data: string; value: string }> {
  const ctf = new ethers.Interface(CONDITIONAL_TOKENS_ABI)
  return [{
    to: LIMITLESS_CONTRACTS.CONDITIONAL_TOKENS,
    data: ctf.encodeFunctionData('redeemPositions', [
      LIMITLESS_CONTRACTS.USDC,
      ethers.ZeroHash, // parentCollectionId
      conditionId,
      [1, 2], // both outcome slots
    ]),
    value: '0',
  }]
}

/**
 * Get the user's nonce from the CTF Exchange contract.
 */
export async function getNonce(
  wallet: string,
  provider: ethers.JsonRpcProvider,
  exchange: string = LIMITLESS_CONTRACTS.CTF_EXCHANGE,
): Promise<bigint> {
  const contract = new ethers.Contract(exchange, CTF_EXCHANGE_ABI, provider)
  return contract.nonces(wallet) as Promise<bigint>
}

/**
 * Get the user's position (YES/NO token balances) for a market.
 */
export async function getPositions(
  wallet: string,
  market: LimitlessMarket,
  provider: ethers.JsonRpcProvider,
): Promise<{ yes: string; no: string; yesValue: string; noValue: string }> {
  const ctf = new ethers.Contract(LIMITLESS_CONTRACTS.CONDITIONAL_TOKENS, CONDITIONAL_TOKENS_ABI, provider)

  const [yesBal, noBal] = await ctf.balanceOfBatch(
    [wallet, wallet],
    [market.tokens.yes, market.tokens.no],
  ) as [bigint, bigint]

  const yesShares = Number(yesBal) / 1e6
  const noShares = Number(noBal) / 1e6

  return {
    yes: yesShares.toFixed(2),
    no: noShares.toFixed(2),
    yesValue: (yesShares * market.prices[0]).toFixed(2),
    noValue: (noShares * market.prices[1]).toFixed(2),
  }
}

/**
 * Check if a market has been resolved.
 */
export async function isResolved(
  conditionId: string,
  provider: ethers.JsonRpcProvider,
): Promise<boolean> {
  const ctf = new ethers.Contract(LIMITLESS_CONTRACTS.CONDITIONAL_TOKENS, CONDITIONAL_TOKENS_ABI, provider)
  const denom = await ctf.payoutDenominator(conditionId) as bigint
  return denom > 0n
}
