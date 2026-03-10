import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Set folder access to 'private' for owned folders (previously defaulted to 'workspace')";

/**
 * Migration: Folder access private default
 *
 * Previously folders defaulted to access='workspace', causing every folder
 * to appear in the Workspace section. Now folders default to 'private'.
 *
 * Step 1: Folders WITH ownerId + access='workspace' → private
 * Step 2: Folders WITHOUT ownerId → infer owner from consoles inside, then set private
 * Step 3: Remaining ownerless folders → left as workspace (truly shared legacy data)
 */
export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("consolefolders")) {
    log.info("Collection 'consolefolders' not found, skipping migration.");
    return;
  }

  const folderCol = db.collection("consolefolders");

  const ownedResult = await folderCol.updateMany(
    {
      ownerId: { $exists: true, $nin: [null, ""] },
      access: "workspace",
    },
    { $set: { access: "private", isPrivate: true } },
  );
  log.info(
    `Step 1: Set ${ownedResult.modifiedCount} owned folders to access='private'`,
  );

  if (collectionNames.includes("savedconsoles")) {
    const consoleCol = db.collection("savedconsoles");
    const orphanFolders = await folderCol
      .find({
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
      `Step 2: Inferred owner and set private for ${inferredCount} folders from their consoles`,
    );
  }

  const remaining = await folderCol.countDocuments({
    $or: [{ ownerId: { $exists: false } }, { ownerId: null }, { ownerId: "" }],
  });
  if (remaining > 0) {
    log.info(
      `Step 3: ${remaining} folders still without owner, left as-is (workspace-visible)`,
    );
  }
}
