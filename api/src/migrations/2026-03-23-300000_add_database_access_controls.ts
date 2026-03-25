import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Add access model fields (access, ownerId, sharedWith) to database connections";

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("databaseconnections")) {
    log.info("Collection 'databaseconnections' not found, skipping migration.");
    return;
  }

  const col = db.collection("databaseconnections");

  const ownerResult = await col.updateMany({ ownerId: { $exists: false } }, [
    { $set: { ownerId: "$createdBy" } },
  ]);
  log.info(
    `Backfilled ownerId for ${ownerResult.modifiedCount} database connections`,
  );

  const accessResult = await col.updateMany(
    { access: { $exists: false } },
    { $set: { access: "shared" } },
  );
  log.info(`Set access='shared' for ${accessResult.modifiedCount} connections`);

  const permissionsResult = await col.updateMany(
    { permissions: { $exists: false } },
    { $set: { permissions: "read_write" } },
  );
  log.info(
    `Set permissions='read_write' for ${permissionsResult.modifiedCount} connections`,
  );

  const sharedWithResult = await col.updateMany(
    { sharedWith: { $exists: false } },
    { $set: { sharedWith: [] } },
  );
  log.info(
    `Initialized sharedWith for ${sharedWithResult.modifiedCount} connections`,
  );

  try {
    const existingIndexes = await col.indexes();
    const alreadyExists = existingIndexes.some(
      idx =>
        idx.key &&
        idx.key.workspaceId === 1 &&
        idx.key.access === 1 &&
        idx.key.ownerId === 1,
    );

    if (alreadyExists) {
      log.info(
        "Index on { workspaceId, access, ownerId } already exists, skipping",
      );
    } else {
      await col.createIndex(
        { workspaceId: 1, access: 1, ownerId: 1 },
        { background: true, name: "workspace_access_owner_idx" },
      );
      log.info("Created index: { workspaceId: 1, access: 1, ownerId: 1 }");
    }
  } catch (err: any) {
    if (err?.code === 85 || err?.codeName === "IndexOptionsConflict") {
      log.info("Index already exists under a different name, skipping");
    } else {
      throw err;
    }
  }
}

export async function down(db: Db): Promise<void> {
  const col = db.collection("databaseconnections");

  await col.updateMany(
    {},
    { $unset: { access: "", permissions: "", ownerId: "", sharedWith: "" } },
  );
  log.info(
    "Removed access, permissions, ownerId, sharedWith from all connections",
  );

  try {
    await col.dropIndex("workspace_access_owner_idx");
    log.info("Dropped workspace_access_owner_idx index");
  } catch {
    log.info("Index workspace_access_owner_idx not found, skipping drop");
  }
}
