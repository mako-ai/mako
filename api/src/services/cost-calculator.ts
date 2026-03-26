/**
 * LLM Cost Calculator
 *
 * Computes USD cost from token usage using live pricing from the
 * Vercel AI Gateway API (cached in memory).
 */

import {
  lookupPricing,
  type PricingRow,
  type TokenType,
} from "./gateway-pricing.service";

export type { TokenType, PricingRow };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DetailedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  inputTokenDetails?: {
    noCacheTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  outputTokenDetails?: {
    textTokens: number;
    reasoningTokens: number;
  };
}

export interface StepUsage {
  modelId: string;
  tokens: DetailedTokenUsage;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function priceFor(
  rows: PricingRow[],
  tokenType: TokenType,
): number | undefined {
  return rows.find(r => r.tokenType === tokenType)?.pricePerMillion;
}

// ---------------------------------------------------------------------------
// Cost computation
// ---------------------------------------------------------------------------

/**
 * Compute the cost (USD) for a set of token counts using the given pricing rows.
 * When detailed cache breakdown is available, the input cost is split into
 * uncached, cache-read, and cache-write portions.
 */
export function computeCostFromTokens(
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  },
  pricing: PricingRow[],
): number {
  if (pricing.length === 0) return 0;

  let cost = 0;

  // --- Input side ---
  const inputPrice = priceFor(pricing, "input");
  const cacheReadPrice = priceFor(pricing, "cache_read");
  const cacheWritePrice = priceFor(pricing, "cache_write");

  const hasCacheBreakdown =
    (tokens.cacheReadTokens ?? 0) > 0 || (tokens.cacheWriteTokens ?? 0) > 0;

  if (hasCacheBreakdown && inputPrice != null) {
    const uncachedTokens =
      tokens.inputTokens -
      (tokens.cacheReadTokens ?? 0) -
      (tokens.cacheWriteTokens ?? 0);
    cost += Math.max(0, uncachedTokens) * (inputPrice / 1_000_000);
    cost +=
      (tokens.cacheReadTokens ?? 0) *
      ((cacheReadPrice ?? inputPrice) / 1_000_000);
    cost +=
      (tokens.cacheWriteTokens ?? 0) *
      ((cacheWritePrice ?? inputPrice) / 1_000_000);
  } else if (inputPrice != null) {
    cost += tokens.inputTokens * (inputPrice / 1_000_000);
  }

  // --- Output side ---
  const outputPrice = priceFor(pricing, "output");
  const reasoningPrice = priceFor(pricing, "reasoning");

  if ((tokens.reasoningTokens ?? 0) > 0 && reasoningPrice != null) {
    const textTokens = tokens.outputTokens - (tokens.reasoningTokens ?? 0);
    cost += Math.max(0, textTokens) * ((outputPrice ?? 0) / 1_000_000);
    cost += (tokens.reasoningTokens ?? 0) * (reasoningPrice / 1_000_000);
  } else if (outputPrice != null) {
    cost += tokens.outputTokens * (outputPrice / 1_000_000);
  }

  return cost;
}

/**
 * Compute cost for a single invocation and optionally fill in per-step costs.
 */
export async function computeInvocationCost(params: {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  steps?: Array<{
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  }>;
}): Promise<{
  totalCostUsd: number;
  steps?: typeof params.steps;
}> {
  const pricing = await lookupPricing(params.modelId);

  if (params.steps && params.steps.length > 0) {
    let total = 0;
    for (const step of params.steps) {
      const stepPricing = await lookupPricing(step.modelId);
      step.costUsd = computeCostFromTokens(
        {
          inputTokens: step.inputTokens,
          outputTokens: step.outputTokens,
          cacheReadTokens: step.cacheReadTokens,
        },
        stepPricing.length > 0 ? stepPricing : pricing,
      );
      total += step.costUsd;
    }
    return { totalCostUsd: total, steps: params.steps };
  }

  const totalCostUsd = computeCostFromTokens(
    {
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cacheReadTokens: params.cacheReadTokens,
      cacheWriteTokens: params.cacheWriteTokens,
      reasoningTokens: params.reasoningTokens,
    },
    pricing,
  );

  return { totalCostUsd };
}
