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

  // Text index for keyword search
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

  // Atlas Vector Search index for semantic search
  try {
    const existingSearchIndexes = await col.listSearchIndexes().toArray();
    const hasVectorIndex = existingSearchIndexes.some(
      (idx: any) => idx.name === "console_embeddings",
    );

    if (hasVectorIndex) {
      log.info(
        'Atlas Vector Search index "console_embeddings" already exists, skipping',
      );
    } else {
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
    }
  } catch (err: any) {
    if (
      err?.message?.includes("not supported") ||
      err?.message?.includes("no such command") ||
      err?.codeName === "CommandNotFound"
    ) {
      log.info(
        "Atlas Vector Search not available (self-hosted MongoDB) — skipping vector index creation. " +
          "Semantic search will fall back to text search.",
      );
    } else if (err?.code === 68 || err?.codeName === "IndexAlreadyExists") {
      log.info(
        'Atlas Vector Search index "console_embeddings" already exists, skipping',
      );
    } else {
      log.warn(
        "Failed to create Atlas Vector Search index — semantic search will use text fallback",
        { error: err?.message || err },
      );
    }
  }
}
