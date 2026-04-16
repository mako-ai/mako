import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Reduce materialization_runs TTL from 30 days to 7 days on requestedAt";

const COLLECTION = "materialization_runs";
const SEVEN_DAYS = 7 * 24 * 60 * 60;

export async function up(db: Db): Promise<void> {
  const collections = (await db.listCollections().toArray()).map(c => c.name);
  if (!collections.includes(COLLECTION)) {
    log.info("Collection does not exist, skipping", { collection: COLLECTION });
    return;
  }

  const col = db.collection(COLLECTION);
  const indexes = await col.indexes();

  const requestedAtTtl = indexes.find(
    idx =>
      JSON.stringify(idx.key) === JSON.stringify({ requestedAt: 1 }) &&
      idx.expireAfterSeconds != null,
  );

  if (requestedAtTtl && requestedAtTtl.expireAfterSeconds === SEVEN_DAYS) {
    log.info("TTL index already set to 7 days, skipping");
    return;
  }

  if (requestedAtTtl && requestedAtTtl.name) {
    await col.dropIndex(requestedAtTtl.name);
    log.info("Dropped old TTL index", { name: requestedAtTtl.name });
  }

  await col.createIndex(
    { requestedAt: 1 },
    {
      expireAfterSeconds: SEVEN_DAYS,
      name: "matrun_requestedAt_ttl_7d",
    },
  );
  log.info("Created TTL index on materialization_runs.requestedAt (7 days)");
}
