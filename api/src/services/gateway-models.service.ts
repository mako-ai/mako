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

interface GatewayModelRaw {
  id: string;
  name?: string;
  description?: string;
  owned_by?: string;
  type?: string;
  context_window?: number;
  tags?: string[];
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

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const GATEWAY_API_URL = "https://ai-gateway.vercel.sh/v1/models";

let cachedModels: GatewayModelInfo[] | null = null;
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

  for (const raw of body.data) {
    if (raw.type !== "language") continue;
    models.push(normalizeModel(raw));
  }

  models.sort((a, b) => a.id.localeCompare(b.id));

  logger.info("Refreshed gateway models cache", { modelCount: models.length });
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
 * Force-refresh the models cache.
 */
export async function warmModelsCache(): Promise<void> {
  cachedModels = null;
  cacheTimestamp = 0;
  await getGatewayModels();
}
