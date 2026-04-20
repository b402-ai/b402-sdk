/**
 * SynFutures V3 — Perpetual futures on Base
 *
 * Direct ethers v6 integration — no SDK dependency.
 *
 * Flow: Approve USDC → Gate.deposit → Instrument.trade → (close: trade opposite) → Gate.withdraw
 *
 * Architecture:
 *   Gate manages margin deposits/withdrawals across all instruments
 *   Instrument contracts handle trading (one per market type)
 *   Observer provides read-only queries (positions, prices, quotes)
 *   All values inside Instrument use WAD (18 decimals)
 *   Gate deposit/withdraw use the token's native decimals (USDC = 6)
 *
 * Contracts (Base mainnet):
 *   Gate:           0x208B443983D8BcC8578e9D86Db23FbA547071270
 *   Observer:       0xDb166a6E454d2a273Cd50CCD6420703564B2a830
 *   Config:         0xB63902d38738e353f3f52AdD203C418A0bFEa172
 *
 * Encoding:
 *   Gate.deposit(bytes32)    — packs (quantity << 160) | tokenAddress
 *   Instrument.trade(bytes32[2]) — page0: deadline|tick|expiry, page1: size|amount
 */

import { ethers } from 'ethers'

// ── Contract addresses ──────────────────────────────────────────────

export const SYNFUTURES_CONTRACTS = {
  GATE: '0x208B443983D8BcC8578e9D86Db23FbA547071270',
  OBSERVER: '0xDb166a6E454d2a273Cd50CCD6420703564B2a830',
  CONFIG: '0xB63902d38738e353f3f52AdD203C418A0bFEa172',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
} as const

// ── Instrument pair addresses (actual tradeable contracts on Base) ───

export const SYNFUTURES_INSTRUMENTS: Record<string, { address: string; type: string }> = {
  // High-liquidity active perp pairs (status=TRADING, real OI)
  BTC: { address: '0xEC6c44E704Eb1932eC5Fe1E4Aba58db6fee71460', type: 'chainlink' },
  ETH: { address: '0x04d72Fb4803b4E02F14971e5bD092375Eb330749', type: 'chainlink' },
  SOL: { address: '0x3258BaFd35609F5e4064771CbDCf99619465873B', type: 'chainlink' },
}

// ── ABIs (minimal, human-readable) ──────────────────────────────────

const GATE_ABI = [
  'function deposit(bytes32 arg) payable',
  'function withdraw(bytes32 arg)',
  'function reserveOf(address quote, address user) view returns (uint256)',
  'function pendingOf(address quote, address trader) view returns (tuple(uint256 amount, uint256 timestamp))',
  'function allInstrumentsLength() view returns (uint256)',
  'function getAllInstruments() view returns (address[])',
]

const INSTRUMENT_ABI = [
  'function trade(bytes32[2] args) returns (tuple(int128 balance, int128 size, uint128 entryNotional, uint128 entrySocialLossIndex, int128 entryFundingIndex))',
  'function getExpiries() view returns (uint32[])',
  'function inquire(uint32 expiry, int256 size) view returns (tuple(uint256 benchmark, uint160 sqrtFairPX96, int24 tick, uint256 mark, uint256 entryNotional, uint256 fee, uint256 minAmount, uint160 sqrtPostFairPX96, int24 postTick))',
  'function condition() view returns (uint8)',
]

const OBSERVER_ABI = [
  'function getPosition(address instrument, uint32 expiry, address target) view returns (tuple(int128 balance, int128 size, uint128 entryNotional, uint128 entrySocialLossIndex, int128 entryFundingIndex))',
  'function getAmm(address instrument, uint32 expiry) view returns (tuple(uint32 expiry, uint32 timestamp, uint8 status, int24 tick, uint160 sqrtPX96, uint128 liquidity, uint128 totalLiquidity, uint128 totalShort, uint128 openInterests, uint128 totalLong, uint128 involvedFund, uint128 feeIndex, uint128 protocolFee, uint128 longSocialLossIndex, uint128 shortSocialLossIndex, int128 longFundingIndex, int128 shortFundingIndex, uint128 insuranceFund, uint128 settlementPrice))',
  'function getPortfolios(address target, address instrument) view returns (uint32[], tuple(uint48[] oids, uint48[] rids, tuple(int128 balance, int128 size, uint128 entryNotional, uint128 entrySocialLossIndex, int128 entryFundingIndex) position, tuple(uint128 balance, int128 size)[] orders, tuple(uint128 liquidity, uint128 entryFeeIndex, uint96 balance, uint160 sqrtEntryPX96)[] ranges, int256[] ordersTaken)[], tuple(uint32 timestamp, uint32 height))',
  'function inquireByNotional(address instrument, uint32 expiry, uint256 notional, bool long) view returns (int256 size, tuple(uint256 benchmark, uint160 sqrtFairPX96, int24 tick, uint256 mark, uint256 entryNotional, uint256 fee, uint256 minAmount, uint160 sqrtPostFairPX96, int24 postTick))',
]

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]

