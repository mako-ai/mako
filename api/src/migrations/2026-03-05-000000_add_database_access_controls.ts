import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Add access controls to database connections: backfill ownerId from createdBy, add compound index";

export async function up(db: Db): Promise<void> {
  const collection = db.collection("databaseconnections");

  // Backfill ownerId from createdBy for all existing documents that lack it
  const backfillResult = await collection.updateMany(
    { ownerId: { $exists: false } },
    [{ $set: { ownerId: "$createdBy" } }],
  );
  log.info(
    `Backfilled ownerId for ${backfillResult.modifiedCount} database connections`,
  );

  // Set default access to "shared_write" for existing records without it
  const accessResult = await collection.updateMany(
    { access: { $exists: false } },
    { $set: { access: "shared_write" } },
  );
  log.info(
    `Set default access for ${accessResult.modifiedCount} database connections`,
  );

  // Initialize empty sharedWith array where missing
  const sharedWithResult = await collection.updateMany(
    { sharedWith: { $exists: false } },
    { $set: { sharedWith: [] } },
  );
  log.info(
    `Initialized sharedWith for ${sharedWithResult.modifiedCount} database connections`,
  );

  // Add compound index for access-based queries
  const indexes = await collection.listIndexes().toArray();
  const hasIndex = indexes.some(idx => {
    const keys = Object.keys(idx.key);
    return (
      keys.length === 3 &&
      idx.key.workspaceId === 1 &&
      idx.key.access === 1 &&
      idx.key.ownerId === 1
    );
  });

  if (!hasIndex) {
    await collection.createIndex(
      { workspaceId: 1, access: 1, ownerId: 1 },
      { name: "workspace_access_owner_idx" },
    );
    log.info("Created index: workspace_access_owner_idx");
  } else {
    log.info("Index workspace_access_owner_idx already exists");
  }

  log.info("Migration complete: database access controls added");
}

export async function down(db: Db): Promise<void> {
  const collection = db.collection("databaseconnections");

  // Remove the added fields
  await collection.updateMany(
    {},
    { $unset: { access: "", ownerId: "", sharedWith: "" } },
  );
  log.info("Removed access, ownerId, sharedWith fields");

  // Drop the index
  try {
    await collection.dropIndex("workspace_access_owner_idx");
    log.info("Dropped index: workspace_access_owner_idx");
  } catch {
    log.info("Index workspace_access_owner_idx not found, skipping");
  }
}
