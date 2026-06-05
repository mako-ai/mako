import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Initialize sharedWith collaborator array on dashboards and create lookup index";

/**
 * Migration: Dashboard per-user collaborators
 *
 * Backfills `sharedWith: []` for all dashboards missing the field so that
 * collaborator lookups never hit `undefined`. Creates index:
 * { workspaceId: 1, "sharedWith.userId": 1 } for fast "shared with me" queries.
 */
function hasIndexOnKeys(
  indexes: Array<{ key?: Record<string, unknown> }>,
  keyPattern: Record<string, unknown>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => idx.key && JSON.stringify(idx.key) === target);
}

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("dashboards")) {
    log.info("Collection 'dashboards' not found, skipping migration.");
    return;
  }

  const col = db.collection("dashboards");

  const result = await col.updateMany(
    { sharedWith: { $exists: false } },
    { $set: { sharedWith: [] } },
  );
  log.info(`Initialized sharedWith=[] for ${result.modifiedCount} dashboards`);

  const keyPattern = { workspaceId: 1, "sharedWith.userId": 1 };
  try {
    const existingIndexes = await col.indexes();
    if (hasIndexOnKeys(existingIndexes, keyPattern)) {
      log.info(
        'Index on { workspaceId, "sharedWith.userId" } already exists, skipping creation',
      );
    } else {
      await col.createIndex(keyPattern, { background: true });
      log.info('Created index: { workspaceId: 1, "sharedWith.userId": 1 }');
    }
  } catch (err: any) {
    if (err?.code === 85 || err?.codeName === "IndexOptionsConflict") {
      log.info(
        "Index already exists (possibly under a different name), skipping",
      );
    } else {
      throw err;
    }
  }
}