// ── Constants ───────────────────────────────────────────────────────

/** Perpetual expiry (2^32 - 1 = 0xFFFFFFFF) */
const PERP_EXPIRY = 4294967295

/** Tick bounds for slippage protection */
const MAX_TICK = 443636
const MIN_TICK = -322517

/** Q96 = 2^96, used in sqrtPriceX96 conversions */
const Q96 = 1n << 96n

/** WAD = 10^18 */
const WAD = 10n ** 18n

// ── Types ───────────────────────────────────────────────────────────

export type SynFuturesSide = 'long' | 'short'

export interface SynFuturesOrder {
  /** Instrument key (e.g. 'LINK', 'PYTH') or instrument address */
  instrument: string
  /** Long or short */
  side: SynFuturesSide
  /** Trade size in USDC notional (e.g. '20' = $20 notional) */
  notional: string
  /** USDC margin to deposit (e.g. '10' for 2x leverage on $20 notional) */
  margin: string
  /** Max acceptable slippage in basis points (default: 300 = 3%) */
  slippageBps?: number
}

export interface SynFuturesPosition {
  instrument: string
  instrumentAddress: string
  side: string
  size: string
  balance: string
  entryNotional: string
}

// ── Bytes32 Encoding ────────────────────────────────────────────────

/** Two's complement for signed int24 → uint24 */
function asUint24(x: number): bigint {
  return x < 0 ? BigInt(x + (1 << 24)) : BigInt(x)
}

/** Two's complement for signed int128 → uint128 */
function asUint128(x: bigint): bigint {
  return x < 0n ? x + (1n << 128n) : x
}

/**
 * Encode Gate.deposit / Gate.withdraw parameter.
 * Layout: [96 bits: quantity | 160 bits: token address]
 * Quantity is in the token's native decimals (USDC = 6).
 */
function encodeDepositParam(token: string, quantity: bigint): string {
  const packed = (quantity << 160n) + BigInt(token)
  return ethers.zeroPadValue(ethers.toBeHex(packed), 32)
}

/**
 * Encode Instrument.trade parameter.
 * Returns [page0, page1] where:
 *   page0: [deadline (32 bits) << 56 | tick (24 bits) << 32 | expiry (32 bits)]
 *   page1: [size (128 bits) << 128 | amount (128 bits)]
 *
 * Size and amount are in WAD (18 decimals).
 * Positive size = LONG, negative size = SHORT.
 */
function encodeTradeParam(
  expiry: number,
  size: bigint,
  amount: bigint,
  limitTick: number,
  deadline: number,
): [string, string] {
  const usize = asUint128(size)
  const uAmount = asUint128(amount)
  const uTick = asUint24(limitTick)

  const combinedTick = (uTick << 32n) + BigInt(expiry)
  const combinedDeadline = (BigInt(deadline) << 56n) + combinedTick
  const combinedSize = (usize << 128n) + uAmount

  const page0 = ethers.zeroPadValue(ethers.toBeHex(combinedDeadline), 32)
  const page1 = ethers.zeroPadValue(ethers.toBeHex(combinedSize), 32)
  return [page0, page1]
}

// ── Price Conversions ───────────────────────────────────────────────

/** Convert sqrtPriceX96 to WAD price (18 decimals) */
function sqrtPX96ToWad(sqrtPX96: bigint): bigint {
  const px96 = (sqrtPX96 * sqrtPX96) / Q96
  return (px96 * WAD) / Q96
}

// ── Helpers ─────────────────────────────────────────────────────────

function resolveInstrument(nameOrAddress: string): { address: string; name: string } {
  const upper = nameOrAddress.toUpperCase()
  const entry = SYNFUTURES_INSTRUMENTS[upper]
  if (entry) return { address: entry.address, name: upper }

  // Check if it's a raw address
  if (ethers.isAddress(nameOrAddress)) {
    const found = Object.entries(SYNFUTURES_INSTRUMENTS).find(
      ([, v]) => v.address.toLowerCase() === nameOrAddress.toLowerCase()
    )
    return { address: nameOrAddress, name: found?.[0] ?? nameOrAddress.slice(0, 10) }
  }

  throw new Error(
    `Unknown SynFutures instrument: ${nameOrAddress}. Available: ${Object.keys(SYNFUTURES_INSTRUMENTS).join(', ')}`
  )
}

