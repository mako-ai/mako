import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create dashboardfolders collection and add folderId index to dashboards";

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("dashboardfolders")) {
    await db.createCollection("dashboardfolders");
    log.info("Created collection 'dashboardfolders'");
  } else {
    log.info("Collection 'dashboardfolders' already exists, skipping");
  }

  const folders = db.collection("dashboardfolders");
  try {
    const existingIndexes = await folders.indexes();
    const alreadyExists = existingIndexes.some(
      idx => idx.key && idx.key.workspaceId === 1 && idx.key.parentId === 1,
    );
    if (!alreadyExists) {
      await folders.createIndex(
        { workspaceId: 1, parentId: 1 },
        { background: true },
      );
      log.info(
        "Created index { workspaceId: 1, parentId: 1 } on dashboardfolders",
      );
    }
  } catch (err: any) {
    if (err?.code === 85 || err?.codeName === "IndexOptionsConflict") {
      log.info("Index already exists under a different name, skipping");
    } else {
      throw err;
    }
  }

  if (collectionNames.includes("dashboards")) {
    const dashboards = db.collection("dashboards");
    try {
      const existingIndexes = await dashboards.indexes();
      const alreadyExists = existingIndexes.some(
        idx => idx.key && idx.key.workspaceId === 1 && idx.key.folderId === 1,
      );
      if (!alreadyExists) {
        await dashboards.createIndex(
          { workspaceId: 1, folderId: 1 },
          { background: true },
        );
        log.info("Created index { workspaceId: 1, folderId: 1 } on dashboards");
      }
    } catch (err: any) {
      if (err?.code === 85 || err?.codeName === "IndexOptionsConflict") {
        log.info("Index already exists under a different name, skipping");
      } else {
        throw err;
      }
    }
  }
}
