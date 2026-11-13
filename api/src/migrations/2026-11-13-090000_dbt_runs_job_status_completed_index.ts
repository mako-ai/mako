import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

const COLLECTION = "dbt_runs";
const KEYS = { jobId: 1, status: 1, completedAt: -1 } as const;
// The name Mongoose autoIndex gives the same index (workspace-schema.ts), so
// whichever of the two runs first, the other finds it in place.
const INDEX_NAME = "jobId_1_status_1_completedAt_-1";

/**
 * dbt job notifications read two runs per finished job run: the previous
 * terminal run of the job and its last success, both in completion order
 * (dbt/dbt-run-notify.ts). Runs of one job can finish out of creation order,
 * so the existing { jobId, createdAt } index cannot answer either. Without
 * this index each lookup sorts every run of the job in memory, and a run
 * document carries up to 5,000 log lines.
 *
 * Idempotent. No backfill: the index holds no new data.
 */
export const description =
  "Add { jobId, status, completedAt } index on dbt_runs for a job's runs in completion order";

function hasIndexOnKeys(
  indexes: Array<{ key?: Record<string, unknown> }>,
  keyPattern: Record<string, number>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key ?? {}) === target);
}

export async function up(db: Db): Promise<void> {
  const names = new Set(
    (await db.listCollections().toArray()).map(c => c.name),
  );
  if (!names.has(COLLECTION)) {
    // Mongoose creates the collection and this index on first use.
    log.info("dbt_runs collection not found, skipping", {
      collection: COLLECTION,
    });
    return;
  }
  const collection = db.collection(COLLECTION);
  const indexes = await collection.indexes();
  if (hasIndexOnKeys(indexes, KEYS)) {
    log.info("dbt_runs completion-order index already present, skipping", {
      collection: COLLECTION,
    });
    return;
  }
  await collection.createIndex(KEYS, { name: INDEX_NAME });
  log.info("Created dbt_runs completion-order index", {
    collection: COLLECTION,
    name: INDEX_NAME,
  });
}
