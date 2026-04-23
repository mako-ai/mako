import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create skills collection with compound/text/vector indexes (see issue #365)";

function hasIndexOnKeys(
  indexes: { key: Record<string, number | string> }[],
  keyPattern: Record<string, number | string>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key) === target);
}

export async function up(db: Db): Promise<void> {
  const existing = await db.listCollections({ name: "skills" }).toArray();
  if (existing.length === 0) {
    await db.createCollection("skills");
    log.info("Created 'skills' collection");
  } else {
    log.info("'skills' collection already exists");
  }

  const col = db.collection("skills");
  const indexes = await col.indexes();

  if (!hasIndexOnKeys(indexes, { workspaceId: 1, name: 1 })) {
    await col.createIndex(
      { workspaceId: 1, name: 1 },
      { unique: true, name: "skills_workspace_name_unique" },
    );
    log.info("Created unique index on { workspaceId, name }");
  }

  if (!hasIndexOnKeys(indexes, { workspaceId: 1, suppressed: 1 })) {
    await col.createIndex(
      { workspaceId: 1, suppressed: 1 },
      { name: "skills_workspace_suppressed" },
    );
    log.info("Created index on { workspaceId, suppressed }");
  }

  if (!hasIndexOnKeys(indexes, { workspaceId: 1, entities: 1 })) {
    await col.createIndex(
      { workspaceId: 1, entities: 1 },
      { name: "skills_workspace_entities" },
    );
    log.info("Created index on { workspaceId, entities }");
  }

  // Text index across name + loadWhen + body for keyword fallback.
  // Best-effort: never fail the migration if a text index already exists.
  try {
    const hasTextIndex = indexes.some(
      (idx: { textIndexVersion?: number }) =>
        idx.textIndexVersion !== undefined,
    );
    if (hasTextIndex) {
      log.info("Text index already exists on skills, skipping creation");
    } else {
      await col.createIndex(
        { name: "text", loadWhen: "text", body: "text" },
        { name: "skill_text_search" },
      );
      log.info("Created text index on { name, loadWhen, body }");
    }
  } catch (err: unknown) {
    const e = err as { code?: number; codeName?: string; message?: string };
    if (e?.code === 85 || e?.codeName === "IndexOptionsConflict") {
      log.info(
        "Text index already exists (possibly under a different name), skipping",
      );
    } else {
      log.info(
        "Text index creation failed — keyword search may be unavailable. " +
          `Reason: ${(e?.message ?? String(err)).substring(0, 200)}`,
      );
    }
  }

  // Atlas Vector Search index on loadWhenEmbedding (cosine, 1536 dims for
  // OpenAI text-embedding-3-small). Best-effort — runtime detects availability
  // via probe in embedding.service and falls back to entity-overlap + text.
  try {
    await (
      col as unknown as {
        createSearchIndex: (spec: unknown) => Promise<unknown>;
      }
    ).createSearchIndex({
      name: "skill_embeddings",
      type: "vectorSearch",
      definition: {
        fields: [
          {
            path: "loadWhenEmbedding",
            type: "vector",
            numDimensions: 1536,
            similarity: "cosine",
          },
          { path: "workspaceId", type: "filter" },
          { path: "suppressed", type: "filter" },
        ],
      },
    });
    log.info('Created Atlas Vector Search index "skill_embeddings" on skills');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      log.info('Atlas Vector Search index "skill_embeddings" already exists');
    } else {
      log.info(
        "Atlas Vector Search index creation skipped — search will use " +
          `entity-overlap + text fallback. Reason: ${msg.substring(0, 200)}`,
      );
    }
  }
}
