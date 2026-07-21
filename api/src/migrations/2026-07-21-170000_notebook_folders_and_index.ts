import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create notebookfolders and notebookindexes collections with indexes";

function hasIndexOnKeys(
  indexes: Array<{ key?: Record<string, unknown> }>,
  keyPattern: Record<string, unknown>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key) === target);
}

async function ensureIndex(
  collection: ReturnType<Db["collection"]>,
  keyPattern: Record<string, unknown>,
  options?: { unique?: boolean },
): Promise<void> {
  try {
    const existingIndexes = await collection.indexes();
    if (hasIndexOnKeys(existingIndexes, keyPattern)) return;
    await collection.createIndex(keyPattern, {
      background: true,
      ...(options?.unique ? { unique: true } : {}),
    });
    log.info(`Created index ${JSON.stringify(keyPattern)}`);
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

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const names = new Set(collections.map(c => c.name));

  if (!names.has("notebookfolders")) {
    await db.createCollection("notebookfolders");
    log.info("Created collection 'notebookfolders'");
  }

  if (!names.has("notebookindexes")) {
    await db.createCollection("notebookindexes");
    log.info("Created collection 'notebookindexes'");
  }

  const folders = db.collection("notebookfolders");
  await ensureIndex(folders, { workspaceId: 1, parentId: 1 });
  await ensureIndex(folders, { workspaceId: 1, access: 1 });

  const indexes = db.collection("notebookindexes");
  await ensureIndex(
    indexes,
    { workspaceId: 1, notebookId: 1 },
    { unique: true },
  );
  await ensureIndex(indexes, { workspaceId: 1, folderId: 1 });
  await ensureIndex(indexes, { workspaceId: 1, access: 1, ownerId: 1 });
}
