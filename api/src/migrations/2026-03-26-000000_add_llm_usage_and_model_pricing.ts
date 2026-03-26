import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create LlmUsage collection with indexes for cost tracking";

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const names = collections.map(c => c.name);

  // --- LlmUsage collection ---
  if (!names.includes("llmusages")) {
    await db.createCollection("llmusages");
    log.info("Created collection 'llmusages'");
  }

  const llmUsage = db.collection("llmusages");

  const llmIndexes: Array<{
    key: Record<string, 1 | -1>;
    name: string;
  }> = [
    { key: { workspaceId: 1, createdAt: -1 }, name: "ws_created" },
    { key: { userId: 1, createdAt: -1 }, name: "user_created" },
    { key: { chatId: 1 }, name: "chat" },
    {
      key: { workspaceId: 1, userId: 1, createdAt: -1 },
      name: "ws_user_created",
    },
  ];

  const existingLlmIdx = await llmUsage.indexes();
  for (const idx of llmIndexes) {
    const exists = existingLlmIdx.some(e => e.name === idx.name);
    if (!exists) {
      await llmUsage.createIndex(idx.key, {
        name: idx.name,
        background: true,
      });
      log.info(`Created index '${idx.name}' on llmusages`);
    }
  }

  // Drop the old modelpricings collection if it exists from a previous
  // version of this migration. Pricing is now fetched live from the
  // Vercel AI Gateway API and cached in process memory.
  if (names.includes("modelpricings")) {
    await db.dropCollection("modelpricings");
    log.info(
      "Dropped stale 'modelpricings' collection (pricing is now live from gateway)",
    );
  }
}
