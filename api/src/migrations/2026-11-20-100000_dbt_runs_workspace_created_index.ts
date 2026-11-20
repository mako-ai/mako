import { Db } from "mongodb";
import { loggers } from "../logging";
import { indexesOf } from "./index-helpers";

export const description =
  "Index dbt_runs { workspaceId, createdAt } so recent runs of a workspace (and who started them) read in one query";

const log = loggers.migration();

const COLLECTION = "dbt_runs";
const KEY = { workspaceId: 1, createdAt: -1 } as const;

/**
 * "Who started this dbt run" is asked across projects, so the existing
 * { workspaceId, projectId, createdAt } index cannot serve it. Idempotent
 * (checked by key pattern); Mongoose builds the same index where autoIndex is on.
 */
export async function up(db: Db): Promise<void> {
  const collection = db.collection(COLLECTION);
  const indexes = await indexesOf(collection);
  const target = JSON.stringify(KEY);
  if (indexes.some(index => JSON.stringify(index.key) === target)) {
    log.info("Index already present, skipping", {
      collection: COLLECTION,
      key: KEY,
    });
    return;
  }
  await collection.createIndex({ ...KEY });
  log.info("Created index", { collection: COLLECTION, key: KEY });
}
