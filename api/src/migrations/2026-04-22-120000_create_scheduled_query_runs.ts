import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create scheduled_query_runs collection and indexes for scheduled console execution history";

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

  if (!collectionNames.includes("scheduled_query_runs")) {
    await db.createCollection("scheduled_query_runs");
    log.info("Created scheduled_query_runs collection");
  }

  const scheduledRuns = db.collection("scheduled_query_runs");
  const scheduledRunIndexes = await scheduledRuns.listIndexes().toArray();

  if (
    !hasIndexOnKeys(scheduledRunIndexes, {
      workspaceId: 1,
      consoleId: 1,
      triggeredAt: -1,
    })
  ) {
    await scheduledRuns.createIndex(
      { workspaceId: 1, consoleId: 1, triggeredAt: -1 },
      { name: "workspace_console_triggered_at_idx" },
    );
  }

  if (!hasIndexOnKeys(scheduledRunIndexes, { completedAt: 1 })) {
    await scheduledRuns.createIndex(
      { completedAt: 1 },
      { name: "completed_at_ttl_idx", expireAfterSeconds: 7776000 },
    );
  }

  if (!collectionNames.includes("savedconsoles")) {
    return;
  }

  const savedConsoles = db.collection("savedconsoles");
  const savedConsoleIndexes = await savedConsoles.listIndexes().toArray();

  if (
    !hasIndexOnKeys(savedConsoleIndexes, {
      workspaceId: 1,
      "scheduledRun.nextAt": 1,
    })
  ) {
    await savedConsoles.createIndex(
      { workspaceId: 1, "scheduledRun.nextAt": 1 },
      { name: "workspace_scheduled_next_at_idx", sparse: true },
    );
  }
}
