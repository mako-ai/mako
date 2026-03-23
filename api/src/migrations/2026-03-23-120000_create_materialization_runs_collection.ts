import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create materialization_runs collection with indexes for dashboard rebuild history";

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(collection => collection.name);

  if (!collectionNames.includes("materialization_runs")) {
    await db.createCollection("materialization_runs");
    log.info("Created materialization_runs collection");
  }

  const collection = db.collection("materialization_runs");
  const indexes = await collection.listIndexes().toArray();
  const hasIndex = (name: string) => indexes.some(index => index.name === name);

  if (!hasIndex("dashboard_datasource_time_idx")) {
    await collection.createIndex(
      { dashboardId: 1, dataSourceId: 1, requestedAt: -1 },
      { name: "dashboard_datasource_time_idx" },
    );
  }

  if (!hasIndex("workspace_time_idx")) {
    await collection.createIndex(
      { workspaceId: 1, requestedAt: -1 },
      { name: "workspace_time_idx" },
    );
  }

  if (!hasIndex("ttl_idx")) {
    await collection.createIndex(
      { requestedAt: 1 },
      { name: "ttl_idx", expireAfterSeconds: 2592000 },
    );
  }
}
