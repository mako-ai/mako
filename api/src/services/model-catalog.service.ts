/**
 * Model Catalog Service
 *
 * Single source of truth for all AI model metadata. Persists raw upstream
 * snapshots (Vercel AI Gateway) in MongoDB alongside a super-admin-curated
 * `curation` doc that decides, per model, whether it is visible to workspaces
 * and which tier (free / pro) it belongs to. Defaults for chat models are
 * chosen explicitly in the curation doc — no heuristics, no arena ELO.
 *
 * Write path (Inngest cron / startup / admin refresh):
 *   fetch gateway → Zod validate → upsert DB snapshot
 *   admin UI       → upsert `curation` doc
 *
 * Read path (every request):
 *   in-memory cache (5 min TTL) → MongoDB → mergeCatalog()
 */

import { z } from "zod";
import { loggers } from "../logging";
import { ModelCatalogSnapshot } from "../database/schema";
import {
  resolveAnthropicThinkingMode,
  type AnthropicThinkingMode,
} from "../agent-lib/anthropic-thinking";

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
  thinkingMode: AnthropicThinkingMode;
  thinkingBudgetTokens: number;
  blendedCostPerM: number | null;
  tier: "free" | "pro";
}

export interface CuratedModelEntry {
  modelId: string;
  visible: boolean;
  tier: "free" | "pro";
}

export interface CurationDoc {
  models: CuratedModelEntry[];
  defaultChatModelId: string | null;
  defaultFreeChatModelId: string | null;
  lastRefreshError: string | null;
}

/** Shape returned to the Super Admin UI (gateway × curation join). */
export interface AdminCatalogModel {
  id: string;
  provider: string;
  name: string;
  description: string;
  contextWindow: number | null;
  tags: string[];
  blendedCostPerM: number | null;
  visible: boolean;
  tier: "free" | "pro";
}

export interface AdminCatalogView {
  models: AdminCatalogModel[];
  defaultChatModelId: string | null;
  defaultFreeChatModelId: string | null;
  lastRefreshError: string | null;
  gatewayFetchedAt: string | null;
  curationUpdatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Zod validation schemas — gate what gets persisted to DB
// ---------------------------------------------------------------------------

// Pricing: we only care about `input` and `output` (per-token strings).
// The upstream gateway has started returning additional non-string fields for
// some models (e.g. `input_tiers`/`output_tiers` as arrays, `video_duration_pricing`
// as a list/object). Accept any extra keys via passthrough so validation doesn't
// reject the whole snapshot over fields we don't use.
const GatewayPricingSchema = z
  .object({
    input: z.string().optional(),
    output: z.string().optional(),
  })
  .passthrough();

const GatewayModelRawSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  owned_by: z.string().optional(),
  type: z.string().optional(),
  context_window: z.number().optional(),
  tags: z.array(z.string()).optional(),
  pricing: GatewayPricingSchema.optional(),
});

