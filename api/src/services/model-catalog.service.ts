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
const FREE_TIER_MAX_COST_PER_M = 3.0;

const FALLBACK_FREE: readonly string[] = [
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
  "deepseek/deepseek-chat",
];

/**
 * Trusted providers for default model selection. When picking the default
 * model for a user who hasn't saved a preference, we prefer these providers.
 */
const DEFAULT_PREFERRED_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "google",
  "deepseek",
]);

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
      for (const key of normalizeArenaName(m.model)) {
        map.set(key, m.score);
      }
    }
    logger.info("Fetched arena scores", { modelCount: body.models.length });
  } catch (err) {
    logger.warn("Failed to fetch arena scores, continuing without", {
      error: String(err),
    });
  }
  return map;
}

/**
 * Generate multiple normalized keys for an arena model name to improve
 * fuzzy matching against gateway IDs.
 *
 * Arena names like "claude-opus-4-6", "gemini-2.5-pro",
 * "claude-haiku-4-5-20251001" need to match gateway IDs like
 * "claude-opus-4.6", "gemini-2.5-pro", "claude-3.5-haiku".
 */
function normalizeArenaName(name: string): string[] {
  const base = name
    .replace(/\s*\(.*?\)\s*/g, "")
    .trim()
    .toLowerCase();

  const keys: string[] = [];

  // dots→dashes variant
  keys.push(base.replace(/\./g, "-"));
  // dashes→dots variant (for version numbers)
  keys.push(base.replace(/(\d)-(?=\d)/g, "$1."));
  // as-is
  keys.push(base);
  // strip date suffixes like -20251001, -20250929
  const noDate = base.replace(/-\d{8}$/, "");
  if (noDate !== base) {
    keys.push(noDate.replace(/\./g, "-"));
    keys.push(noDate);
  }

  return [...new Set(keys)];
}

/**
 * Hardcoded aliases for models where arena and gateway names diverge
 * completely (e.g. Anthropic renamed "3.5 Haiku" → "Haiku 4.5" on arena).
 * Maps gateway model-part (lowercase) → arena key (post-normalization).
 */
const GATEWAY_TO_ARENA_ALIASES: Record<string, string> = {
  "claude-3.5-haiku": "claude-haiku-4-5",
  "claude-3-5-haiku": "claude-haiku-4-5",
  "claude-3.5-sonnet": "claude-sonnet-4-6",
  "claude-3-5-sonnet": "claude-sonnet-4-6",
};

/**
 * Extract "significant tokens" from a model name for fuzzy matching.
 * Returns the model family name and all version-like segments.
 */
function modelTokens(name: string): Set<string> {
  const tokens = new Set<string>();
  const parts = name.replace(/\./g, "-").split("-");
  for (const p of parts) {
    if (p.length > 0) {
      tokens.add(p);
    }
  }
  return tokens;
}

/**
 * Look up the arena score for a gateway model ID. Tries multiple
 * normalization strategies to handle naming divergence.
 */
function lookupArenaScore(
  gatewayId: string,
  arenaScores: Map<string, number>,
): number | null {
  const slashIdx = gatewayId.indexOf("/");
  const modelPart = slashIdx >= 0 ? gatewayId.slice(slashIdx + 1) : gatewayId;
  const lower = modelPart.toLowerCase();

  // 1. Hardcoded alias lookup
  const alias = GATEWAY_TO_ARENA_ALIASES[lower];
  if (alias) {
    const score = arenaScores.get(alias);
    if (score !== undefined) {
      return score;
    }
  }

  // 2. Try exact, dots→dashes, dashes→dots
  const variants = [
    lower,
    lower.replace(/\./g, "-"),
    lower.replace(/(\d)-(?=\d)/g, "$1."),
  ];
  for (const v of variants) {
    const score = arenaScores.get(v);
    if (score !== undefined) {
      return score;
    }
  }

  // 3. Prefix match
  for (const [key, score] of arenaScores) {
    if (key.startsWith(lower) || lower.startsWith(key)) {
      return score;
    }
  }

  // 4. Token-set match: if >70% of tokens overlap (handles reordering)
  const gwTokens = modelTokens(lower);
  if (gwTokens.size >= 2) {
    let bestScore: number | null = null;
    let bestOverlap = 0;
    for (const [key, score] of arenaScores) {
      const arenaTokens = modelTokens(key);
      let overlap = 0;
      for (const t of gwTokens) {
        if (arenaTokens.has(t)) {
          overlap++;
        }
      }
      const ratio = overlap / Math.max(gwTokens.size, arenaTokens.size);
      if (ratio > 0.7 && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestScore = score;
      }
    }
    if (bestScore !== null) {
      return bestScore;
    }
  }

  return null;
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

  const freeTierIds = new Set<string>();
  for (const m of models) {
    if (
      m.blendedCostPerM !== null &&
      m.blendedCostPerM <= FREE_TIER_MAX_COST_PER_M
    ) {
      m.tier = "free";
      freeTierIds.add(m.id);
    } else {
      m.tier = "pro";
    }
  }

  logger.info("Built model catalog", {
    totalModels: models.length,
    freeModels: freeTierIds.size,
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

  const arenaScore = lookupArenaScore(gm.id, arenaScores);

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

/**
 * Pick the best default model by ELO, preferring trusted providers.
 * Used when a user hasn't saved a model preference in their settings.
 */
function pickBestByElo(
  models: CatalogModel[],
  preferProviders = true,
): string | null {
  const sorted = [...models].sort(
    (a, b) => (b.arenaScore ?? 0) - (a.arenaScore ?? 0),
  );

  if (preferProviders) {
    const preferred = sorted.find(
      m => DEFAULT_PREFERRED_PROVIDERS.has(m.provider) && m.arenaScore !== null,
    );
    if (preferred) {
      return preferred.id;
    }
  }

  return sorted[0]?.id ?? null;
}

/**
 * Default model for Pro users (best model overall by ELO from trusted providers).
 */
export async function getDefaultChatModelId(): Promise<string> {
  await ensureCatalog();
  const all = cachedCatalog ?? [];
  return pickBestByElo(all) ?? FALLBACK_FREE[0];
}

/**
 * Default model for Free users (best free-tier model by ELO from trusted providers).
 */
export async function getDefaultFreeChatModelId(): Promise<string> {
  await ensureCatalog();
  const freeModels = (cachedCatalog ?? []).filter(m => m.tier === "free");
  return pickBestByElo(freeModels) ?? FALLBACK_FREE[0];
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
