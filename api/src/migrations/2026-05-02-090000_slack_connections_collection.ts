import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create slack_connections collection with unique workspaceId index";

function hasIndexOnKeys(
  indexes: { key: Record<string, number> }[],
  keyPattern: Record<string, number>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key) === target);
}

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const names = collections.map(c => c.name);

  if (!names.includes("slack_connections")) {
    await db.createCollection("slack_connections");
    log.info("Created slack_connections collection");
  }

  const coll = db.collection("slack_connections");
  const indexes = await coll.listIndexes().toArray();

  if (!hasIndexOnKeys(indexes, { workspaceId: 1 })) {
    await coll.createIndex(
      { workspaceId: 1 },
      { name: "slack_connections_workspace_unique", unique: true },
    );
  }
}
