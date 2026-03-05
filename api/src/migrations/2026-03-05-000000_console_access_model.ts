import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Add access model fields (access, owner_id, shared_with) to saved consoles and create index";

/**
 * Migration: Console access model
 *
 * Adds:
 * - `access`: 'private' | 'shared_read' | 'shared_write' — source of truth for visibility
 * - `owner_id`: backfilled from `createdBy` — tracks the console creator
 * - `shared_with`: array of workspace member ObjectIds (optional fine-grained sharing)
 *
 * Backward compatibility:
 * - `isPrivate: true` → `access: 'private'`
 * - `isPrivate: false` (or missing) → `access: 'workspace'`
 * - `isPrivate` field is kept but deprecated
 *
 * Also creates index: { workspaceId: 1, access: 1, owner_id: 1 }
 */
export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("savedconsoles")) {
    log.info("Collection 'savedconsoles' not found, skipping migration.");
    return;
  }

  const col = db.collection("savedconsoles");

  // 1. Backfill owner_id from createdBy where missing
  const ownerResult = await col.updateMany({ owner_id: { $exists: false } }, [
    { $set: { owner_id: "$createdBy" } },
  ]);
  log.info(`Backfilled owner_id for ${ownerResult.modifiedCount} consoles`);

  // 2. Set access = 'private' for consoles where isPrivate === true
  const privateResult = await col.updateMany(
    { isPrivate: true, access: { $exists: false } },
    { $set: { access: "private" } },
  );
  log.info(
    `Set access='private' for ${privateResult.modifiedCount} private consoles`,
  );

  // 3. Set access = 'workspace' for consoles where isPrivate !== true (false or missing)
  const sharedResult = await col.updateMany(
    { isPrivate: { $ne: true }, access: { $exists: false } },
    { $set: { access: "workspace" } },
  );
  log.info(
    `Set access='workspace' for ${sharedResult.modifiedCount} shared consoles`,
  );

  // 4. Initialize empty shared_with array where missing
  const sharedWithResult = await col.updateMany(
    { shared_with: { $exists: false } },
    { $set: { shared_with: [] } },
  );
  log.info(
    `Initialized shared_with for ${sharedWithResult.modifiedCount} consoles`,
  );

  // 5. Create compound index for access model queries (idempotent)
  try {
    const existingIndexes = await col.indexes();
    const alreadyExists = existingIndexes.some(
      idx =>
        idx.key &&
        idx.key.workspaceId === 1 &&
        idx.key.access === 1 &&
        idx.key.owner_id === 1,
    );

    if (alreadyExists) {
      log.info(
        "Index on { workspaceId, access, owner_id } already exists, skipping creation",
      );
    } else {
      await col.createIndex(
        { workspaceId: 1, access: 1, owner_id: 1 },
        { background: true },
      );
      log.info("Created index: { workspaceId: 1, access: 1, owner_id: 1 }");
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
