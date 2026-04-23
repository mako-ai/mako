import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Seed model_catalog_snapshots curation doc from today's gateway+pricing+arena state; delete legacy arena doc";

const COLLECTION = "modelcatalogsnapshots";
const FREE_TIER_MAX_COST_PER_M = 3.0;

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

interface GatewayModelNormalized {
  id: string;
  provider: string;
  name?: string;
}

interface PricingEntry {
  modelId: string;
  input: number;
  output: number;
}

interface ArenaEntry {
  model: string;
  score: number;
}

interface CuratedModel {
  modelId: string;
  visible: boolean;
  tier: "free" | "pro";
}

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

function lookupArenaScore(
  gatewayId: string,
  arenaScores: Map<string, number>,
): number | null {
  const slashIdx = gatewayId.indexOf("/");
  const modelPart = slashIdx >= 0 ? gatewayId.slice(slashIdx + 1) : gatewayId;
  const lower = modelPart.toLowerCase();
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
  return null;
}

export async function up(db: Db): Promise<void> {
  const collections = (await db.listCollections().toArray()).map(c => c.name);
  if (!collections.includes(COLLECTION)) {
    log.info(
      "model_catalog_snapshots collection does not exist yet, skipping",
      {
        collection: COLLECTION,
      },
    );
    return;
  }

  const col = db.collection(COLLECTION);

  const existing = await col.findOne({ _id: "curation" as any });
  if (existing) {
    log.info("Curation snapshot already exists, skipping seed");
    await col.deleteOne({ _id: "arena" as any });
    return;
  }

  const [gatewayDoc, pricingDoc, arenaDoc] = await Promise.all([
    col.findOne({ _id: "gateway" as any }),
    col.findOne({ _id: "pricing" as any }),
    col.findOne({ _id: "arena" as any }),
  ]);

  const gatewayModels = (gatewayDoc?.data ?? []) as GatewayModelNormalized[];
  const pricing = (pricingDoc?.data ?? []) as PricingEntry[];
  const arena = (arenaDoc?.data ?? []) as ArenaEntry[];

  if (gatewayModels.length === 0) {
    log.warn(
      "Gateway snapshot empty — seeding curation doc with empty model list",
    );
  }

  // Build pricing lookup
  const pricingMap = new Map<string, { input: number; output: number }>();
  for (const p of pricing) {
    pricingMap.set(p.modelId, { input: p.input, output: p.output });
  }

  // Build arena lookup (historical — we use it just to pick reasonable
  // defaults on first seed, after which arena is irrelevant)
  const arenaScores = new Map<string, number>();
  for (const a of arena) {
    for (const key of normalizeArenaName(a.model)) {
      arenaScores.set(key, a.score);
    }
  }

  // Compute today's tier for each model using the blended-cost heuristic, so
  // behavior doesn't regress on first deploy. Operators can tune afterward.
  const models: CuratedModel[] = [];
  const scored: {
    id: string;
    provider: string;
    tier: "free" | "pro";
    score: number | null;
  }[] = [];

  for (const gm of gatewayModels) {
    const p = pricingMap.get(gm.id);
    const blended = p ? (p.input + p.output) / 2 : null;
    const tier: "free" | "pro" =
      blended !== null && blended <= FREE_TIER_MAX_COST_PER_M ? "free" : "pro";
    models.push({ modelId: gm.id, visible: true, tier });
    scored.push({
      id: gm.id,
      provider: gm.provider,
      tier,
      score: lookupArenaScore(gm.id, arenaScores),
    });
  }

  const pickBest = (
    pool: typeof scored,
    preferPreferred: boolean,
  ): string | null => {
    const sorted = [...pool].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    if (preferPreferred) {
      const hit = sorted.find(
        m => DEFAULT_PREFERRED_PROVIDERS.has(m.provider) && m.score !== null,
      );
      if (hit) return hit.id;
    }
    return sorted[0]?.id ?? null;
  };

  const defaultChatModelId = pickBest(scored, true) ?? FALLBACK_FREE[0] ?? null;
  const defaultFreeChatModelId =
    pickBest(
      scored.filter(m => m.tier === "free"),
      true,
    ) ??
    FALLBACK_FREE[0] ??
    null;

  const now = new Date();
  await col.updateOne(
    { _id: "curation" as any },
    {
      $set: {
        data: {
          models,
          defaultChatModelId,
          defaultFreeChatModelId,
          lastRefreshError: null,
        },
        fetchedAt: now,
        itemCount: models.length,
      },
    },
    { upsert: true },
  );

  log.info("Seeded curation snapshot", {
    models: models.length,
    freeCount: models.filter(m => m.tier === "free").length,
    defaultChatModelId,
    defaultFreeChatModelId,
  });

  const arenaDelete = await col.deleteOne({ _id: "arena" as any });
  if (arenaDelete.deletedCount > 0) {
    log.info("Deleted legacy arena snapshot");
  }
}