const GatewayResponseSchema = z.object({
  data: z.array(GatewayModelRawSchema).min(10),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GATEWAY_API_URL = "https://ai-gateway.vercel.sh/v1/models";
const MEM_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const FALLBACK_FREE: readonly string[] = [
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
  "deepseek/deepseek-chat",
];

// ---------------------------------------------------------------------------
// In-memory cache (thin layer over MongoDB)
// ---------------------------------------------------------------------------

let cachedCatalog: CatalogModel[] | null = null;
let cachedFreeTierIds: Set<string> | null = null;
let cachedDefaults: {
  defaultChatModelId: string | null;
  defaultFreeChatModelId: string | null;
} = { defaultChatModelId: null, defaultFreeChatModelId: null };
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

// ---------------------------------------------------------------------------
// Snapshot refresh: Gateway (models + pricing)
// ---------------------------------------------------------------------------

export async function refreshGatewaySnapshot(): Promise<
  { models: number; pricedModels: number } | { skipped: true; reason: string }
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

  const gatewayDocs: GatewayModelNormalized[] = languageModels.map(raw => ({
    id: raw.id,
    name: raw.name || raw.id,
    description: raw.description || "",
    provider: raw.owned_by || raw.id.split("/")[0] || "unknown",
    contextWindow: raw.context_window ?? null,
    tags: raw.tags ?? [],
  }));

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

  return { models: gatewayDocs.length, pricedModels: pricingDocs.length };
}

// ---------------------------------------------------------------------------
// Curation doc read / write
// ---------------------------------------------------------------------------

const EMPTY_CURATION: CurationDoc = {
  models: [],
  defaultChatModelId: null,
  defaultFreeChatModelId: null,
  lastRefreshError: null,
};

async function loadCuration(): Promise<CurationDoc> {
  const doc = await ModelCatalogSnapshot.findOne({ _id: "curation" }).lean();
  if (!doc || !doc.data) return { ...EMPTY_CURATION };
  const data = doc.data as Partial<CurationDoc>;
  return {
    models: Array.isArray(data.models) ? data.models : [],
    defaultChatModelId: data.defaultChatModelId ?? null,
    defaultFreeChatModelId: data.defaultFreeChatModelId ?? null,
    lastRefreshError: data.lastRefreshError ?? null,
  };
}

async function saveCuration(curation: CurationDoc): Promise<void> {
  await ModelCatalogSnapshot.findOneAndUpdate(
    { _id: "curation" },
    {
      data: curation,
      fetchedAt: new Date(),
      itemCount: curation.models.length,
    },
    { upsert: true },
  );
  invalidateCatalog();
}

/**
 * Upsert a single model's curation entry (visibility + tier).
 * Unknown modelIds are appended.
 */
export async function setCuratedModel(
  modelId: string,
  update: { visible?: boolean; tier?: "free" | "pro" },
): Promise<CurationDoc> {
  const curation = await loadCuration();
  const idx = curation.models.findIndex(m => m.modelId === modelId);
  if (idx >= 0) {
    const next = { ...curation.models[idx] };
    if (update.visible !== undefined) next.visible = update.visible;
    if (update.tier !== undefined) next.tier = update.tier;
    curation.models[idx] = next;
  } else {
    curation.models.push({
      modelId,
      visible: update.visible ?? true,
      tier: update.tier ?? "pro",
    });
  }

  // Clear defaults that were pointing at a now-hidden model
  if (update.visible === false) {
    if (curation.defaultChatModelId === modelId) {
      curation.defaultChatModelId = null;
    }
    if (curation.defaultFreeChatModelId === modelId) {
      curation.defaultFreeChatModelId = null;
    }
  }
  // If tier flipped away from free, drop the free-default pointer
  if (update.tier === "pro" && curation.defaultFreeChatModelId === modelId) {
    curation.defaultFreeChatModelId = null;
  }

  await saveCuration(curation);
  return curation;
}

export async function setCuratedDefaults(update: {
  defaultChatModelId?: string | null;
  defaultFreeChatModelId?: string | null;
}): Promise<CurationDoc> {
  const curation = await loadCuration();
  if (update.defaultChatModelId !== undefined) {
    curation.defaultChatModelId = update.defaultChatModelId;
  }
  if (update.defaultFreeChatModelId !== undefined) {
    curation.defaultFreeChatModelId = update.defaultFreeChatModelId;
  }
  await saveCuration(curation);
  return curation;
}

async function setCurationRefreshError(error: string | null): Promise<void> {
  const curation = await loadCuration();
  if (curation.lastRefreshError === error) return;
  curation.lastRefreshError = error;
  await saveCuration(curation);
}

// ---------------------------------------------------------------------------
// Admin refresh wrapper — persists any error on the curation doc
// ---------------------------------------------------------------------------

export async function adminRefreshCatalog(): Promise<
  | { ok: true; models: number; pricedModels: number }
  | { ok: false; error: string }
> {
  try {
    const result = await refreshGatewaySnapshot();
    if ("skipped" in result) {
      await setCurationRefreshError(`Skipped: ${result.reason}`);
      return { ok: false, error: result.reason };
    }
    await setCurationRefreshError(null);
    await warmCatalog();
    return {
      ok: true,
      models: result.models,
      pricedModels: result.pricedModels,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Admin catalog refresh failed", { error: msg });
    await setCurationRefreshError(msg);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Pure merge: gateway + pricing + curation → CatalogModel[]
// ---------------------------------------------------------------------------

function mergeCatalog(
  gateway: GatewayModelNormalized[],
  pricing: PricingEntry[],
  curation: CurationDoc,
): {
  models: CatalogModel[];
  freeTierIds: Set<string>;
  defaults: {
    defaultChatModelId: string | null;
    defaultFreeChatModelId: string | null;
  };
} {
  const pricingMap = new Map<string, { input: number; output: number }>();
  for (const p of pricing) {
    pricingMap.set(p.modelId, { input: p.input, output: p.output });
  }

  const curationMap = new Map<string, CuratedModelEntry>();
  for (const c of curation.models) {
    curationMap.set(c.modelId, c);
  }

  const freeTierIds = new Set<string>();
  const models: CatalogModel[] = [];

  for (const gm of gateway) {
    const cur = curationMap.get(gm.id);
    // Fail-closed: models without a curation entry are hidden by default
    if (!cur || cur.visible === false) continue;

    const supportsThinking = gm.tags.includes("reasoning");
    const thinkingMode = resolveAnthropicThinkingMode(gm.id, supportsThinking);
    const p = pricingMap.get(gm.id);
    const blendedCostPerM = p ? (p.input + p.output) / 2 : null;
    const tier = cur.tier;
    if (tier === "free") freeTierIds.add(gm.id);

    models.push({
      id: gm.id,
      provider: gm.provider,
      name: gm.name,
      description: gm.description,
      contextWindow: gm.contextWindow,
      tags: gm.tags,
      supportsThinking,
      thinkingMode,
      thinkingBudgetTokens: supportsThinking ? 10_000 : 0,
      blendedCostPerM,
      tier,
    });
  }

  return {
    models,
    freeTierIds,
    defaults: {
      defaultChatModelId: curation.defaultChatModelId,
      defaultFreeChatModelId: curation.defaultFreeChatModelId,
    },
  };
}

// ---------------------------------------------------------------------------
// ensureCatalog: in-memory → MongoDB → merge
// ---------------------------------------------------------------------------

async function loadFromDb(): Promise<{
  models: CatalogModel[];
  freeTierIds: Set<string>;
  defaults: {
    defaultChatModelId: string | null;
    defaultFreeChatModelId: string | null;
  };
} | null> {
  const docs = await ModelCatalogSnapshot.find({
    _id: { $in: ["gateway", "pricing", "curation"] },
  }).lean();
  if (docs.length === 0) return null;

  const gatewayDoc = docs.find(d => d._id === "gateway");
  const pricingDoc = docs.find(d => d._id === "pricing");
  const curationDoc = docs.find(d => d._id === "curation");

  if (!gatewayDoc || !gatewayDoc.data || gatewayDoc.data.length === 0) {
    return null;
  }

  const gateway = gatewayDoc.data as unknown as GatewayModelNormalized[];
  const pricing = (pricingDoc?.data ?? []) as unknown as PricingEntry[];
  const curation: CurationDoc = curationDoc?.data
    ? {
        models: Array.isArray((curationDoc.data as any).models)
          ? (curationDoc.data as any).models
          : [],
        defaultChatModelId:
          (curationDoc.data as any).defaultChatModelId ?? null,
        defaultFreeChatModelId:
          (curationDoc.data as any).defaultFreeChatModelId ?? null,
        lastRefreshError: (curationDoc.data as any).lastRefreshError ?? null,
      }
    : { ...EMPTY_CURATION };

  return mergeCatalog(gateway, pricing, curation);
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
      cachedDefaults = result.defaults;
      cacheTimestamp = Date.now();
      return;
    }
  } catch (err) {
    logger.warn("Failed to load catalog from DB", { error: String(err) });
  }

  if (cachedCatalog && cachedCatalog.length > 0) return;

  logger.warn(
    "Model catalog empty — waiting for Inngest cron or startup to populate",
  );
  cachedCatalog = [];
  cachedFreeTierIds = new Set(FALLBACK_FREE);
  cachedDefaults = { defaultChatModelId: null, defaultFreeChatModelId: null };
  cacheTimestamp = 0;
}

// ---------------------------------------------------------------------------
// Startup warm + manual invalidation
// ---------------------------------------------------------------------------

export function invalidateCatalog(): void {
  cachedCatalog = null;
  cachedFreeTierIds = null;
  cachedDefaults = { defaultChatModelId: null, defaultFreeChatModelId: null };
  cacheTimestamp = 0;
}

export async function warmCatalog(): Promise<void> {
  invalidateCatalog();

  try {
    const result = await loadFromDb();
    if (result && result.models.length > 0) {
      cachedCatalog = result.models;
      cachedFreeTierIds = result.freeTierIds;
      cachedDefaults = result.defaults;
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

  logger.info("DB catalog empty, fetching from upstream AI Gateway");
  const gw = await refreshGatewaySnapshot().catch(err => {
    logger.error("Gateway snapshot refresh failed on startup", {
      error: String(err),
    });
    return { skipped: true as const, reason: String(err) };
  });

  if ("models" in gw) {
    const result = await loadFromDb();
    if (result && result.models.length > 0) {
      cachedCatalog = result.models;
      cachedFreeTierIds = result.freeTierIds;
      cachedDefaults = result.defaults;
      cacheTimestamp = Date.now();
      logger.info("Populated model catalog from upstream", {
        models: result.models.length,
      });
      return;
    }
  }

  cachedCatalog = [];
  cachedFreeTierIds = new Set(FALLBACK_FREE);
  cachedDefaults = { defaultChatModelId: null, defaultFreeChatModelId: null };
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

export async function getDefaultChatModelId(): Promise<string> {
  await ensureCatalog();
  const all = cachedCatalog ?? [];
  const explicit = cachedDefaults.defaultChatModelId;
  if (explicit && all.some(m => m.id === explicit)) return explicit;

  // Safe fallback: first visible pro, then first visible free, then FALLBACK_FREE
  const pro = all.find(m => m.tier === "pro");
  if (pro) return pro.id;
  const free = all.find(m => m.tier === "free");
  if (free) return free.id;
  return FALLBACK_FREE[0];
}

export async function getDefaultFreeChatModelId(): Promise<string> {
  await ensureCatalog();
  const all = cachedCatalog ?? [];
  const explicit = cachedDefaults.defaultFreeChatModelId;
  if (explicit && all.some(m => m.id === explicit && m.tier === "free")) {
    return explicit;
  }
  const free = all.find(m => m.tier === "free");
  if (free) return free.id;
  return FALLBACK_FREE[0];
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

// ---------------------------------------------------------------------------
// Admin-facing catalog view (join gateway × curation, includes hidden models)
// ---------------------------------------------------------------------------

export async function getAdminCatalogView(): Promise<AdminCatalogView> {
  const [docs, curation] = await Promise.all([
    ModelCatalogSnapshot.find({
      _id: { $in: ["gateway", "pricing", "curation"] },
    }).lean(),
    loadCuration(),
  ]);

  const gatewayDoc = docs.find(d => d._id === "gateway");
  const pricingDoc = docs.find(d => d._id === "pricing");
  const curationDoc = docs.find(d => d._id === "curation");

  const gateway = (gatewayDoc?.data ??
    []) as unknown as GatewayModelNormalized[];
  const pricing = (pricingDoc?.data ?? []) as unknown as PricingEntry[];

  const pricingMap = new Map<string, { input: number; output: number }>();
  for (const p of pricing) {
    pricingMap.set(p.modelId, { input: p.input, output: p.output });
  }
  const curationMap = new Map<string, CuratedModelEntry>();
  for (const c of curation.models) {
    curationMap.set(c.modelId, c);
  }

  const models: AdminCatalogModel[] = gateway.map(gm => {
    const p = pricingMap.get(gm.id);
    const blendedCostPerM = p ? (p.input + p.output) / 2 : null;
    const cur = curationMap.get(gm.id);
    return {
      id: gm.id,
      provider: gm.provider,
      name: gm.name,
      description: gm.description,
      contextWindow: gm.contextWindow,
      tags: gm.tags,
      blendedCostPerM,
      // Fail-closed: missing curation entry = hidden pro
      visible: cur?.visible ?? false,
      tier: cur?.tier ?? "pro",
    };
  });

  models.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.name.localeCompare(b.name);
  });

  return {
    models,
    defaultChatModelId: curation.defaultChatModelId,
    defaultFreeChatModelId: curation.defaultFreeChatModelId,
    lastRefreshError: curation.lastRefreshError,
    gatewayFetchedAt: gatewayDoc?.fetchedAt
      ? new Date(gatewayDoc.fetchedAt).toISOString()
      : null,
    curationUpdatedAt: curationDoc?.fetchedAt
      ? new Date(curationDoc.fetchedAt).toISOString()
      : null,
  };
}
