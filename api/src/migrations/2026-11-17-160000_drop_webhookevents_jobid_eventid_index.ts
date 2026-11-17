import { Db } from "mongodb";
import { loggers } from "../logging";
import { indexesOf } from "./index-helpers";

export const description =
  "Drop the legacy unique webhookevents { jobId, eventId } index, which made an event id unique across all flows";

const log = loggers.migration();

const COLLECTION = "webhookevents";
const LEGACY_KEY = { jobId: 1, eventId: 1 } as const;

/**
 * A leftover from the job-based webhook model. No schema declares it and no
 * event carries `jobId` (0 of all events in production on 2026-11-17), so it
 * was a unique index on `{ null, eventId }`: one event id across ALL flows.
 *
 * Close sends the same event id to every subscription on the org. With two
 * flows on one Close org (a built-in flow and its boxed shadow), the first
 * flow to store an event won and the other's insert hit E11000, answered
 * 200 as a duplicate, and dropped the event. Each flow lost roughly half its
 * events. `{ flowId, eventId }` (unique, declared in models/webhooks.ts) is
 * the real dedup key and stays.
 *
 * Idempotent: a no-op once the index is gone.
 */
export async function up(db: Db): Promise<void> {
  const collection = db.collection(COLLECTION);
  let indexes: { key: Record<string, unknown>; name?: string }[];
  try {
    indexes = await indexesOf(collection);
  } catch {
    return; // NamespaceNotFound: nothing to drop.
  }
  const target = JSON.stringify(LEGACY_KEY);
  const legacy = indexes.find(index => JSON.stringify(index.key) === target);
  if (!legacy?.name) {
    log.info("Legacy index absent, skipping", { collection: COLLECTION });
    return;
  }
  await collection.dropIndex(legacy.name);
  log.info("Dropped legacy index", {
    collection: COLLECTION,
    name: legacy.name,
  });
}
