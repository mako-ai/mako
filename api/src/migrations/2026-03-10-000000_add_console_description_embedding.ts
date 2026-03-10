import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Add description embedding fields to saved consoles and create text search index";

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("savedconsoles")) {
    log.info("Collection 'savedconsoles' not found, skipping migration.");
    return;
  }

  const col = db.collection("savedconsoles");

  const result = await col.updateMany(
    { descriptionGeneratedAt: { $exists: false } },
    { $set: { descriptionGeneratedAt: null } },
  );
  log.info(
    `Set descriptionGeneratedAt=null for ${result.modifiedCount} consoles`,
  );

  try {
    const existingIndexes = await col.indexes();
    const hasTextIndex = existingIndexes.some(
      idx => idx.textIndexVersion !== undefined,
    );

    if (hasTextIndex) {
      log.info("Text index already exists on savedconsoles, skipping creation");
    } else {
      await col.createIndex(
        { name: "text", description: "text" },
        { background: true, name: "console_text_search" },
      );
      log.info("Created text index on { name, description }");
    }
  } catch (err: any) {
    if (err?.code === 85 || err?.codeName === "IndexOptionsConflict") {
      log.info(
        "Text index already exists (possibly under a different name), skipping",
      );
    } else {
      throw err;
    }
  }

  log.info(
    "NOTE: Atlas Vector Search index must be created manually via Atlas UI/CLI:",
  );
  log.info('  Index name: "console_embeddings" on collection "savedconsoles"');
  log.info("  Fields: descriptionEmbedding (vector, 1536d, cosine),");
  log.info("          workspaceId (filter), is_deleted (filter)");
}
