import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Backfill owner_id from createdBy on dashboards and create access index";

/**
 * Migration: Dashboard access model
 *
 * Backfills `owner_id` from `createdBy` for all dashboards that don't
 * have it yet. Ensures `access` defaults to 'private' for documents
 * missing the field. Creates index: { workspaceId: 1, access: 1, owner_id: 1 }.
 */
export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("dashboards")) {
    log.info("Collection 'dashboards' not found, skipping migration.");
    return;
  }

  const col = db.collection("dashboards");

  const ownerResult = await col.updateMany({ owner_id: { $exists: false } }, [
    { $set: { owner_id: "$createdBy" } },
  ]);
  log.info(`Backfilled owner_id for ${ownerResult.modifiedCount} dashboards`);

  const accessResult = await col.updateMany(
    { access: { $exists: false } },
    { $set: { access: "private" } },
  );
  log.info(
    `Set access='private' for ${accessResult.modifiedCount} dashboards without access field`,
  );

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
