import { Db, type CreateIndexesOptions } from "mongodb";
import { loggers } from "../logging";
import { findCompatibleIndex } from "./2026-07-11-201825_create_apps_v2_metadata_indexes";

const log = loggers.migration();

export const description = "Create durable Apps v2 chat turn fencing metadata";

export const appV2ChatTurnIndexes: Array<{
  keys: Record<string, 1 | -1>;
  options?: Pick<CreateIndexesOptions, "unique">;
}> = [
  {
    keys: { workspaceId: 1, chatId: 1, turnId: 1, actorId: 1 },
    options: { unique: true },
  },
  {
    keys: { status: 1, heartbeatAt: 1, retryLeaseExpiresAt: 1 },
  },
  {
    keys: {
      workspaceId: 1,
      "touchedProjects.worktreeId": 1,
      status: 1,
    },
  },
];

export async function up(db: Db): Promise<void> {
  const collectionName = "app_v2_chat_turns";
  const exists = await db
    .listCollections({ name: collectionName }, { nameOnly: true })
    .hasNext();
  if (!exists) await db.createCollection(collectionName);
  const collection = db.collection(collectionName);
  await collection.updateMany({ heartbeatAt: { $exists: false } }, [
    {
      $set: {
        heartbeatAt: {
          $ifNull: ["$updatedAt", { $ifNull: ["$createdAt", "$$NOW"] }],
        },
      },
    },
  ]);
  let indexes = await collection.listIndexes().toArray();
  for (const definition of appV2ChatTurnIndexes) {
    if (
      findCompatibleIndex(
        indexes,
        definition.keys,
        definition.options,
        collectionName,
      )
    ) {
      continue;
    }
    await collection.createIndex(definition.keys, definition.options);
    indexes = await collection.listIndexes().toArray();
  }
  log.info("Ensured Apps v2 chat turn metadata", { collectionName });
}
