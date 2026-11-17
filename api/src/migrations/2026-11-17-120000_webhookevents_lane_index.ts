import { Db } from "mongodb";
import { loggers } from "../logging";
import { indexesOf } from "./index-helpers";

export const description =
  "Index webhookevents { status, lane, receivedAt } for the inline CDC cron and the box-lane webhook batch sweep";

const log = loggers.migration();

const COLLECTION = "webhookevents";
const KEY = { status: 1, lane: 1, receivedAt: 1 } as const;

/**
 * The CDC cron ingests `{ status: "pending", lane: null }` oldest first, and
 * the webhook batch sweep finds `{ status: "pending", lane: "box" }`. One
 * index serves both, so a backlog of box-lane events is never scanned by the
 * inline cron (connectors/workspace/webhook-batch.ts).
 *
 * Idempotent (checked by key pattern) and safe before or after the code that
 * declares it is live. Mongoose builds it on start where autoIndex is on.
 */
export async function up(db: Db): Promise<void> {
  const collection = db.collection(COLLECTION);
  let indexes: { key: Record<string, unknown> }[] = [];
  try {
    indexes = await indexesOf(collection);
  } catch {
    // NamespaceNotFound: nothing exists yet, so nothing can conflict.
  }
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
