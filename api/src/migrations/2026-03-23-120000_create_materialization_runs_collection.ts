import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create materialization_runs collection with indexes for dashboard rebuild history";

function hasIndexOnKeys(
  indexes: { key: Record<string, number> }[],
  keyPattern: Record<string, number>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key) === target);
}

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(collection => collection.name);

  if (!collectionNames.includes("materialization_runs")) {
    await db.createCollection("materialization_runs");
    log.info("Created materialization_runs collection");
  }

  const collection = db.collection("materialization_runs");
  const indexes = await collection.listIndexes().toArray();

  if (
    !hasIndexOnKeys(indexes, {
      dashboardId: 1,
      dataSourceId: 1,
      requestedAt: -1,
    })
  ) {
    await collection.createIndex(
      { dashboardId: 1, dataSourceId: 1, requestedAt: -1 },
      { name: "dashboard_datasource_time_idx" },
    );
  }

  if (!hasIndexOnKeys(indexes, { workspaceId: 1, requestedAt: -1 })) {
    await collection.createIndex(
      { workspaceId: 1, requestedAt: -1 },
      { name: "workspace_time_idx" },
    );
  }

  if (!hasIndexOnKeys(indexes, { requestedAt: 1 })) {
    await collection.createIndex(
      { requestedAt: 1 },
      { name: "ttl_idx", expireAfterSeconds: 2592000 },
    );
  }
}
