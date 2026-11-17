import { Db } from "mongodb";
import { loggers } from "../logging";
import { indexesOf } from "./index-helpers";

export const description =
  "Index flow_parity_checks by shadow and live flow, and expire checks after 30 days";

const log = loggers.migration();

const COLLECTION = "flow_parity_checks";

const INDEXES: Array<{
  key: Record<string, 1 | -1>;
  options?: { name: string; expireAfterSeconds: number };
}> = [
  { key: { shadowFlowId: 1, startedAt: -1 } },
  { key: { flowId: 1, startedAt: -1 } },
  {
    key: { startedAt: 1 },
    options: {
      name: "flow_parity_checks_ttl_30d",
      expireAfterSeconds: 30 * 24 * 60 * 60,
    },
  },
];

/**
 * The parity checks of boxed shadows (connectors/boxed-runtime). Idempotent
 * (checked by key pattern), and safe before or after the code that declares
 * them is live. Mongoose builds them on start where autoIndex is on.
 */
export async function up(db: Db): Promise<void> {
  const collection = db.collection(COLLECTION);
  let indexes: { key: Record<string, unknown> }[] = [];
  try {
    indexes = await indexesOf(collection);
  } catch {
    // NamespaceNotFound: nothing exists yet, so nothing can conflict.
  }
  for (const index of INDEXES) {
    const target = JSON.stringify(index.key);
    if (indexes.some(existing => JSON.stringify(existing.key) === target)) {
      log.info("Index already present, skipping", {
        collection: COLLECTION,
        key: index.key,
      });
      continue;
    }
    await collection.createIndex(index.key, index.options ?? {});
    log.info("Created index", { collection: COLLECTION, key: index.key });
  }
}
