import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Add access field to console folders and set correct defaults";

/**
 * Migration: Console folders access field
 *
 * Adds `access` field to consolefolders and assigns ownership:
 * - Folders with isPrivate=true → access='private'
 * - Folders with an ownerId → access='private' (owner's personal folder)
 * - Ownerless folders → infer owner from consoles inside, set private
 * - Remaining ownerless empty folders → access='workspace' (legacy shared data)
 */
export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("consolefolders")) {
    log.info("Collection 'consolefolders' not found, skipping migration.");
    return;
  }

  const folderCol = db.collection("consolefolders");

  // Private folders stay private
  const privateFolderResult = await folderCol.updateMany(
    { isPrivate: true, access: { $exists: false } },
    { $set: { access: "private" } },
  );
  log.info(
    `Set access='private' for ${privateFolderResult.modifiedCount} private folders`,
  );

  // Owned non-private folders → private (personal folder)
  const ownedResult = await folderCol.updateMany(
    {
      isPrivate: { $ne: true },
      ownerId: { $exists: true, $nin: [null, ""] },
      access: { $exists: false },
    },
    { $set: { access: "private", isPrivate: true } },
  );
  log.info(
    `Set access='private' for ${ownedResult.modifiedCount} owned folders`,
  );

  // Ownerless folders → try to infer owner from consoles inside
  if (collectionNames.includes("savedconsoles")) {
    const consoleCol = db.collection("savedconsoles");
    const orphanFolders = await folderCol
      .find({
        access: { $exists: false },
        $or: [
          { ownerId: { $exists: false } },
          { ownerId: null },
          { ownerId: "" },
        ],
      })
      .toArray();

    let inferredCount = 0;
    for (const folder of orphanFolders) {
      const firstConsole = await consoleCol.findOne({
        folderId: folder._id,
        owner_id: { $exists: true, $ne: null },
      });

      if (firstConsole?.owner_id) {
        await folderCol.updateOne(
          { _id: folder._id },
          {
            $set: {
              ownerId: firstConsole.owner_id.toString(),
              access: "private",
              isPrivate: true,
            },
          },
        );
        inferredCount++;
      }
    }
    log.info(
      `Inferred owner and set private for ${inferredCount} folders from their consoles`,
    );
  }

  // Remaining ownerless folders → workspace (truly shared legacy data)
  const workspaceResult = await folderCol.updateMany(
    { access: { $exists: false } },
    { $set: { access: "workspace" } },
  );
  log.info(
    `Set access='workspace' for ${workspaceResult.modifiedCount} remaining ownerless folders`,
  );
}