// ── Call Builders ───────────────────────────────────────────────────

/**
 * Build calls to deposit USDC margin into the SynFutures Gate.
 *
 * Steps:
 *   1. Approve USDC → Gate
 *   2. Gate.deposit(packed(USDC, amount))
 */
export function buildDepositCalls(
  usdcAmount: bigint,
): Array<{ to: string; data: string; value: string }> {
  const erc20 = new ethers.Interface(ERC20_ABI)
  const gate = new ethers.Interface(GATE_ABI)

  const depositArg = encodeDepositParam(SYNFUTURES_CONTRACTS.USDC, usdcAmount)

  return [
    {
      to: SYNFUTURES_CONTRACTS.USDC,
      data: erc20.encodeFunctionData('approve', [SYNFUTURES_CONTRACTS.GATE, usdcAmount]),
      value: '0',
    },
    {
      to: SYNFUTURES_CONTRACTS.GATE,
      data: gate.encodeFunctionData('deposit', [depositArg]),
      value: '0',
    },
  ]
}

/**
 * Build the trade call for opening/modifying a perp position.
 *
 * @param instrumentAddress - The instrument contract address
 * @param size - Trade size in WAD (positive = long, negative = short)
 * @param amount - Margin amount in WAD (how much margin to allocate from Gate reserve)
 * @param limitTick - Slippage limit tick (MAX_TICK for longs, MIN_TICK for shorts)
 * @param deadline - Unix timestamp deadline
 */
export function buildTradeCall(
  instrumentAddress: string,
  size: bigint,
  amount: bigint,
  limitTick: number,
  deadline: number,
): { to: string; data: string; value: string } {
  const instrument = new ethers.Interface(INSTRUMENT_ABI)
  const args = encodeTradeParam(PERP_EXPIRY, size, amount, limitTick, deadline)

  return {
    to: instrumentAddress,
    data: instrument.encodeFunctionData('trade', [args]),
    value: '0',
  }
}

/**
 * Build calls to open a new perp position.
 *
 * Full flow: approve USDC → deposit to Gate → trade on Instrument
 *
 * @param order - Order parameters
 * @param quote - Quote from inquireByNotional (provides size and minAmount)
 */
export function buildOpenPositionCalls(
  order: SynFuturesOrder,
  quote: { size: bigint; minAmount: bigint; tick: number },
): Array<{ to: string; data: string; value: string }> {
  const { address: instrumentAddr } = resolveInstrument(order.instrument)
  const usdcAmount = ethers.parseUnits(order.margin, 6)
  const marginWad = ethers.parseUnits(order.margin, 18) // WAD for instrument

  const slippageBps = order.slippageBps ?? 300
  // For longs: limit tick should be high (accept higher prices)
  // For shorts: limit tick should be low (accept lower prices)
  const limitTick = order.side === 'long' ? MAX_TICK : MIN_TICK

  // Deadline: 5 minutes from now
  const deadline = Math.floor(Date.now() / 1000) + 300

  const calls: Array<{ to: string; data: string; value: string }> = []

  // 1. Approve + deposit USDC into Gate
  calls.push(...buildDepositCalls(usdcAmount))

  // 2. Trade on instrument
  // Size from quote (positive for long, already negative for short)
  const tradeSize = order.side === 'long' ? quote.size : quote.size < 0n ? quote.size : -quote.size
  calls.push(buildTradeCall(instrumentAddr, tradeSize, marginWad, limitTick, deadline))

  return calls
}

/**
 * Build calls to close an existing position.
 *
 * Trade with opposite size, amount = 0 (withdraw all margin after close).
 */
export function buildClosePositionCalls(
  instrumentAddress: string,
  currentSize: bigint,
): Array<{ to: string; data: string; value: string }> {
  // Close by trading the opposite size, amount = 0 to withdraw margin
  const closeSize = -currentSize
  const limitTick = closeSize > 0n ? MAX_TICK : MIN_TICK
  const deadline = Math.floor(Date.now() / 1000) + 300

  return [buildTradeCall(instrumentAddress, closeSize, 0n, limitTick, deadline)]
}

/**
 * Build call to withdraw USDC from Gate back to wallet.
 */
