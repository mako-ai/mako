import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

const COLLECTION = "dashboards";
const INDEX_NAME = "workspaceId_1_creationIdempotencyKey_1";

type IndexInfo = {
  name: string;
  key?: Record<string, unknown>;
};

/**
 * Dashboard creation idempotency: the agent's create_dashboard tool executes
 * client-side, and multiple browser windows attached to the same resumable
 * chat stream each dispatch the same tool call — producing duplicate
 * dashboards. The create route now accepts the toolCallId as an idempotency
 * key (persisted as `creationIdempotencyKey`); this unique PARTIAL index
 * makes the concurrent second insert a duplicate-key error the route turns
 * into "return the existing dashboard".
 *
 * Partial (not sparse) on purpose: a sparse COMPOUND index still indexes
 * documents that have `workspaceId` but no key, so every keyless dashboard
 * in a workspace would collide with the next one.
 */
export const description =
  "Add unique partial { workspaceId, creationIdempotencyKey } index on dashboards for create idempotency";

function hasIndexOnKeys(
  indexes: IndexInfo[],
  keyPattern: Record<string, number>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key) === target);
}

export async function up(db: Db): Promise<void> {
  const names = new Set(
    (await db.listCollections().toArray()).map(c => c.name),
  );
  if (!names.has(COLLECTION)) {
    log.info("dashboards collection not found, skipping", {
      collection: COLLECTION,
    });
    return;
  }

  const col = db.collection(COLLECTION);
  const indexes = (await col.indexes()) as IndexInfo[];

  if (hasIndexOnKeys(indexes, { workspaceId: 1, creationIdempotencyKey: 1 })) {
    log.info("creation idempotency index already present, skipping", {
      collection: COLLECTION,
    });
    return;
  }

  await col.createIndex(
    { workspaceId: 1, creationIdempotencyKey: 1 },
    {
      name: INDEX_NAME,
      unique: true,
      partialFilterExpression: { creationIdempotencyKey: { $type: "string" } },
    },
  );
  log.info("Created dashboards creation idempotency index", {
    collection: COLLECTION,
    name: INDEX_NAME,
  });
}
