/**
 * Gateway Pricing Service
 *
 * Provides detailed per-token-type pricing (input, output, cache_read,
 * cache_write, reasoning) for cost calculation.
 *
 * Consumes raw pricing data from the shared gateway-models cache to avoid
 * duplicate fetches to https://ai-gateway.vercel.sh/v1/models.
 */

import {
  getGatewayRawPricingMap,
  warmModelsCache,
  type GatewayRawPricing,
} from "./gateway-models.service";
import { loggers } from "../logging";

const logger = loggers.app();

// ---------------------------------------------------------------------------
// Internal pricing format (per-million tokens)
// ---------------------------------------------------------------------------

export type TokenType =
  | "input"
  | "cache_read"
  | "cache_write"
  | "output"
  | "reasoning";

export interface PricingRow {
  tokenType: TokenType;
  pricePerMillion: number;
}

function perTokenToPerMillion(perToken: string): number {
  return parseFloat(perToken) * 1_000_000;
}

function parseRawPricing(raw: GatewayRawPricing): PricingRow[] {
  const rows: PricingRow[] = [];

  if (raw.input) {
    rows.push({
      tokenType: "input",
      pricePerMillion: perTokenToPerMillion(raw.input),
    });
  }
  if (raw.output) {
    rows.push({
      tokenType: "output",
      pricePerMillion: perTokenToPerMillion(raw.output),
    });
  }
  if (raw.input_cache_read) {
    rows.push({
      tokenType: "cache_read",
      pricePerMillion: perTokenToPerMillion(raw.input_cache_read),
    });
  }
  if (raw.input_cache_write) {
    rows.push({
      tokenType: "cache_write",
      pricePerMillion: perTokenToPerMillion(raw.input_cache_write),
    });
  }
  if (raw.output_reasoning) {
    rows.push({
      tokenType: "reasoning",
      pricePerMillion: perTokenToPerMillion(raw.output_reasoning),
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up pricing rows for a specific model by its gateway ID
 * (e.g. "openai/gpt-5.2", "anthropic/claude-opus-4.6").
 *
 * The gateway uses dot notation ("claude-opus-4.6") while our ai-models.ts
 * uses dash notation ("claude-opus-4-6"). We try both forms.
 */
export async function lookupPricing(modelId: string): Promise<PricingRow[]> {
  const rawMap = await getGatewayRawPricingMap();

  const direct = rawMap.get(modelId);
  if (direct) return parseRawPricing(direct);

  // Try converting dashes to dots for Anthropic-style IDs:
  // "anthropic/claude-opus-4-6" → "anthropic/claude-opus-4.6"
  const dotVariant = modelId.replace(/(\d)-(?=\d)/g, "$1.");
  if (dotVariant !== modelId) {
    const dotMatch = rawMap.get(dotVariant);
    if (dotMatch) return parseRawPricing(dotMatch);
  }

  // Try converting dots to dashes for the reverse case
  const dashVariant = modelId.replace(/(\d)\.(?=\d)/g, "$1-");
  if (dashVariant !== modelId) {
    const dashMatch = rawMap.get(dashVariant);
    if (dashMatch) return parseRawPricing(dashMatch);
  }

  logger.debug("No pricing found for model", { modelId });
  return [];
}

/**
 * Force-refresh the pricing cache (delegates to the shared gateway-models cache).
 */
export async function warmPricingCache(): Promise<void> {
  await warmModelsCache();
}
