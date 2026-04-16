/**
 * Model Catalog Service
 *
 * Single source of truth for all AI model metadata. Persists raw upstream
 * snapshots (Vercel AI Gateway + arena.ai) in MongoDB, then merges on read.
 *
 * Write path (Inngest cron / startup):
 *   fetch upstream → Zod validate → upsert DB snapshot
 *
 * Read path (every request):
 *   in-memory cache (5 min TTL) → MongoDB → mergeCatalog()
 */

import { z } from "zod";
import { loggers } from "../logging";
import { ModelCatalogSnapshot } from "../database/schema";

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

// ---------------------------------------------------------------------------
// Zod validation schemas — gate what gets persisted to DB
// ---------------------------------------------------------------------------

const GatewayModelRawSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  owned_by: z.string().optional(),
  type: z.string().optional(),
  context_window: z.number().optional(),
  tags: z.array(z.string()).optional(),
  pricing: z.record(z.string(), z.string()).optional(),
});

const GatewayResponseSchema = z.object({
  data: z.array(GatewayModelRawSchema).min(10),
});

const ArenaModelSchema = z.object({
  model: z.string(),
  score: z.number(),
  rank: z.number().optional(),
  vendor: z.string().optional(),
  license: z.string().optional(),
  ci: z.number().optional(),
  votes: z.number().optional(),
});

const ArenaResponseSchema = z.object({
  meta: z.object({ model_count: z.number() }),
  models: z.array(ArenaModelSchema).min(5),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GATEWAY_API_URL = "https://ai-gateway.vercel.sh/v1/models";
const ARENA_API_URL =
  "https://api.wulong.dev/arena-ai-leaderboards/v1/leaderboard?name=code";
const FREE_TIER_MAX_COST_PER_M = 3.0;
const MEM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const FALLBACK_FREE: readonly string[] = [
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
  "deepseek/deepseek-chat",
];

const DEFAULT_PREFERRED_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "google",
  "deepseek",
]);

// ---------------------------------------------------------------------------
// In-memory cache (thin layer over MongoDB)
// ---------------------------------------------------------------------------

let cachedCatalog: CatalogModel[] | null = null;
let cachedFreeTierIds: Set<string> | null = null;
let cacheTimestamp = 0;

// ---------------------------------------------------------------------------
// Snapshot types for DB docs
// ---------------------------------------------------------------------------

interface GatewayModelNormalized {
  id: string;
  name: string;
  description: string;
  provider: string;
  contextWindow: number | null;
  tags: string[];
}

interface PricingEntry {
  modelId: string;
  input: number;
  output: number;
}

interface ArenaEntry {
  model: string;
  score: number;
  rank?: number;
}

// ---------------------------------------------------------------------------
// Arena name normalization (for fuzzy matching gateway ↔ arena IDs)
// ---------------------------------------------------------------------------

function normalizeArenaName(name: string): string[] {
  const base = name
    .replace(/\s*\(.*?\)\s*/g, "")
    .trim()
    .toLowerCase();

  const keys: string[] = [];
  keys.push(base.replace(/\./g, "-"));
  keys.push(base.replace(/(\d)-(?=\d)/g, "$1."));
  keys.push(base);
  const noDate = base.replace(/-\d{8}$/, "");
  if (noDate !== base) {
    keys.push(noDate.replace(/\./g, "-"));
    keys.push(noDate);
  }

  return [...new Set(keys)];
}

const GATEWAY_TO_ARENA_ALIASES: Record<string, string> = {
  "claude-3.5-haiku": "claude-haiku-4-5",
  "claude-3-5-haiku": "claude-haiku-4-5",
  "claude-3.5-sonnet": "claude-sonnet-4-6",
  "claude-3-5-sonnet": "claude-sonnet-4-6",
};

function modelTokens(name: string): Set<string> {
  const tokens = new Set<string>();
  const parts = name.replace(/\./g, "-").split("-");
  for (const p of parts) {
    if (p.length > 0) tokens.add(p);
  }
  return tokens;
}

