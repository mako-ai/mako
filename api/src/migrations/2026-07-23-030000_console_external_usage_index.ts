import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Index savedconsoles by workspaceId + lastExternalUsedAt for unused-console queries";

function hasIndexOnKeys(
  indexes: Array<{ key?: Record<string, unknown> }>,
  keyPattern: Record<string, number>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key ?? {}) === target);
}

export async function up(db: Db): Promise<void> {
  const collection = db.collection("savedconsoles");
  const keyPattern = { workspaceId: 1, lastExternalUsedAt: 1 };

  try {
    const existingIndexes = await collection.indexes();
    if (hasIndexOnKeys(existingIndexes, keyPattern)) {
      log.info(
        "Index { workspaceId: 1, lastExternalUsedAt: 1 } already exists on savedconsoles",
      );
      return;
    }

    await collection.createIndex(keyPattern, {
      name: "savedconsoles_workspace_last_external_used",
      background: true,
      sparse: true,
    });
    log.info(
      "Created sparse index { workspaceId: 1, lastExternalUsedAt: 1 } on savedconsoles",
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
