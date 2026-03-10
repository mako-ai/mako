import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Add description embedding fields to saved consoles and create text + vector search indexes";

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

  // Text index for keyword search (best-effort: never fails the migration)
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
        { name: "console_text_search" },
      );
      log.info("Created text index on { name, description }");
    }
  } catch (err: any) {
    if (err?.code === 85 || err?.codeName === "IndexOptionsConflict") {
      log.info(
        "Text index already exists (possibly under a different name), skipping",
      );
    } else {
      const msg = err?.message || String(err);
      log.info(
        "Text index creation failed — keyword search may be unavailable. " +
          `Reason: ${msg.substring(0, 200)}`,
      );
    }
  }

  // Atlas Vector Search index for semantic search
  // Best-effort: never fails the migration. The runtime probe
  // (isVectorSearchAvailable) detects availability and falls back to text search.
  try {
    await col.createSearchIndex({
      name: "console_embeddings",
      type: "vectorSearch",
      definition: {
        fields: [
          {
            path: "descriptionEmbedding",
            type: "vector",
            numDimensions: 1536,
            similarity: "cosine",
          },
          {
            path: "workspaceId",
            type: "filter",
          },
          {
            path: "is_deleted",
            type: "filter",
          },
        ],
      },
    });
    log.info(
      'Created Atlas Vector Search index "console_embeddings" on savedconsoles',
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      log.info('Atlas Vector Search index "console_embeddings" already exists');
    } else {
      log.info(
        "Atlas Vector Search index creation skipped — search will use text fallback. " +
          `Reason: ${msg.substring(0, 200)}`,
      );
    }
  }
}
