import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create mcp_oauth_flows collection (pending OAuth redirects, TTL 10min)";

function hasIndexOnKeys(
  indexes: { key: Record<string, number | string> }[],
  keyPattern: Record<string, number | string>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key) === target);
}

export async function up(db: Db): Promise<void> {
  const existing = await db
    .listCollections({ name: "mcp_oauth_flows" })
    .toArray();
  if (existing.length === 0) {
    await db.createCollection("mcp_oauth_flows");
    log.info("Created 'mcp_oauth_flows' collection");
  }

  const col = db.collection("mcp_oauth_flows");
  const indexes = await col.indexes();
  if (!hasIndexOnKeys(indexes, { state: 1 })) {
    await col.createIndex(
      { state: 1 },
      { unique: true, name: "mcp_oauth_flows_state_unique" },
    );
    log.info("Created unique index on mcp_oauth_flows { state }");
  }
  if (!hasIndexOnKeys(indexes, { createdAt: 1 })) {
    await col.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 600, name: "mcp_oauth_flows_ttl" },
    );
    log.info("Created TTL index on mcp_oauth_flows { createdAt }");
  }
}
