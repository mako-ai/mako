import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Unique (workspaceId, userId, kind, system) partial index on personal_folders — one Starred list per user";

export async function up(db: Db): Promise<void> {
  const folders = db.collection("personal_folders");
  try {
    const existingIndexes = await folders.indexes();
    const alreadyExists = existingIndexes.some(
      idx =>
        idx.key &&
        idx.key.workspaceId === 1 &&
        idx.key.userId === 1 &&
        idx.key.kind === 1 &&
        idx.key.system === 1,
    );
    if (!alreadyExists) {
      await folders.createIndex(
        { workspaceId: 1, userId: 1, kind: 1, system: 1 },
        {
          unique: true,
          partialFilterExpression: { system: { $exists: true } },
          background: true,
        },
      );
      log.info(
        "Created unique partial index { workspaceId, userId, kind, system } on personal_folders",
      );
    }
  } catch (err: unknown) {
    // Mongoose autoIndex may have built it under a generated name; checking
    // by key pattern above is what keeps this re-runnable.
    const code = (err as { code?: number; codeName?: string })?.code;
    const codeName = (err as { codeName?: string })?.codeName;
    if (code === 85 || codeName === "IndexOptionsConflict") {
      log.info("Index already exists under a different name, skipping");
    } else {
      throw err;
    }
  }
}
