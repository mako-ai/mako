import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create notebookfolders and notebookindexes collections with indexes";

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("notebookfolders")) {
    await db.createCollection("notebookfolders");
    log.info("Created collection 'notebookfolders'");
  } else {
    log.info("Collection 'notebookfolders' already exists, skipping");
  }

  if (!collectionNames.includes("notebookindexes")) {
    await db.createCollection("notebookindexes");
    log.info("Created collection 'notebookindexes'");
  } else {
    log.info("Collection 'notebookindexes' already exists, skipping");
  }

  const folders = db.collection("notebookfolders");
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
        "Created index { workspaceId: 1, parentId: 1 } on notebookfolders",
      );
    }
  } catch (err: unknown) {
    const code = (err as { code?: number; codeName?: string })?.code;
    const codeName = (err as { codeName?: string })?.codeName;
    if (code === 85 || codeName === "IndexOptionsConflict") {
      log.info("Index already exists under a different name, skipping");
    } else {
      throw err;
    }
  }

  try {
    const existingIndexes = await folders.indexes();
    const alreadyExists = existingIndexes.some(
      idx => idx.key && idx.key.workspaceId === 1 && idx.key.access === 1,
    );
    if (!alreadyExists) {
      await folders.createIndex(
        { workspaceId: 1, access: 1 },
        { background: true },
      );
      log.info(
        "Created index { workspaceId: 1, access: 1 } on notebookfolders",
      );
    }
  } catch (err: unknown) {
    const code = (err as { code?: number; codeName?: string })?.code;
    const codeName = (err as { codeName?: string })?.codeName;
    if (code === 85 || codeName === "IndexOptionsConflict") {
      log.info("Index already exists under a different name, skipping");
    } else {
      throw err;
    }
  }

  const indexes = db.collection("notebookindexes");
  try {
    const existingIndexes = await indexes.indexes();
    const alreadyExists = existingIndexes.some(
      idx => idx.key && idx.key.workspaceId === 1 && idx.key.notebookId === 1,
    );
    if (!alreadyExists) {
      await indexes.createIndex(
        { workspaceId: 1, notebookId: 1 },
        { background: true, unique: true },
      );
      log.info(
        "Created index { workspaceId: 1, notebookId: 1 } on notebookindexes",
      );
    }
  } catch (err: unknown) {
    const code = (err as { code?: number; codeName?: string })?.code;
    const codeName = (err as { codeName?: string })?.codeName;
    if (code === 85 || codeName === "IndexOptionsConflict") {
      log.info("Index already exists under a different name, skipping");
    } else {
      throw err;
    }
  }

  try {
    const existingIndexes = await indexes.indexes();
    const alreadyExists = existingIndexes.some(
      idx => idx.key && idx.key.workspaceId === 1 && idx.key.folderId === 1,
    );
    if (!alreadyExists) {
      await indexes.createIndex(
        { workspaceId: 1, folderId: 1 },
        { background: true },
      );
      log.info(
        "Created index { workspaceId: 1, folderId: 1 } on notebookindexes",
      );
    }
  } catch (err: unknown) {
    const code = (err as { code?: number; codeName?: string })?.code;
    const codeName = (err as { codeName?: string })?.codeName;
    if (code === 85 || codeName === "IndexOptionsConflict") {
      log.info("Index already exists under a different name, skipping");
    } else {
      throw err;
    }
  }

  try {
    const existingIndexes = await indexes.indexes();
    const alreadyExists = existingIndexes.some(
      idx =>
        idx.key &&
        idx.key.workspaceId === 1 &&
        idx.key.access === 1 &&
        idx.key.ownerId === 1,
    );
    if (!alreadyExists) {
      await indexes.createIndex(
        { workspaceId: 1, access: 1, ownerId: 1 },
        { background: true },
      );
      log.info(
        "Created index { workspaceId: 1, access: 1, ownerId: 1 } on notebookindexes",
      );
    }
  } catch (err: unknown) {
    const code = (err as { code?: number; codeName?: string })?.code;
    const codeName = (err as { codeName?: string })?.codeName;
    if (code === 85 || codeName === "IndexOptionsConflict") {
      log.info("Index already exists under a different name, skipping");
    } else {
      throw err;
    }
  }
}
