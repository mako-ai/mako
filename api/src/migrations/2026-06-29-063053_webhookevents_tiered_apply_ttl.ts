import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

const COLLECTION = "webhookevents";

const APPLIED_TTL_INDEX_NAME = "webhookevents_applied_ttl_3d";
const PENDING_TTL_INDEX_NAME = "webhookevents_pending_ttl_7d";
const DROPPED_TTL_INDEX_NAME = "webhookevents_dropped_ttl_7d";
const FAILED_TTL_INDEX_NAME = "webhookevents_failed_ttl_30d";

const THREE_DAYS = 3 * 24 * 60 * 60;
const SEVEN_DAYS = 7 * 24 * 60 * 60;
const THIRTY_DAYS = 30 * 24 * 60 * 60;

type IndexInfo = {
  name: string;
  key?: Record<string, unknown>;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
};

type Tier = {
  name: string;
  expireAfterSeconds: number;
  applyStatus: "applied" | "pending" | "dropped" | "failed";
};

const TIERS: Tier[] = [
  { name: APPLIED_TTL_INDEX_NAME, expireAfterSeconds: THREE_DAYS, applyStatus: "applied" },
  { name: PENDING_TTL_INDEX_NAME, expireAfterSeconds: SEVEN_DAYS, applyStatus: "pending" },
  { name: DROPPED_TTL_INDEX_NAME, expireAfterSeconds: SEVEN_DAYS, applyStatus: "dropped" },
  { name: FAILED_TTL_INDEX_NAME, expireAfterSeconds: THIRTY_DAYS, applyStatus: "failed" },
];

function isReceivedAtAscendingOnly(index: IndexInfo): boolean {
  if (!index.key || typeof index.key !== "object") return false;
  const keys = Object.entries(index.key);
  return keys.length === 1 && keys[0][0] === "receivedAt" && keys[0][1] === 1;
}

function partialAppliesToStatus(
  partial: Record<string, unknown> | undefined,
  applyStatus: string,
): boolean {
  if (!partial || typeof partial !== "object") return false;
  return partial.applyStatus === applyStatus;
}

function hasTierTtl(indexes: IndexInfo[], tier: Tier): boolean {
  return indexes.some(
    idx =>
      isReceivedAtAscendingOnly(idx) &&
      (idx.expireAfterSeconds || 0) === tier.expireAfterSeconds &&
      partialAppliesToStatus(idx.partialFilterExpression, tier.applyStatus),
  );
}

export const description =
  "Replace flat webhookevents.receivedAt TTL with applyStatus-tiered partial TTL indexes (applied 3d, pending 7d, dropped 7d, failed 30d)";

export async function up(db: Db): Promise<void> {
  const names = new Set(
    (await db.listCollections().toArray()).map(c => c.name),
  );
  if (!names.has(COLLECTION)) {
    log.info("webhookevents collection not found, skipping", {
      collection: COLLECTION,
    });
    return;
  }

  const col = db.collection(COLLECTION);
  const indexes = (await col.indexes()) as IndexInfo[];

  // Drop any legacy flat TTL on { receivedAt: 1 } (no applyStatus partial filter).
  // Covers both Mongoose's auto name (receivedAt_1) and the migration-created
  // webhookevents_receivedAt_ttl_7d.
  for (const index of indexes) {
    if (!isReceivedAtAscendingOnly(index)) continue;
    if (typeof index.expireAfterSeconds !== "number") continue;
    const partial = index.partialFilterExpression;
    const isFlatTtl =
      !partial || typeof partial !== "object" || partial.applyStatus == null;
    if (!isFlatTtl) continue;

    try {
      await col.dropIndex(index.name);
      log.info("Dropped legacy flat webhookevents receivedAt TTL index", {
        collection: COLLECTION,
        index: index.name,
      });
    } catch (error) {
      log.warn("Failed to drop legacy flat webhookevents TTL index", {
        collection: COLLECTION,
        index: index.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const tier of TIERS) {
    const refreshed = (await col.indexes()) as IndexInfo[];
    if (hasTierTtl(refreshed, tier)) {
      log.info("webhookevents tiered TTL index already present, skipping", {
        collection: COLLECTION,
        name: tier.name,
      });
      continue;
    }

    await col.createIndex(
      { receivedAt: 1 },
      {
        name: tier.name,
        expireAfterSeconds: tier.expireAfterSeconds,
        partialFilterExpression: { applyStatus: tier.applyStatus },
      },
    );
    log.info("Created webhookevents tiered TTL index", {
      collection: COLLECTION,
      name: tier.name,
      expireAfterSeconds: tier.expireAfterSeconds,
      applyStatus: tier.applyStatus,
    });
  }
}
