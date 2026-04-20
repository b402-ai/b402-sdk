/**
 * @b402ai/sdk — Private DeFi execution for agents
 *
 * ZK-proven, gasless, untraceable on Base.
 *
 * ```typescript
 * import { B402 } from '@b402ai/sdk'
 *
 * const b402 = new B402({ privateKey: '0x...' })
 *
 * // Shield tokens into privacy pool
 * await b402.shield({ token: 'USDC', amount: '100' })
 *
 * // Private swap — nobody can trace the funding source
 * await b402.swap({ from: 'USDC', to: 'WETH', amount: '10' })
 *
 * // Earn yield anonymously
 * await b402.lend({ token: 'USDC', amount: '100', vault: 'steakhouse' })
 *
 * // Check positions
 * const status = await b402.status()
 * ```
 */

export { B402 } from './b402'
export type {
  B402Config,
  Call,
  SwapParams,
  SwapResult,
  LendParams,
  LendResult,
  RedeemParams,
  RedeemResult,
  ShieldParams,
  ShieldResult,
  UnshieldParams,
  UnshieldResult,
  FundIncognitoParams,
  FundIncognitoResult,
  ConsolidateResult,
  RebalanceResult,
  StatusResult,
  ProgressEvent,
  PrivateSwapParams,
  PrivateSwapResult,
  PrivateLendParams,
  PrivateLendResult,
  PrivateRedeemParams,
  PrivateRedeemResult,
  SpeedMarketParams,
  SpeedMarketResult,
  OpenPerpParams,
  OpenPerpResult,
  ClosePerpParams,
  ClosePerpResult,
  SynFuturesTradeParams,
  SynFuturesTradeResult,
  SynFuturesCloseParams,
  SynFuturesCloseResult,
  AddLiquidityParams,
  AddLiquidityResult,
  RemoveLiquidityParams,
  RemoveLiquidityResult,
  ClaimRewardsParams,
  ClaimRewardsResult,
  LPPosition,
} from './b402'
export { BASE_TOKENS, BASE_CONTRACTS } from './types'
export { MORPHO_VAULTS } from './lend/morpho-vaults'
export { PERPS_MARKETS, SYNTHETIX_CONTRACTS } from './trade/synthetix-perps'
export { SPEED_MARKETS_CONTRACTS } from './trade/speed-markets'
export { SYNFUTURES_CONTRACTS, SYNFUTURES_INSTRUMENTS } from './trade/synfutures'
export { AERODROME_POOLS } from './lp/aerodrome-pools'
