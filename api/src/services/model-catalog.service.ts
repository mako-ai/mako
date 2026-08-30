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
import { warmModelsCache } from "./gateway-models.service";
import {
  hasExplicitThinkingMode,
  resolveAnthropicThinkingMode,
  thinkingErrorRequiresAdaptive,
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
  /**
   * Explicit model used for cheap "utility" / fast tasks (version comments,
   * titles, descriptions). When null, the cheapest tool-use model is picked
   * heuristically. Super admins set this so they can, e.g., bump the Haiku
   * version after refreshing the catalog.
   */
  utilityModelId: string | null;
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
  utilityModelId: string | null;
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
  utilityModelId: string | null;
} = {
  defaultChatModelId: null,
  defaultFreeChatModelId: null,
  utilityModelId: null,
};
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
// Probed thinking-mode capabilities (snapshot doc `_id: "capabilities"`)
//
// The static map in anthropic-thinking.ts can't know about models whose IDs
// don't follow the family-major.minor pattern (e.g. claude-fable-5). For
// those we PROBE: issue a tiny generateText with the manual payload and see
// whether Anthropic rejects it with the "use thinking.type.adaptive" 400.
// Results are persisted here and take precedence over the static resolver.
// Written by probeAnthropicThinkingModes() (catalog refresh) and
// saveProbedThinkingMode() (runtime self-heal, see thinking-self-heal.ts).
// ---------------------------------------------------------------------------

type ProbedThinkingModes = Record<
  string,
  Exclude<AnthropicThinkingMode, "none">
>;

async function loadProbedThinkingModes(): Promise<ProbedThinkingModes> {
  const doc = await ModelCatalogSnapshot.findOne({
    _id: "capabilities",
  }).lean();
  const data = doc?.data as { thinkingModes?: unknown } | undefined;
  const raw = data?.thinkingModes;
  if (!raw || typeof raw !== "object") return {};
  const out: ProbedThinkingModes = {};
  for (const [modelId, mode] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (mode === "adaptive" || mode === "manual") out[modelId] = mode;
  }
  return out;
}

export async function saveProbedThinkingMode(
  modelId: string,
  mode: Exclude<AnthropicThinkingMode, "none">,
): Promise<void> {
  const existing = await loadProbedThinkingModes();
  if (existing[modelId] === mode) return;
  const thinkingModes = { ...existing, [modelId]: mode };
  await ModelCatalogSnapshot.findOneAndUpdate(
    { _id: "capabilities" },
    {
      data: { thinkingModes },
      fetchedAt: new Date(),
      itemCount: Object.keys(thinkingModes).length,
    },
    { upsert: true },
  );
  invalidateCatalog();
  logger.info("Persisted probed thinking mode", { modelId, mode });
}

async function probeThinkingMode(
  modelId: string,
): Promise<Exclude<AnthropicThinkingMode, "none"> | null> {
  const [{ generateText }, { getModel }] = await Promise.all([
    import("ai"),
    import("../agent-lib/ai-gateway"),
  ]);
  try {
    await generateText({
      model: getModel(modelId),
      prompt: "ok",
      providerOptions: {
        anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
      },
      maxOutputTokens: 2048,
    });
    return "manual";
  } catch (error) {
    if (thinkingErrorRequiresAdaptive(error)) return "adaptive";
    logger.warn("Thinking-mode probe inconclusive", {
      modelId,
      error: String(error),
    });
    return null;
  }
}

/**
 * Probe Anthropic reasoning models whose thinking mode is neither pinned in
 * the explicit map nor already probed. Runs after each gateway snapshot
 * refresh; new models are classified once, before any user request can hit
 * them with the wrong payload. Probe failures are logged, never thrown —
 * the runtime self-heal is the safety net.
 */
