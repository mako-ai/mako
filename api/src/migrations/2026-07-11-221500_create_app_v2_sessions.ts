import { Db, type CreateIndexesOptions } from "mongodb";
import { loggers } from "../logging";
import { findCompatibleIndex } from "./2026-07-11-201825_create_apps_v2_metadata_indexes";

const log = loggers.migration();

export const description =
  "Create credential-free Apps v2 sandbox session metadata and indexes";

export const appV2SessionIndexes: Array<{
  keys: Record<string, 1 | -1>;
  options?: Pick<
    CreateIndexesOptions,
    "unique" | "sparse" | "partialFilterExpression" | "collation" | "name"
  >;
}> = [
  {
    keys: { worktreeId: 1, actorId: 1, purpose: 1 },
    options: { unique: true },
  },
  { keys: { workspaceId: 1, projectId: 1 } },
  { keys: { sandboxId: 1 }, options: { unique: true } },
  { keys: { status: 1, lastActiveAt: 1 } },
  { keys: { operationExpiresAt: 1 } },
  { keys: { status: 1, operationExpiresAt: 1 } },
];

export async function up(db: Db): Promise<void> {
  const collectionName = "app_v2_sessions";
  const existingCollections = await db
    .listCollections({ name: collectionName }, { nameOnly: true })
    .hasNext();
  if (!existingCollections) await db.createCollection(collectionName);
  const collection = db.collection(collectionName);
  await collection.updateMany(
    { generation: { $exists: false } },
    { $set: { generation: 0 } },
  );
  await collection.updateMany({ reservationId: { $exists: false } }, [
    {
      $set: {
        reservationId: {
          $concat: ["legacy-", { $toString: "$_id" }],
        },
      },
    },
  ]);
  let indexes = await collection.listIndexes().toArray();
  const obsoleteIdentity = findCompatibleIndex(
    indexes,
    { worktreeId: 1, actorId: 1 },
    { unique: true },
    collectionName,
  );
  if (obsoleteIdentity?.name) {
    await collection.dropIndex(obsoleteIdentity.name);
    indexes = await collection.listIndexes().toArray();
  }
  for (const definition of appV2SessionIndexes) {
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
  log.info("Ensured Apps v2 session metadata indexes", { collectionName });
}