function lookupArenaScore(
  gatewayId: string,
  arenaScores: Map<string, number>,
): number | null {
  const slashIdx = gatewayId.indexOf("/");
  const modelPart = slashIdx >= 0 ? gatewayId.slice(slashIdx + 1) : gatewayId;
  const lower = modelPart.toLowerCase();

  const alias = GATEWAY_TO_ARENA_ALIASES[lower];
  if (alias) {
    const score = arenaScores.get(alias);
    if (score !== undefined) return score;
  }

  const variants = [
    lower,
    lower.replace(/\./g, "-"),
    lower.replace(/(\d)-(?=\d)/g, "$1."),
  ];
  for (const v of variants) {
    const score = arenaScores.get(v);
    if (score !== undefined) return score;
  }

  for (const [key, score] of arenaScores) {
    if (key.startsWith(lower) || lower.startsWith(key)) return score;
  }

  const gwTokens = modelTokens(lower);
  if (gwTokens.size >= 2) {
    let bestScore: number | null = null;
    let bestOverlap = 0;
    for (const [key, score] of arenaScores) {
      const arenaTokens = modelTokens(key);
      let overlap = 0;
      for (const t of gwTokens) {
        if (arenaTokens.has(t)) overlap++;
      }
      const ratio = overlap / Math.max(gwTokens.size, arenaTokens.size);
      if (ratio > 0.7 && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestScore = score;
      }
    }
    if (bestScore !== null) return bestScore;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Snapshot refresh: Gateway (models + pricing)
// ---------------------------------------------------------------------------

export async function refreshGatewaySnapshot(): Promise<
  { models: number } | { skipped: true; reason: string }
> {
  const res = await fetch(GATEWAY_API_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Gateway fetch failed: ${res.status} ${res.statusText}`);
  }

  const body = await res.json();
  const parsed = GatewayResponseSchema.safeParse(body);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map(i => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    logger.warn("Gateway response failed Zod validation, skipping upsert", {
      reason,
    });
    return { skipped: true, reason };
  }

  const languageModels = parsed.data.data.filter(m => m.type === "language");
  if (languageModels.length < 10) {
    const reason = `Only ${languageModels.length} language models after type filter`;
    logger.warn("Gateway snapshot too small, skipping upsert", { reason });
    return { skipped: true, reason };
  }

  // Normalize gateway models
  const gatewayDocs: GatewayModelNormalized[] = languageModels.map(raw => ({
    id: raw.id,
    name: raw.name || raw.id,
    description: raw.description || "",
    provider: raw.owned_by || raw.id.split("/")[0] || "unknown",
    contextWindow: raw.context_window ?? null,
    tags: raw.tags ?? [],
  }));

  // Extract pricing
  const pricingDocs: PricingEntry[] = [];
  for (const raw of languageModels) {
    if (raw.pricing?.input && raw.pricing?.output) {
      pricingDocs.push({
        modelId: raw.id,
        input: parseFloat(raw.pricing.input) * 1_000_000,
        output: parseFloat(raw.pricing.output) * 1_000_000,
      });
    }
  }

  const now = new Date();

  await Promise.all([
    ModelCatalogSnapshot.findOneAndUpdate(
      { _id: "gateway" },
      { data: gatewayDocs, fetchedAt: now, itemCount: gatewayDocs.length },
      { upsert: true },
    ),
    ModelCatalogSnapshot.findOneAndUpdate(
      { _id: "pricing" },
      { data: pricingDocs, fetchedAt: now, itemCount: pricingDocs.length },
      { upsert: true },
    ),
  ]);

  logger.info("Persisted gateway + pricing snapshots", {
    models: gatewayDocs.length,
    pricedModels: pricingDocs.length,
  });

  return { models: gatewayDocs.length };
}

// ---------------------------------------------------------------------------
// Snapshot refresh: Arena
// ---------------------------------------------------------------------------

export async function refreshArenaSnapshot(): Promise<
  { scores: number } | { skipped: true; reason: string }
> {
  const res = await fetch(ARENA_API_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) {
    throw new Error(`Arena fetch failed: ${res.status} ${res.statusText}`);
  }

  const body = await res.json();
  const parsed = ArenaResponseSchema.safeParse(body);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map(i => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    logger.warn("Arena response failed Zod validation, skipping upsert", {
      reason,
    });
    return { skipped: true, reason };
  }

  const arenaDocs: ArenaEntry[] = parsed.data.models.map(m => ({
    model: m.model,
    score: m.score,
    rank: m.rank,
  }));

  await ModelCatalogSnapshot.findOneAndUpdate(
    { _id: "arena" },
    { data: arenaDocs, fetchedAt: new Date(), itemCount: arenaDocs.length },
    { upsert: true },
  );

  logger.info("Persisted arena snapshot", { scores: arenaDocs.length });
  return { scores: arenaDocs.length };
}

// ---------------------------------------------------------------------------
// Refresh all snapshots (parallel, best-effort per source)
// ---------------------------------------------------------------------------

export async function refreshAllSnapshots(): Promise<{
  gateway: { models: number } | { skipped: true; reason: string };
  arena: { scores: number } | { skipped: true; reason: string };
}> {
  const [gateway, arena] = await Promise.all([
    refreshGatewaySnapshot().catch(err => {
      logger.error("Gateway snapshot refresh failed", {
        error: String(err),
      });
      return { skipped: true as const, reason: String(err) };
    }),
    refreshArenaSnapshot().catch(err => {
      logger.warn("Arena snapshot refresh failed", { error: String(err) });
      return { skipped: true as const, reason: String(err) };
    }),
  ]);

  return { gateway, arena };
}

// ---------------------------------------------------------------------------
// Pure merge: gateway + arena + pricing → CatalogModel[]
// ---------------------------------------------------------------------------

function mergeCatalog(
  gateway: GatewayModelNormalized[],
  arena: ArenaEntry[],
  pricing: PricingEntry[],
): { models: CatalogModel[]; freeTierIds: Set<string> } {
  // Build arena score lookup
  const arenaScores = new Map<string, number>();
  for (const a of arena) {
    for (const key of normalizeArenaName(a.model)) {
      arenaScores.set(key, a.score);
    }
  }

  // Build pricing lookup
  const pricingMap = new Map<string, { input: number; output: number }>();
  for (const p of pricing) {
    pricingMap.set(p.modelId, { input: p.input, output: p.output });
  }

  const freeTierIds = new Set<string>();
  const models: CatalogModel[] = gateway.map(gm => {
    const supportsThinking = gm.tags.includes("reasoning");
    const p = pricingMap.get(gm.id);
    const blendedCostPerM = p ? (p.input + p.output) / 2 : null;
    const arenaScore = lookupArenaScore(gm.id, arenaScores);

    const isFree =
      blendedCostPerM !== null && blendedCostPerM <= FREE_TIER_MAX_COST_PER_M;
    if (isFree) freeTierIds.add(gm.id);

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
      tier: isFree ? ("free" as const) : ("pro" as const),
    };
  });

  return { models, freeTierIds };
}

// ---------------------------------------------------------------------------
// ensureCatalog: in-memory → MongoDB → merge
// ---------------------------------------------------------------------------

async function loadFromDb(): Promise<{
  models: CatalogModel[];
  freeTierIds: Set<string>;
} | null> {
  const docs = await ModelCatalogSnapshot.find({}).lean();
  if (docs.length === 0) return null;

  const gatewayDoc = docs.find(d => d._id === "gateway");
  const arenaDoc = docs.find(d => d._id === "arena");
  const pricingDoc = docs.find(d => d._id === "pricing");

  if (!gatewayDoc || !gatewayDoc.data || gatewayDoc.data.length === 0) {
    return null;
  }

  const gateway = gatewayDoc.data as unknown as GatewayModelNormalized[];
  const arena = (arenaDoc?.data ?? []) as unknown as ArenaEntry[];
  const pricing = (pricingDoc?.data ?? []) as unknown as PricingEntry[];

  return mergeCatalog(gateway, arena, pricing);
}

async function ensureCatalog(): Promise<void> {
  if (
    cachedCatalog &&
    cachedCatalog.length > 0 &&
    Date.now() - cacheTimestamp < MEM_CACHE_TTL_MS
  ) {
    return;
  }

  try {
    const result = await loadFromDb();
    if (result && result.models.length > 0) {
      cachedCatalog = result.models;
      cachedFreeTierIds = result.freeTierIds;
      cacheTimestamp = Date.now();
      return;
    }
  } catch (err) {
    logger.warn("Failed to load catalog from DB", { error: String(err) });
  }

  // DB empty or unavailable — serve stale in-memory data if we have any
  if (cachedCatalog && cachedCatalog.length > 0) return;

  // No data anywhere
  logger.warn(
    "Model catalog empty — waiting for Inngest cron or startup to populate",
  );
  cachedCatalog = [];
  cachedFreeTierIds = new Set(FALLBACK_FREE);
  cacheTimestamp = 0; // don't cache the empty result for long
}

// ---------------------------------------------------------------------------
// Startup warm
// ---------------------------------------------------------------------------

export async function warmCatalog(): Promise<void> {
  cachedCatalog = null;
  cachedFreeTierIds = null;
  cacheTimestamp = 0;

  // Try loading from DB first (fast, no external API calls)
  try {
    const result = await loadFromDb();
    if (result && result.models.length > 0) {
      cachedCatalog = result.models;
      cachedFreeTierIds = result.freeTierIds;
      cacheTimestamp = Date.now();
      logger.info("Loaded model catalog from DB", {
        models: result.models.length,
        freeModels: result.freeTierIds.size,
      });
      return;
    }
  } catch (err) {
    logger.warn("Failed to load catalog from DB on startup", {
      error: String(err),
    });
  }

  // DB empty (first deploy) — fetch from upstream and persist
  logger.info("DB catalog empty, fetching from upstream APIs");
  const { gateway } = await refreshAllSnapshots();

  if ("models" in gateway) {
    const result = await loadFromDb();
    if (result && result.models.length > 0) {
      cachedCatalog = result.models;
      cachedFreeTierIds = result.freeTierIds;
      cacheTimestamp = Date.now();
      logger.info("Populated model catalog from upstream", {
        models: result.models.length,
      });
      return;
    }
  }

  // Fallback: empty catalog
  cachedCatalog = [];
  cachedFreeTierIds = new Set(FALLBACK_FREE);
  cacheTimestamp = 0;
}

// ---------------------------------------------------------------------------
// Public API (unchanged signatures — callers don't know the source switched)
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
    if (preferred) return preferred.id;
  }

  return sorted[0]?.id ?? null;
}

export async function getDefaultChatModelId(): Promise<string> {
  await ensureCatalog();
  const all = cachedCatalog ?? [];
  return pickBestByElo(all) ?? FALLBACK_FREE[0];
}

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
