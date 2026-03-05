import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Migrate console access model from shared_read/shared_write to shared/workspace";

/**
 * Migration: Console access model v2
 *
 * Maps the old access values to the new 3-tier model:
 * - 'shared_read' -> 'workspace' (visible to all workspace members, read-only)
 * - 'shared_write' -> 'workspace' (visible to all workspace members)
 * - 'private' stays 'private'
 *
 * Also updates shared_with from flat ObjectId[] to [{userId, access}] structure.
 * Existing shared_with entries are treated as 'read' permissions.
 */
export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("savedconsoles")) {
    log.info("Collection 'savedconsoles' not found, skipping migration.");
    return;
  }

  const col = db.collection("savedconsoles");

  // 1. Map shared_read -> workspace
  const readResult = await col.updateMany(
    { access: "shared_read" },
    { $set: { access: "workspace" } },
  );
  log.info(
    `Migrated ${readResult.modifiedCount} consoles from shared_read to workspace`,
  );

  // 2. Map shared_write -> workspace
  const writeResult = await col.updateMany(
    { access: "shared_write" },
    { $set: { access: "workspace" } },
  );
  log.info(
    `Migrated ${writeResult.modifiedCount} consoles from shared_write to workspace`,
  );

  // 3. Convert flat ObjectId shared_with arrays to structured entries.
  // Find docs where shared_with contains raw ObjectIds (not objects with userId)
  const docsWithOldSharedWith = await col
    .find({
      shared_with: {
        $exists: true,
        $ne: [],
        $not: { $elemMatch: { userId: { $exists: true } } },
      },
    })
    .toArray();

  let convertedCount = 0;
  for (const doc of docsWithOldSharedWith) {
    if (Array.isArray(doc.shared_with) && doc.shared_with.length > 0) {
      const firstItem = doc.shared_with[0];
      // Only convert if the array contains raw IDs (strings/ObjectIds), not objects
      if (typeof firstItem === "string" || (firstItem && !firstItem.userId)) {
        const newEntries = doc.shared_with.map((id: any) => ({
          userId: id.toString(),
          access: "read",
        }));
        await col.updateOne(
          { _id: doc._id },
          { $set: { shared_with: newEntries } },
        );
        convertedCount++;
      }
    }
  }
  log.info(`Converted shared_with structure for ${convertedCount} consoles`);

  // 4. Update ConsoleFolder collection if it exists
  if (collectionNames.includes("consolefolders")) {
    const folderCol = db.collection("consolefolders");

    // Add access field to folders that don't have it, respecting isPrivate
    const privateFolderResult = await folderCol.updateMany(
      { isPrivate: true, access: { $exists: false } },
      { $set: { access: "private", shared_with: [] } },
    );
    log.info(
      `Set access='private' for ${privateFolderResult.modifiedCount} private folders`,
    );

    const workspaceFolderResult = await folderCol.updateMany(
      { isPrivate: { $ne: true }, access: { $exists: false } },
      { $set: { access: "workspace", shared_with: [] } },
    );
    log.info(
      `Set access='workspace' for ${workspaceFolderResult.modifiedCount} workspace-visible folders`,
    );
  }
}
