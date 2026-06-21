import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

const COLLECTION = "webhookevents";
const INDEX_NAME = "status_1_receivedAt_1";

type IndexInfo = {
  name: string;
  key?: Record<string, unknown>;
};

/**
 * The CDC cron-ingest step (cdcMaterializeSchedulerFunction) runs a GLOBAL
 *   WebhookEvent.find({ status: "pending" }).sort({ receivedAt: 1 }).limit(1000)
 * every few minutes. The existing indexes are all prefixed by `flowId`
 * ({ flowId, status, receivedAt }), so a query that does not constrain
 * `flowId` cannot use them — it falls back to a COLLSCAN + in-memory sort
 * over the entire webhookevents collection, which gets slower as the pending
 * backlog grows and starves the single-concurrency scheduler.
 *
 * This adds the matching { status: 1, receivedAt: 1 } index so the ingest
 * query is a bounded index scan.
 */
export const description =
  "Add { status, receivedAt } index on webhookevents for the global CDC cron-ingest query";

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
    log.info("webhookevents collection not found, skipping", {
      collection: COLLECTION,
    });
    return;
  }

  const col = db.collection(COLLECTION);
  const indexes = (await col.indexes()) as IndexInfo[];

  if (hasIndexOnKeys(indexes, { status: 1, receivedAt: 1 })) {
    log.info("status/receivedAt index already present, skipping", {
      collection: COLLECTION,
    });
    return;
  }

  await col.createIndex({ status: 1, receivedAt: 1 }, { name: INDEX_NAME });
  log.info("Created webhookevents status/receivedAt index", {
    collection: COLLECTION,
    name: INDEX_NAME,
  });
}
