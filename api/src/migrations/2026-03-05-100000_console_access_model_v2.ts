import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Add access field to console folders (private or workspace based on isPrivate)";

/**
 * Migration: Console folders access field
 *
 * Adds `access` field to consolefolders:
 * - `isPrivate: true` → `access: 'private'`
 * - `isPrivate: false` (or missing) → `access: 'workspace'`
 */
export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("consolefolders")) {
    log.info("Collection 'consolefolders' not found, skipping migration.");
    return;
  }

  const folderCol = db.collection("consolefolders");

  const privateFolderResult = await folderCol.updateMany(
    { isPrivate: true, access: { $exists: false } },
    { $set: { access: "private" } },
  );
  log.info(
    `Set access='private' for ${privateFolderResult.modifiedCount} private folders`,
  );

  const workspaceFolderResult = await folderCol.updateMany(
    { isPrivate: { $ne: true }, access: { $exists: false } },
    { $set: { access: "workspace" } },
  );
  log.info(
    `Set access='workspace' for ${workspaceFolderResult.modifiedCount} non-private folders`,
  );
}
