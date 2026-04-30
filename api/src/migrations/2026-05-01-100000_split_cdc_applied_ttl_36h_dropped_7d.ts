import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

const COLLECTION = "cdc_change_events";

const OLD_TTL_INDEX_NAME = "cdc_applied_events_ttl_7d";
const APPLIED_TTL_INDEX_NAME = "cdc_applied_events_ttl_36h";
const DROPPED_TTL_INDEX_NAME = "cdc_dropped_events_ttl_7d";

const APPLIED_TTL_SECONDS = 36 * 60 * 60;
const DROPPED_TTL_SECONDS = 7 * 24 * 60 * 60;

type IndexInfo = {
  name: string;
  key?: Record<string, unknown>;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
};

function isAppliedAtAscendingOnly(index: IndexInfo): boolean {
  if (!index.key || typeof index.key !== "object") return false;
  const keys = Object.entries(index.key);
  return keys.length === 1 && keys[0][0] === "appliedAt" && keys[0][1] === 1;
}

function partialOnlyAppliedAtExists(
  partial?: Record<string, unknown>,
): boolean {
  if (!partial || typeof partial !== "object") return false;
  const applied = partial.appliedAt as Record<string, unknown> | undefined;
  return Boolean(
    applied && applied.$exists === true && Object.keys(partial).length === 1,
  );
}

function partialAppliedWithStatus(
  partial: Record<string, unknown> | undefined,
  status: string,
): boolean {
  if (!partial || typeof partial !== "object") return false;
  const applied = partial.appliedAt as Record<string, unknown> | undefined;
  return (
    Boolean(applied && applied.$exists === true) &&
    partial.materializationStatus === status
  );
}

function hasAppliedAtTtlForStatus(
  indexes: IndexInfo[],
  materializationStatus: string,
  expireAfterSeconds: number,
): boolean {
  return indexes.some(
    idx =>
      isAppliedAtAscendingOnly(idx) &&
      (idx.expireAfterSeconds || 0) === expireAfterSeconds &&
      partialAppliedWithStatus(
        idx.partialFilterExpression,
        materializationStatus,
      ),
  );
}

export const description =
  "Replace single CDC appliedAt TTL with 36h (applied) and 7d (dropped) partial TTL indexes";

export async function up(db: Db): Promise<void> {
  const names = new Set(
    (await db.listCollections().toArray()).map(c => c.name),
  );
  if (!names.has(COLLECTION)) {
    log.info("CDC change events collection not found, skipping", {
      collection: COLLECTION,
    });
    return;
  }

  const col = db.collection(COLLECTION);
  const indexes = (await col.indexes()) as IndexInfo[];

  for (const index of indexes) {
    if (!isAppliedAtAscendingOnly(index)) continue;
    const exp = index.expireAfterSeconds;
    if (typeof exp !== "number") continue;

    const isOldCombined =
      index.name === OLD_TTL_INDEX_NAME ||
      partialOnlyAppliedAtExists(index.partialFilterExpression);

    if (isOldCombined) {
      try {
        await col.dropIndex(index.name);
        log.info("Dropped legacy CDC appliedAt TTL index", {
          collection: COLLECTION,
          index: index.name,
        });
      } catch (error) {
        log.warn("Failed to drop legacy CDC appliedAt TTL index", {
          collection: COLLECTION,
          index: index.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const refreshed = (await col.indexes()) as IndexInfo[];

  const hasApplied = hasAppliedAtTtlForStatus(
    refreshed,
    "applied",
    APPLIED_TTL_SECONDS,
  );
  if (!hasApplied) {
    await col.createIndex(
      { appliedAt: 1 },
      {
        name: APPLIED_TTL_INDEX_NAME,
        expireAfterSeconds: APPLIED_TTL_SECONDS,
        partialFilterExpression: {
          appliedAt: { $exists: true },
          materializationStatus: "applied",
        },
      },
    );
    log.info("Created CDC applied TTL index", {
      collection: COLLECTION,
      name: APPLIED_TTL_INDEX_NAME,
      expireAfterSeconds: APPLIED_TTL_SECONDS,
    });
  }

  const afterApplied = (await col.indexes()) as IndexInfo[];

  const hasDropped = hasAppliedAtTtlForStatus(
    afterApplied,
    "dropped",
    DROPPED_TTL_SECONDS,
  );
  if (!hasDropped) {
    await col.createIndex(
      { appliedAt: 1 },
      {
        name: DROPPED_TTL_INDEX_NAME,
        expireAfterSeconds: DROPPED_TTL_SECONDS,
        partialFilterExpression: {
          appliedAt: { $exists: true },
          materializationStatus: "dropped",
        },
      },
    );
    log.info("Created CDC dropped TTL index", {
      collection: COLLECTION,
      name: DROPPED_TTL_INDEX_NAME,
      expireAfterSeconds: DROPPED_TTL_SECONDS,
    });
  }
}
