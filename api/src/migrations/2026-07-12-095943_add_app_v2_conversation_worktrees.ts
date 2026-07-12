import { Db, type CreateIndexesOptions } from "mongodb";
import { loggers } from "../logging";
import { findCompatibleIndex } from "./2026-07-11-201825_create_apps_v2_metadata_indexes";

const log = loggers.migration();

export const description =
  "Add manual and per-chat Apps v2 conversation worktrees";

export const appV2ConversationWorktreeIndexes: Array<{
  keys: Record<string, 1 | -1>;
  options?: Pick<
    CreateIndexesOptions,
    "unique" | "sparse" | "partialFilterExpression" | "collation" | "name"
  >;
}> = [
  {
    keys: { projectId: 1, actorId: 1, contextKey: 1 },
    options: { unique: true },
  },
  { keys: { workspaceId: 1, chatId: 1, kind: 1 } },
];

export async function up(db: Db): Promise<void> {
  const collectionName = "app_v2_worktrees";
  const exists = await db
    .listCollections({ name: collectionName }, { nameOnly: true })
    .hasNext();
  if (!exists) await db.createCollection(collectionName);
  const collection = db.collection(collectionName);

  await collection.updateMany(
    { kind: { $exists: false } },
    { $set: { kind: "manual" } },
  );
  await collection.updateMany(
    { contextKey: { $exists: false } },
    { $set: { contextKey: "manual" } },
  );

  let indexes = await collection.listIndexes().toArray();
  // Install the replacement identity first. Keeping the old, narrower unique
  // index during this build is restrictive but safe; dropping it first creates
  // an avoidable window with no uniqueness protection.
  for (const definition of appV2ConversationWorktreeIndexes) {
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
  const obsoleteIdentity = indexes.find(
    index =>
      JSON.stringify(index.key) ===
      JSON.stringify({ projectId: 1, actorId: 1 }),
  );
  if (obsoleteIdentity?.name) {
    await collection.dropIndex(obsoleteIdentity.name);
  }
  log.info("Ensured Apps v2 conversation worktree metadata", {
    collectionName,
  });
}
