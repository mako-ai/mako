import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Add TTL index on webhookevents.receivedAt to auto-expire documents after 7 days";

export async function up(db: Db): Promise<void> {
  const collection = db.collection("webhookevents");

  const indexes = await collection.indexes();
  const hasIndex = indexes.some(
    idx => JSON.stringify(idx.key) === JSON.stringify({ receivedAt: 1 }),
  );

  if (!hasIndex) {
    await collection.createIndex(
      { receivedAt: 1 },
      {
        expireAfterSeconds: 7 * 24 * 60 * 60,
        name: "webhookevents_receivedAt_ttl_7d",
      },
    );
    log.info("Created TTL index on webhookevents.receivedAt (7 days)");
  } else {
    log.info("TTL index on webhookevents.receivedAt already exists");
  }
}
