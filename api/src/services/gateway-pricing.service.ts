/**
 * Gateway Pricing Service
 *
 * Fetches live model pricing from the Vercel AI Gateway API and caches it
 * in process memory. The cache lives for the duration of the Cloud Run
 * instance (refreshed every CACHE_TTL_MS) so we never rely on stale
 * static seed data.
 *
 * Endpoint: https://ai-gateway.vercel.sh/v1/models
 *
 * Pricing values come back as per-token strings (e.g. "0.00000175").
 * We convert to per-million-token numbers for internal use.
 */

import { loggers } from "../logging";

const logger = loggers.app();

// ---------------------------------------------------------------------------
// Types matching the gateway /v1/models response shape
// ---------------------------------------------------------------------------

interface GatewayModelPricing {
  input?: string;
  output?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  output_reasoning?: string;
}

interface GatewayModel {
  id: string;
  type: string;
  pricing?: GatewayModelPricing;
}

interface GatewayModelsResponse {
  data: GatewayModel[];
}

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

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const GATEWAY_API_URL = "https://ai-gateway.vercel.sh/v1/models";

let cachedPricingMap: Map<string, PricingRow[]> | null = null;
let cacheTimestamp = 0;
let fetchInFlight: Promise<Map<string, PricingRow[]>> | null = null;

function perTokenToPerMillion(perToken: string): number {
  return parseFloat(perToken) * 1_000_000;
}

function parseModelPricing(model: GatewayModel): PricingRow[] {
  const p = model.pricing;
  if (!p) return [];

  const rows: PricingRow[] = [];

  if (p.input) {
    rows.push({
      tokenType: "input",
      pricePerMillion: perTokenToPerMillion(p.input),
    });
  }
  if (p.output) {
    rows.push({
      tokenType: "output",
      pricePerMillion: perTokenToPerMillion(p.output),
    });
  }
  if (p.input_cache_read) {
    rows.push({
      tokenType: "cache_read",
      pricePerMillion: perTokenToPerMillion(p.input_cache_read),
    });
  }
  if (p.input_cache_write) {
    rows.push({
      tokenType: "cache_write",
      pricePerMillion: perTokenToPerMillion(p.input_cache_write),
    });
  }
  if (p.output_reasoning) {
    rows.push({
      tokenType: "reasoning",
      pricePerMillion: perTokenToPerMillion(p.output_reasoning),
    });
  }

  return rows;
}

async function fetchAllPricing(): Promise<Map<string, PricingRow[]>> {
  const res = await fetch(GATEWAY_API_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(
      `Gateway pricing fetch failed: ${res.status} ${res.statusText}`,
    );
  }

  const body = (await res.json()) as GatewayModelsResponse;
  const map = new Map<string, PricingRow[]>();

  for (const model of body.data) {
    if (model.type !== "language") continue;

    const rows = parseModelPricing(model);
    if (rows.length > 0) {
      map.set(model.id, rows);
    }
  }

  logger.info("Refreshed gateway pricing cache", { modelCount: map.size });
  return map;
}

/**
 * Returns the full pricing map, fetching from the gateway if the cache
 * has expired. Deduplicates concurrent requests.
 */
async function getPricingMap(): Promise<Map<string, PricingRow[]>> {
  if (cachedPricingMap && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedPricingMap;
  }

  if (fetchInFlight) return fetchInFlight;

  fetchInFlight = fetchAllPricing()
    .then(map => {
      cachedPricingMap = map;
      cacheTimestamp = Date.now();
      fetchInFlight = null;
      return map;
    })
    .catch(err => {
      fetchInFlight = null;
      logger.warn("Failed to fetch gateway pricing", { error: String(err) });
      if (cachedPricingMap) return cachedPricingMap;
      return new Map<string, PricingRow[]>();
    });

  return fetchInFlight;
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
  const map = await getPricingMap();

  const direct = map.get(modelId);
  if (direct) return direct;

  // Try converting dashes to dots for Anthropic-style IDs:
  // "anthropic/claude-opus-4-6" → "anthropic/claude-opus-4.6"
  const dotVariant = modelId.replace(/(\d)-(\d)/g, "$1.$2");
  if (dotVariant !== modelId) {
    const dotMatch = map.get(dotVariant);
    if (dotMatch) return dotMatch;
  }

  // Try converting dots to dashes for the reverse case
  const dashVariant = modelId.replace(/(\d)\.(\d)/g, "$1-$2");
  if (dashVariant !== modelId) {
    const dashMatch = map.get(dashVariant);
    if (dashMatch) return dashMatch;
  }

  logger.debug("No pricing found for model", { modelId });
  return [];
}

/**
 * Force-refresh the pricing cache. Useful on startup or after deploy.
 */
export async function warmPricingCache(): Promise<void> {
  cachedPricingMap = null;
  cacheTimestamp = 0;
  await getPricingMap();
}
