import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Set folder access to 'private' for folders that have an ownerId (previously defaulted to 'workspace')";

/**
 * Migration: Folder access private default
 *
 * Previously, createFolder set access='workspace' by default, causing every
 * folder to appear in the Workspace section for all users. Now folders default
 * to 'private'. This migration retroactively fixes existing folders:
 *
 * - Folders WITH an ownerId and access='workspace': set to 'private'
 *   (they were created by a specific user and should be in their My Consoles)
 * - Folders WITHOUT an ownerId: left as 'workspace' (legacy data, no owner to assign)
 */
export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("consolefolders")) {
    log.info("Collection 'consolefolders' not found, skipping migration.");
    return;
  }

  const col = db.collection("consolefolders");

  // Folders that have an owner but were set to workspace by the old default
  const result = await col.updateMany(
    {
      ownerId: { $exists: true, $ne: null },
      access: "workspace",
      shared_with: { $in: [null, []] },
    },
    { $set: { access: "private", isPrivate: true } },
  );

  log.info(
    `Migrated ${result.modifiedCount} owned folders from access='workspace' to access='private'`,
  );

  // Count folders left as workspace (no owner)
  const remaining = await col.countDocuments({
    ownerId: { $in: [null, undefined] },
    access: "workspace",
  });
  if (remaining > 0) {
    log.info(
      `${remaining} folders without ownerId left as access='workspace' (legacy data)`,
    );
  }
}
