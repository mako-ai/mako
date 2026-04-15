import { Db } from "mongodb";

export const description =
  "Add 7-day TTL on webhook_events.receivedAt and reduce materialization_runs TTL from 30d to 7d";

const WEBHOOK_EVENTS = "webhook_events";
const MATERIALIZATION_RUNS = "materialization_runs";
const SEVEN_DAYS = 7 * 24 * 60 * 60; // 604800

type IndexInfo = {
  name: string;
  key?: Record<string, unknown>;
  expireAfterSeconds?: number;
};

function isSingleFieldIndex(index: IndexInfo, field: string): boolean {
  const key = index.key;
  if (!key) return false;
  const keys = Object.keys(key);
  return keys.length === 1 && keys[0] === field;
}

export async function up(db: Db): Promise<void> {
  const collections = (await db.listCollections().toArray()).map(c => c.name);

  // --- WebhookEvent: add 7-day TTL on receivedAt ---
  if (collections.includes(WEBHOOK_EVENTS)) {
    const col = db.collection(WEBHOOK_EVENTS);
    const indexes = (await col.indexes()) as IndexInfo[];
    const receivedAtIndexes = indexes.filter(i =>
      isSingleFieldIndex(i, "receivedAt"),
    );
    const hasDesiredTtl = receivedAtIndexes.some(
      i => i.expireAfterSeconds === SEVEN_DAYS,
    );

    if (!hasDesiredTtl) {
      for (const idx of receivedAtIndexes) {
        if (idx.expireAfterSeconds != null) {
          await col.dropIndex(idx.name);
        }
      }

      await col.createIndex(
        { receivedAt: 1 },
        {
          name: "webhook_events_ttl_7d",
          expireAfterSeconds: SEVEN_DAYS,
        },
      );
    }
  }

  // --- MaterializationRun: reduce TTL from 30d to 7d on requestedAt ---
  if (collections.includes(MATERIALIZATION_RUNS)) {
    const col = db.collection(MATERIALIZATION_RUNS);
    const indexes = (await col.indexes()) as IndexInfo[];
    const requestedAtTtlIndexes = indexes.filter(
      i => isSingleFieldIndex(i, "requestedAt") && i.expireAfterSeconds != null,
    );
    const hasDesiredTtl = requestedAtTtlIndexes.some(
      i => i.expireAfterSeconds === SEVEN_DAYS,
    );

    if (!hasDesiredTtl) {
      for (const idx of requestedAtTtlIndexes) {
        await col.dropIndex(idx.name);
      }

      await col.createIndex(
        { requestedAt: 1 },
        {
          name: "matrun_ttl_7d",
          expireAfterSeconds: SEVEN_DAYS,
        },
      );
    }
  }
}
