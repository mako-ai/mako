import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create the personal_folders collection with its (workspaceId, userId, kind) index";

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("personal_folders")) {
    await db.createCollection("personal_folders");
    log.info("Created collection 'personal_folders'");
  } else {
    log.info("Collection 'personal_folders' already exists, skipping");
  }

  // Every read is "this user's folders of this kind in this workspace", so
  // that is the only index the collection needs.
  const folders = db.collection("personal_folders");
  try {
    const existingIndexes = await folders.indexes();
    const alreadyExists = existingIndexes.some(
      idx =>
        idx.key &&
        idx.key.workspaceId === 1 &&
        idx.key.userId === 1 &&
        idx.key.kind === 1,
    );
    if (!alreadyExists) {
      await folders.createIndex(
        { workspaceId: 1, userId: 1, kind: 1 },
        { background: true },
      );
      log.info(
        "Created index { workspaceId: 1, userId: 1, kind: 1 } on personal_folders",
      );
    }
  } catch (err: unknown) {
    // Mongoose autoIndex may have built it already under a generated name;
    // checking by key pattern above is what makes this re-runnable, and this
    // catch covers the race where it appears between the check and create.
    const code = (err as { code?: number; codeName?: string })?.code;
    const codeName = (err as { codeName?: string })?.codeName;
    if (code === 85 || codeName === "IndexOptionsConflict") {
      log.info("Index already exists under a different name, skipping");
    } else {
      throw err;
    }
  }
}