async function probeAnthropicThinkingModes(
  gatewayDocs: GatewayModelNormalized[],
): Promise<number> {
  const probed = await loadProbedThinkingModes();
  const candidates = gatewayDocs.filter(
    gm =>
      gm.id.startsWith("anthropic/") &&
      gm.tags.includes("reasoning") &&
      !hasExplicitThinkingMode(gm.id) &&
      probed[gm.id] === undefined,
  );
  let classified = 0;
  for (const gm of candidates) {
    try {
      const mode = await probeThinkingMode(gm.id);
      if (mode) {
        await saveProbedThinkingMode(gm.id, mode);
        classified += 1;
      }
    } catch (err) {
      logger.warn("Thinking-mode probe failed", {
        modelId: gm.id,
        error: String(err),
      });
    }
  }
  return classified;
}

// ---------------------------------------------------------------------------
// Snapshot refresh: Gateway (models + pricing)
// ---------------------------------------------------------------------------

type GatewayModelRaw = z.infer<typeof GatewayModelRawSchema>;

/**
 * Shared tail for both refresh variants: given the already-validated raw
 * gateway entries, filter to language models, enforce the < 10 floor, build +
 * upsert the snapshot/pricing docs, and probe Anthropic thinking modes. The
 * two refresh entry points differ only in how they validate `body.data`
 * (all-or-nothing vs. per-row), so everything downstream lives here.
 */
async function persistLanguageSnapshot(
  entries: GatewayModelRaw[],
): Promise<
  { models: number; pricedModels: number } | { skipped: true; reason: string }
> {
  const languageModels = entries.filter(m => m.type === "language");
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

  try {
    const classified = await probeAnthropicThinkingModes(gatewayDocs);
    if (classified > 0) {
      logger.info("Probed thinking modes for new Anthropic models", {
        classified,
      });
    }
  } catch (err) {
    logger.warn("Thinking-mode probing skipped", { error: String(err) });
  }

  return { models: gatewayDocs.length, pricedModels: pricingDocs.length };
}

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
  // All-or-nothing validation: a single malformed row skips the whole upsert.
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

  return persistLanguageSnapshot(parsed.data.data);
}

/**
 * Resilient refresh: validates each upstream row independently and drops only
 * the malformed ones instead of skipping the entire snapshot. Use when the
 * strict refresh keeps reporting validation errors and new models aren't
 * appearing because one bad row poisons the whole batch.
 */
export async function hardRefreshGatewaySnapshot(): Promise<
  | { models: number; pricedModels: number; droppedEntries: number }
  | { skipped: true; reason: string }
> {
  const res = await fetch(GATEWAY_API_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`Gateway fetch failed: ${res.status} ${res.statusText}`);
  }

  const body: unknown = await res.json();
  const rawData =
    body && typeof body === "object"
      ? (body as { data?: unknown }).data
      : undefined;
  if (!Array.isArray(rawData)) {
    throw new Error("Gateway response missing `data` array");
  }

  const validEntries: GatewayModelRaw[] = [];
  let droppedEntries = 0;
  for (const entry of rawData) {
    const parsed = GatewayModelRawSchema.safeParse(entry);
    if (parsed.success) {
      validEntries.push(parsed.data);
      continue;
    }
    droppedEntries += 1;
    const id = (entry as { id?: unknown })?.id;
    const reason = parsed.error.issues
      .map(i => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    logger.warn("Dropping malformed gateway model entry", {
      id: typeof id === "string" ? id : "unknown",
      reason,
    });
  }

  const result = await persistLanguageSnapshot(validEntries);
  if ("skipped" in result) return result;
  return { ...result, droppedEntries };
}

// ---------------------------------------------------------------------------
// Curation doc read / write
// ---------------------------------------------------------------------------

