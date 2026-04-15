/**
 * Model Catalog Service
 *
 * Single source of truth for all AI model metadata. Merges the Vercel AI
 * Gateway model list with arena.ai code leaderboard ELO scores, then
 * auto-selects the best free-tier models by ranking.
 *
 * Refreshed hourly; stale cache is served when upstream APIs are down.
 */

import {
  getGatewayModels,
  type GatewayModelInfo,
} from "./gateway-models.service";
import { loggers } from "../logging";

const logger = loggers.app();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CatalogModel {
  id: string;
  provider: string;
  name: string;
  description: string;
  contextWindow: number | null;
  tags: string[];
  supportsThinking: boolean;
  thinkingBudgetTokens: number;
  blendedCostPerM: number | null;
  arenaScore: number | null;
  tier: "free" | "pro";
}

interface ArenaModel {
  rank: number;
  model: string;
  vendor: string;
  license: string;
  score: number;
  ci: number;
  votes: number;
}

interface ArenaResponse {
  meta: { model_count: number };
  models: ArenaModel[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const ARENA_API_URL =
  "https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=code";
const FREE_TIER_COUNT = 3;
const FREE_TIER_MAX_COST_PER_M = 3.0;

const FALLBACK_FREE: readonly string[] = [
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
  "deepseek/deepseek-chat",
];

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let cachedCatalog: CatalogModel[] | null = null;
let cachedFreeTierIds: Set<string> | null = null;
let cacheTimestamp = 0;
let refreshInFlight: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Arena fetcher
// ---------------------------------------------------------------------------

async function fetchArenaScores(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const res = await fetch(ARENA_API_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Arena fetch failed: ${res.status}`);
    const body = (await res.json()) as ArenaResponse;
    for (const m of body.models) {
      map.set(normalizeArenaName(m.model), m.score);
    }
    logger.info("Fetched arena scores", { modelCount: map.size });
  } catch (err) {
    logger.warn("Failed to fetch arena scores, continuing without", {
      error: String(err),
    });
  }
  return map;
}

/**
 * Normalize arena model names for fuzzy matching with gateway IDs.
 * Strip parenthetical suffixes, lowercase, replace dots with dashes.
 */
function normalizeArenaName(name: string): string {
  return name
    .replace(/\s*\(.*?\)\s*/g, "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "-");
}

function normalizeGatewayId(id: string): string {
  const slashIdx = id.indexOf("/");
  const modelPart = slashIdx >= 0 ? id.slice(slashIdx + 1) : id;
  return modelPart.toLowerCase().replace(/\./g, "-");
}

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

interface GatewayModelPricing {
  input?: string;
  output?: string;
}

/**
 * Compute blended cost: (input + output) / 2 * 1M tokens.
 * The gateway models service doesn't expose pricing, so we fetch directly.
 */
const GATEWAY_API_URL = "https://ai-gateway.vercel.sh/v1/models";

let cachedPricingMap: Map<string, { input: number; output: number }> | null =
  null;

async function fetchPricingMap(): Promise<
  Map<string, { input: number; output: number }>
> {
  if (cachedPricingMap) return cachedPricingMap;
  const map = new Map<string, { input: number; output: number }>();
  try {
    const res = await fetch(GATEWAY_API_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Pricing fetch failed: ${res.status}`);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        type: string;
        pricing?: GatewayModelPricing;
      }>;
    };
    for (const m of body.data) {
      if (m.type !== "language" || !m.pricing?.input || !m.pricing?.output) {
        continue;
      }
      map.set(m.id, {
        input: parseFloat(m.pricing.input) * 1_000_000,
        output: parseFloat(m.pricing.output) * 1_000_000,
      });
    }
    cachedPricingMap = map;
  } catch (err) {
    logger.warn("Failed to fetch pricing for catalog", {
      error: String(err),
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Core: build catalog
// ---------------------------------------------------------------------------

async function buildCatalog(): Promise<{
  models: CatalogModel[];
  freeTierIds: Set<string>;
}> {
  const [gatewayModels, arenaScores, pricingMap] = await Promise.all([
    getGatewayModels(),
    fetchArenaScores(),
    fetchPricingMap(),
  ]);

  const models: CatalogModel[] = gatewayModels.map(gm =>
    toCatalogModel(gm, arenaScores, pricingMap),
  );

  const freeTierIds = selectFreeTier(models);
  for (const m of models) {
    m.tier = freeTierIds.has(m.id) ? "free" : "pro";
  }

  logger.info("Built model catalog", {
    totalModels: models.length,
    freeModels: freeTierIds.size,
    freeModelIds: Array.from(freeTierIds),
  });

  return { models, freeTierIds };
}

function toCatalogModel(
  gm: GatewayModelInfo,
  arenaScores: Map<string, number>,
  pricingMap: Map<string, { input: number; output: number }>,
): CatalogModel {
  const supportsThinking = gm.tags.includes("reasoning");
  const pricing = pricingMap.get(gm.id);
  const blendedCostPerM = pricing ? (pricing.input + pricing.output) / 2 : null;

  const normalizedId = normalizeGatewayId(gm.id);
  const arenaScore = arenaScores.get(normalizedId) ?? null;

  return {
    id: gm.id,
    provider: gm.provider,
    name: gm.name,
    description: gm.description,
    contextWindow: gm.contextWindow,
    tags: gm.tags,
    supportsThinking,
    thinkingBudgetTokens: supportsThinking ? 10_000 : 0,
    blendedCostPerM,
    arenaScore,
    tier: "pro", // overwritten by selectFreeTier
  };
}

function selectFreeTier(models: CatalogModel[]): Set<string> {
  const candidates = models.filter(
    m =>
      m.tags.includes("tool-use") &&
      m.blendedCostPerM !== null &&
      m.blendedCostPerM <= FREE_TIER_MAX_COST_PER_M,
  );

  candidates.sort((a, b) => {
    if (a.arenaScore !== null && b.arenaScore !== null) {
      return b.arenaScore - a.arenaScore;
    }
    if (a.arenaScore !== null) {
      return -1;
    }
    if (b.arenaScore !== null) {
      return 1;
    }
    return (a.blendedCostPerM ?? Infinity) - (b.blendedCostPerM ?? Infinity);
  });

  const selected = new Set<string>();
  for (const c of candidates) {
    if (selected.size >= FREE_TIER_COUNT) break;
    selected.add(c.id);
  }

  if (selected.size === 0) {
    for (const id of FALLBACK_FREE) selected.add(id);
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Cache refresh
// ---------------------------------------------------------------------------

async function ensureCatalog(): Promise<void> {
  if (cachedCatalog && Date.now() - cacheTimestamp < CACHE_TTL_MS) return;

  if (refreshInFlight) {
    await refreshInFlight;
    return;
  }

  refreshInFlight = buildCatalog()
    .then(({ models, freeTierIds }) => {
      cachedCatalog = models;
      cachedFreeTierIds = freeTierIds;
      cacheTimestamp = Date.now();
      refreshInFlight = null;
    })
    .catch(err => {
      refreshInFlight = null;
      logger.error("Failed to build model catalog", { error: String(err) });
      if (!cachedCatalog) {
        cachedCatalog = [];
        cachedFreeTierIds = new Set(FALLBACK_FREE);
        cacheTimestamp = Date.now();
      }
    });

  await refreshInFlight;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getCatalogModels(): Promise<CatalogModel[]> {
  await ensureCatalog();
  return cachedCatalog ?? [];
}

export async function getCatalogModel(
  id: string,
): Promise<CatalogModel | undefined> {
  await ensureCatalog();
  return cachedCatalog?.find(m => m.id === id);
}

export async function getFreeTierModelIds(): Promise<string[]> {
  await ensureCatalog();
  return Array.from(cachedFreeTierIds ?? FALLBACK_FREE);
}

export async function isFreeTierModel(id: string): Promise<boolean> {
  await ensureCatalog();
  return cachedFreeTierIds?.has(id) ?? FALLBACK_FREE.includes(id);
}

export async function getDefaultChatModelId(): Promise<string> {
  await ensureCatalog();
  const freeTierIds = cachedFreeTierIds;
  if (freeTierIds && freeTierIds.size > 0) {
    const freeModels = (cachedCatalog ?? []).filter(m => freeTierIds.has(m.id));
    freeModels.sort((a, b) => (b.arenaScore ?? 0) - (a.arenaScore ?? 0));
    if (freeModels.length > 0) return freeModels[0].id;
  }
  return FALLBACK_FREE[0];
}

export async function getDefaultFreeChatModelId(): Promise<string> {
  return getDefaultChatModelId();
}

export async function getUtilityChatModelId(): Promise<string> {
  await ensureCatalog();
  const candidates = (cachedCatalog ?? []).filter(
    m => m.tags.includes("tool-use") && m.blendedCostPerM !== null,
  );
  candidates.sort(
    (a, b) => (a.blendedCostPerM ?? Infinity) - (b.blendedCostPerM ?? Infinity),
  );
  return candidates[0]?.id ?? FALLBACK_FREE[0];
}

export async function getUtilityModelIds(count = 3): Promise<string[]> {
  await ensureCatalog();
  const candidates = (cachedCatalog ?? []).filter(
    m => m.tags.includes("tool-use") && m.blendedCostPerM !== null,
  );
  candidates.sort(
    (a, b) => (a.blendedCostPerM ?? Infinity) - (b.blendedCostPerM ?? Infinity),
  );
  return candidates.slice(0, count).map(m => m.id);
}

/**
 * Warm the catalog on startup and schedule hourly refresh.
 */
export async function warmCatalog(): Promise<void> {
  cachedCatalog = null;
  cachedFreeTierIds = null;
  cachedPricingMap = null;
  cacheTimestamp = 0;
  await ensureCatalog();
}
