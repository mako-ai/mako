/**
 * Gateway Models Service
 *
 * Fetches the full model catalog from the Vercel AI Gateway and caches it
 * in process memory. The settings UI uses this to show all models an admin
 * can enable for their workspace.
 *
 * Endpoint: https://ai-gateway.vercel.sh/v1/models
 */

import { loggers } from "../logging";

const logger = loggers.app();

// ---------------------------------------------------------------------------
// Types matching the gateway /v1/models response shape
// ---------------------------------------------------------------------------

export interface GatewayRawPricing {
  input?: string;
  output?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  output_reasoning?: string;
}

interface GatewayModelRaw {
  id: string;
  name?: string;
  description?: string;
  owned_by?: string;
  type?: string;
  context_window?: number;
  tags?: string[];
  pricing?: GatewayRawPricing;
}

interface GatewayModelsResponse {
  data: GatewayModelRaw[];
}

// ---------------------------------------------------------------------------
// Public model info type
// ---------------------------------------------------------------------------

export interface GatewayModelInfo {
  id: string;
  name: string;
  description: string;
  provider: string;
  contextWindow: number | null;
  tags: string[];
}

export interface GatewayModelPricing {
  input: number;
  output: number;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const GATEWAY_API_URL = "https://ai-gateway.vercel.sh/v1/models";

let cachedModels: GatewayModelInfo[] | null = null;
let cachedPricingMap: Map<string, GatewayModelPricing> | null = null;
let cachedRawPricingMap: Map<string, GatewayRawPricing> | null = null;
let cacheTimestamp = 0;
let fetchInFlight: Promise<GatewayModelInfo[]> | null = null;

function normalizeModel(raw: GatewayModelRaw): GatewayModelInfo {
  return {
    id: raw.id,
    name: raw.name || raw.id,
    description: raw.description || "",
    provider: raw.owned_by || raw.id.split("/")[0] || "unknown",
    contextWindow: raw.context_window ?? null,
    tags: raw.tags ?? [],
  };
}

async function fetchAllModels(): Promise<GatewayModelInfo[]> {
  const res = await fetch(GATEWAY_API_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(
      `Gateway models fetch failed: ${res.status} ${res.statusText}`,
    );
  }

  const body = (await res.json()) as GatewayModelsResponse;
  const models: GatewayModelInfo[] = [];
  const pricingMap = new Map<string, GatewayModelPricing>();
  const rawPricingMap = new Map<string, GatewayRawPricing>();

  for (const raw of body.data) {
    if (raw.type !== "language") continue;
    models.push(normalizeModel(raw));
    if (raw.pricing) {
      rawPricingMap.set(raw.id, raw.pricing);
      if (raw.pricing.input && raw.pricing.output) {
        pricingMap.set(raw.id, {
          input: parseFloat(raw.pricing.input) * 1_000_000,
          output: parseFloat(raw.pricing.output) * 1_000_000,
        });
      }
    }
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  cachedPricingMap = pricingMap;
  cachedRawPricingMap = rawPricingMap;

  logger.info("Refreshed gateway models cache", {
    modelCount: models.length,
    pricedModels: pricingMap.size,
  });
  return models;
}

/**
 * Returns all language models from the gateway, fetching if the cache
 * has expired. Deduplicates concurrent requests.
 */
export async function getGatewayModels(): Promise<GatewayModelInfo[]> {
  if (cachedModels && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedModels;
  }

  if (fetchInFlight) return fetchInFlight;

  fetchInFlight = fetchAllModels()
    .then(models => {
      cachedModels = models;
      cacheTimestamp = Date.now();
      fetchInFlight = null;
      return models;
    })
    .catch(err => {
      fetchInFlight = null;
      logger.warn("Failed to fetch gateway models", { error: String(err) });
      if (cachedModels) return cachedModels;
      return [];
    });

  return fetchInFlight;
}

/**
 * Returns per-model pricing (cost per 1M tokens) extracted from the same
 * gateway response. Triggers a fetch if the cache is empty.
 */
export async function getGatewayPricingMap(): Promise<
  Map<string, GatewayModelPricing>
> {
  await getGatewayModels();
  return cachedPricingMap ?? new Map();
}

/**
 * Returns full raw pricing strings (input, output, cache_read, cache_write,
 * reasoning) from the gateway response. Used by the cost calculator for
 * detailed per-token-type pricing.
 */
export async function getGatewayRawPricingMap(): Promise<
  Map<string, GatewayRawPricing>
> {
  await getGatewayModels();
  return cachedRawPricingMap ?? new Map();
}

/**
 * Force-refresh the models cache.
 */
export async function warmModelsCache(): Promise<void> {
  cachedModels = null;
  cachedPricingMap = null;
  cachedRawPricingMap = null;
  cacheTimestamp = 0;
  await getGatewayModels();
}