const EMPTY_CURATION: CurationDoc = {
  models: [],
  defaultChatModelId: null,
  defaultFreeChatModelId: null,
  utilityModelId: null,
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
    utilityModelId: data.utilityModelId ?? null,
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
    if (curation.utilityModelId === modelId) {
      curation.utilityModelId = null;
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
  utilityModelId?: string | null;
}): Promise<CurationDoc> {
  const curation = await loadCuration();
  if (update.defaultChatModelId !== undefined) {
    curation.defaultChatModelId = update.defaultChatModelId;
  }
  if (update.defaultFreeChatModelId !== undefined) {
    curation.defaultFreeChatModelId = update.defaultFreeChatModelId;
  }
  if (update.utilityModelId !== undefined) {
    curation.utilityModelId = update.utilityModelId;
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

/**
 * Admin "hard refresh": resilient per-row gateway parse that drops only
 * malformed models, then busts BOTH caches — the Mongo-backed catalog cache
 * (`warmCatalog`) and the separate in-process gateway-models cache
 * (`warmModelsCache`) — so `/api/agent/gateway-models` can't keep serving a
 * stale list after a refresh.
 */
export async function adminHardRefreshCatalog(): Promise<
  | { ok: true; models: number; pricedModels: number; droppedEntries: number }
  | { ok: false; error: string }
> {
  try {
    const result = await hardRefreshGatewaySnapshot();
    if ("skipped" in result) {
      await setCurationRefreshError(`Skipped: ${result.reason}`);
      return { ok: false, error: result.reason };
    }
    await setCurationRefreshError(null);
    await warmCatalog();
    await warmModelsCache();
    return {
      ok: true,
      models: result.models,
      pricedModels: result.pricedModels,
      droppedEntries: result.droppedEntries,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Admin catalog hard refresh failed", { error: msg });
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
  probedModes: ProbedThinkingModes = {},
): {
  models: CatalogModel[];
  freeTierIds: Set<string>;
  defaults: {
    defaultChatModelId: string | null;
    defaultFreeChatModelId: string | null;
    utilityModelId: string | null;
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
    // Probed capabilities (catalog refresh / runtime self-heal) take
    // precedence over the static resolver heuristic.
    const thinkingMode: AnthropicThinkingMode = !supportsThinking
      ? "none"
      : (probedModes[gm.id] ??
        resolveAnthropicThinkingMode(gm.id, supportsThinking));
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
      utilityModelId: curation.utilityModelId,
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
    utilityModelId: string | null;
  };
} | null> {
  const docs = await ModelCatalogSnapshot.find({
    _id: { $in: ["gateway", "pricing", "curation", "capabilities"] },
  }).lean();
  if (docs.length === 0) return null;

  const gatewayDoc = docs.find(d => d._id === "gateway");
  const pricingDoc = docs.find(d => d._id === "pricing");
  const curationDoc = docs.find(d => d._id === "curation");
  const capabilitiesDoc = docs.find(d => d._id === "capabilities");

  const probedModes: ProbedThinkingModes = {};
  const rawModes = (capabilitiesDoc?.data as { thinkingModes?: unknown })
    ?.thinkingModes;
  if (rawModes && typeof rawModes === "object") {
    for (const [modelId, mode] of Object.entries(
      rawModes as Record<string, unknown>,
    )) {
      if (mode === "adaptive" || mode === "manual") {
        probedModes[modelId] = mode;
      }
    }
  }

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
        utilityModelId: (curationDoc.data as any).utilityModelId ?? null,
        lastRefreshError: (curationDoc.data as any).lastRefreshError ?? null,
      }
    : { ...EMPTY_CURATION };

  return mergeCatalog(gateway, pricing, curation, probedModes);
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
  cachedDefaults = {
    defaultChatModelId: null,
    defaultFreeChatModelId: null,
    utilityModelId: null,
  };
  cacheTimestamp = 0;
}

// ---------------------------------------------------------------------------
// Startup warm + manual invalidation
// ---------------------------------------------------------------------------

export function invalidateCatalog(): void {
  cachedCatalog = null;
  cachedFreeTierIds = null;
  cachedDefaults = {
    defaultChatModelId: null,
    defaultFreeChatModelId: null,
    utilityModelId: null,
  };
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
  cachedDefaults = {
    defaultChatModelId: null,
    defaultFreeChatModelId: null,
    utilityModelId: null,
  };
  cacheTimestamp = 0;
}

// ---------------------------------------------------------------------------
// Public API (unchanged signatures — callers don't know the source switched)
// ---------------------------------------------------------------------------

/** Shape returned by GET /agent/gateway-models for the workspace settings UI. */
export interface WorkspaceGatewayModelListing {
  id: string;
  name: string;
  description: string;
  provider: string;
  contextWindow: number | null;
  tags: string[];
}

function catalogToWorkspaceListing(
  model: CatalogModel,
): WorkspaceGatewayModelListing {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    provider: model.provider,
    contextWindow: model.contextWindow,
    tags: model.tags,
  };
}

async function getPersistedGatewaySnapshotListings(): Promise<
  WorkspaceGatewayModelListing[]
> {
  const doc = await ModelCatalogSnapshot.findOne({ _id: "gateway" }).lean();
  if (!doc?.data || !Array.isArray(doc.data) || doc.data.length === 0) {
    return [];
  }

  const gateway = doc.data as GatewayModelNormalized[];
  return gateway.map(gm => ({
    id: gm.id,
    name: gm.name,
    description: gm.description,
    provider: gm.provider,
    contextWindow: gm.contextWindow,
    tags: gm.tags,
  }));
}

/**
 * Super-admin-curated models for the workspace "AI Models" settings page.
 * Reads from the in-memory/DB catalog — never hits the live AI Gateway.
 *
 * When curation is empty (fresh install), falls back to the persisted
 * gateway snapshot in MongoDB (same source Inngest/startup refresh uses).
 */
export async function getWorkspaceGatewayModelListings(): Promise<
  WorkspaceGatewayModelListing[]
> {
  const catalog = await getCatalogModels();
  if (catalog.length > 0) {
    return catalog.map(catalogToWorkspaceListing);
  }
  return getPersistedGatewaySnapshotListings();
}

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

/**
 * Cheapest tool-use models, cheapest first. When the super admin has pinned an
 * explicit utility model and it is still visible, it is promoted to the front.
 */
function rankedUtilityModelIds(): string[] {
  const candidates = (cachedCatalog ?? []).filter(
    m => m.tags.includes("tool-use") && m.blendedCostPerM !== null,
  );
  candidates.sort(
    (a, b) => (a.blendedCostPerM ?? Infinity) - (b.blendedCostPerM ?? Infinity),
  );
  const ids = candidates.map(m => m.id);

  const pinned = cachedDefaults.utilityModelId;
  if (pinned && (cachedCatalog ?? []).some(m => m.id === pinned)) {
    return [pinned, ...ids.filter(id => id !== pinned)];
  }
  return ids;
}

export async function getUtilityChatModelId(): Promise<string> {
  await ensureCatalog();
  return rankedUtilityModelIds()[0] ?? FALLBACK_FREE[0];
}

export async function getUtilityModelIds(count = 3): Promise<string[]> {
  await ensureCatalog();
  return rankedUtilityModelIds().slice(0, count);
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
    utilityModelId: curation.utilityModelId,
    lastRefreshError: curation.lastRefreshError,
    gatewayFetchedAt: gatewayDoc?.fetchedAt
      ? new Date(gatewayDoc.fetchedAt).toISOString()
      : null,
    curationUpdatedAt: curationDoc?.fetchedAt
      ? new Date(curationDoc.fetchedAt).toISOString()
      : null,
  };
}

// ---------------------------------------------------------------------------
// Capabilities — the gateway supplies no modality metadata (every stored
// model has tags: null as of 2026-08), so image-input support is resolved
// from tags when they ever appear, else a family-pattern allowlist, else a
// CONSERVATIVE false: wrongly stripping a screenshot degrades gracefully
// (browse now always carries pageText), while sending an image part to a
// text-only model breaks the whole turn ("output not usable", prod report).
// ---------------------------------------------------------------------------
const VISION_TAGS = new Set(["vision", "image", "image-input", "multimodal"]);
const VISION_ID_PATTERNS: RegExp[] = [
  /(^|\/)claude/i,
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-5/i,
  /(^|\/)o[34]\b/i,
  /gemini/i,
  /pixtral/i,
  /llama-?3\.2.*vision/i,
  /llama-?4/i,
  /qwen.*-vl/i,
  /grok-(2-vision|4)/i,
];

export function modelSupportsImageInput(
  modelId: string,
  tags?: readonly string[] | null,
): boolean {
  if (tags?.some(t => VISION_TAGS.has(t.toLowerCase()))) return true;
  return VISION_ID_PATTERNS.some(re => re.test(modelId));
}
