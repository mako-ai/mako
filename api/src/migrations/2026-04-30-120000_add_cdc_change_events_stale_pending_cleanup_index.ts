import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

const COLLECTION = "cdc_change_events";
const INDEX_NAME = "cdc_change_events_flow_materialization_webhook";

export const description =
  "Add compound index for CDC stale-pending cleanup (flowId + materializationStatus + webhookEventId)";

function hasIndexOnKeys(
  indexes: Array<{ key?: Record<string, unknown> }>,
  keyPattern: Record<string, number>,
): boolean {
  return indexes.some(
    idx => JSON.stringify(idx.key || {}) === JSON.stringify(keyPattern),
  );
}

export async function up(db: Db): Promise<void> {
  const indexes = await db.collection(COLLECTION).indexes();
  const keyPattern = {
    flowId: 1,
    materializationStatus: 1,
    webhookEventId: 1,
  };

  if (hasIndexOnKeys(indexes, keyPattern)) {
    log.info("Index already exists, skipping", {
      collection: COLLECTION,
      keyPattern,
    });
    return;
  }

  await db.collection(COLLECTION).createIndex(keyPattern, { name: INDEX_NAME });
  log.info("Created index", { collection: COLLECTION, name: INDEX_NAME });
}
