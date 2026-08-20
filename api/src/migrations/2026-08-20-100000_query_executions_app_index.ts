import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Index query_executions by workspaceId + appId + executedAt for per-app cost aggregation";

function hasIndexOnKeys(
  indexes: Array<{ key?: Record<string, unknown> }>,
  keyPattern: Record<string, number>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key ?? {}) === target);
}

export async function up(db: Db): Promise<void> {
  const collection = db.collection("query_executions");
  const keyPattern = { workspaceId: 1, appId: 1, executedAt: -1 };

  try {
    const existingIndexes = await collection.indexes();
    if (hasIndexOnKeys(existingIndexes, keyPattern)) {
      log.info(
        "Index { workspaceId: 1, appId: 1, executedAt: -1 } already exists on query_executions",
      );
      return;
    }

    await collection.createIndex(keyPattern, {
      name: "query_executions_workspace_app_executed",
      background: true,
      sparse: true,
    });
    log.info(
      "Created sparse index { workspaceId: 1, appId: 1, executedAt: -1 } on query_executions",
    );
  } catch (err: unknown) {
    const code = (err as { code?: number; codeName?: string })?.code;
    const codeName = (err as { codeName?: string })?.codeName;
    if (code === 85 || codeName === "IndexOptionsConflict") {
      log.info("Index already exists under a different name, skipping");
      return;
    }
    throw err;
  }
}