export function buildWithdrawCalls(
  usdcAmount: bigint,
): Array<{ to: string; data: string; value: string }> {
  const gate = new ethers.Interface(GATE_ABI)
  const withdrawArg = encodeDepositParam(SYNFUTURES_CONTRACTS.USDC, usdcAmount)

  return [{
    to: SYNFUTURES_CONTRACTS.GATE,
    data: gate.encodeFunctionData('withdraw', [withdrawArg]),
    value: '0',
  }]
}

// ── Read Functions ──────────────────────────────────────────────────

/**
 * Get a trade quote by notional amount.
 * Returns the size you'd get for a given USD notional, plus fees.
 */
export async function getQuote(
  instrument: string,
  notional: string,
  side: SynFuturesSide,
  provider: ethers.JsonRpcProvider,
): Promise<{
  size: bigint
  benchmark: bigint
  mark: bigint
  fee: bigint
  minAmount: bigint
  tick: number
}> {
  const { address: instrumentAddr } = resolveInstrument(instrument)
  const observer = new ethers.Contract(SYNFUTURES_CONTRACTS.OBSERVER, OBSERVER_ABI, provider)
  const notionalWad = ethers.parseUnits(notional, 18)
  const isLong = side === 'long'

  const [size, quotation] = await observer.inquireByNotional(instrumentAddr, PERP_EXPIRY, notionalWad, isLong)

  return {
    size: size as bigint,
    benchmark: quotation.benchmark as bigint,
    mark: quotation.mark as bigint,
    fee: quotation.fee as bigint,
    minAmount: quotation.minAmount as bigint,
    tick: Number(quotation.tick),
  }
}

/**
 * Get the current AMM state for an instrument (price, liquidity, OI).
 */
export async function getAmmState(
  instrument: string,
  provider: ethers.JsonRpcProvider,
): Promise<{
  priceWad: bigint
  priceUsd: string
  tick: number
  liquidity: bigint
  totalLong: bigint
  totalShort: bigint
  openInterest: bigint
  status: number
}> {
  const { address: instrumentAddr } = resolveInstrument(instrument)
  const observer = new ethers.Contract(SYNFUTURES_CONTRACTS.OBSERVER, OBSERVER_ABI, provider)
  const amm = await observer.getAmm(instrumentAddr, PERP_EXPIRY)

  const sqrtPX96 = amm.sqrtPX96 as bigint
  const priceWad = sqrtPX96ToWad(sqrtPX96)

  return {
    priceWad,
    priceUsd: ethers.formatEther(priceWad),
    tick: Number(amm.tick),
    liquidity: amm.liquidity as bigint,
    totalLong: amm.totalLong as bigint,
    totalShort: amm.totalShort as bigint,
    openInterest: amm.openInterests as bigint,
    status: Number(amm.status),
  }
}

/**
 * Get user's position on a specific instrument.
 */
export async function getPosition(
  instrument: string,
  wallet: string,
  provider: ethers.JsonRpcProvider,
): Promise<SynFuturesPosition | null> {
  const { address: instrumentAddr, name } = resolveInstrument(instrument)
  const observer = new ethers.Contract(SYNFUTURES_CONTRACTS.OBSERVER, OBSERVER_ABI, provider)

  const pos = await observer.getPosition(instrumentAddr, PERP_EXPIRY, wallet)
  const size = pos.size as bigint

  if (size === 0n) return null

  return {
    instrument: name,
    instrumentAddress: instrumentAddr,
    side: size > 0n ? 'long' : 'short',
    size: ethers.formatEther(size),
    balance: ethers.formatEther(pos.balance as bigint),
    entryNotional: ethers.formatEther(pos.entryNotional as bigint),
  }
}

/**
 * Get user's Gate reserve (deposited margin not yet allocated).
 */
export async function getGateReserve(
  wallet: string,
  provider: ethers.JsonRpcProvider,
): Promise<bigint> {
  const gate = new ethers.Contract(SYNFUTURES_CONTRACTS.GATE, GATE_ABI, provider)
  return gate.reserveOf(SYNFUTURES_CONTRACTS.USDC, wallet) as Promise<bigint>
}

/**
 * Get all available instruments from Gate.
 */
export async function getInstrumentCount(
  provider: ethers.JsonRpcProvider,
): Promise<number> {
  const gate = new ethers.Contract(SYNFUTURES_CONTRACTS.GATE, GATE_ABI, provider)
  const count = await gate.allInstrumentsLength()
  return Number(count)
}
