/**
 * Base Recipe — Abstract recipe class for all worker operations
 *
 * Recipes are deterministic pipelines that execute a specific DeFi operation
 * from a Railgun shielded balance. Each recipe:
 *   1. Validates inputs against policy
 *   2. Builds the operation (proof + multicall)
 *   3. Submits the UserOp
 *   4. Returns a structured receipt
 */

import type { ExecutionReceipt, RecipeConfig, WorkerConfig } from '../types'

export interface RecipeContext {
  config: WorkerConfig
  smartWalletAddress: string
  nonce: bigint
  isWalletDeployed: boolean
}

export abstract class BaseRecipe {
  abstract readonly name: string

  /**
   * Execute the recipe pipeline.
   * @returns Structured receipt with tx hashes, fees, and status
   */
  abstract execute(
    recipeConfig: RecipeConfig,
    context: RecipeContext,
  ): Promise<ExecutionReceipt>
}
