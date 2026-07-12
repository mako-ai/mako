import { Db, type CreateIndexesOptions } from "mongodb";
import { loggers } from "../logging";
import { findCompatibleIndex } from "./2026-07-11-201825_create_apps_v2_metadata_indexes";

const log = loggers.migration();

export const description =
  "Add optional Apps v2 GitHub bindings and conversation remote state";

export const appV2ChatRemoteIndexes: Array<{
  keys: Record<string, 1 | -1>;
  options?: Pick<CreateIndexesOptions, "unique">;
}> = [
  {
    keys: { projectId: 1, chatId: 1 },
    options: { unique: true },
  },
  { keys: { workspaceId: 1, projectId: 1, updatedAt: -1 } },
  { keys: { remoteBranch: 1, pushStatus: 1 } },
  { keys: { operationId: 1, generation: 1 } },
];

export const appV2GitHubDeliveryIndexes: Array<{
  keys: Record<string, 1 | -1>;
  options?: Pick<CreateIndexesOptions, "unique">;
}> = [
  {
    keys: { deliveryId: 1 },
    options: { unique: true },
  },
  { keys: { status: 1, expiresAt: 1 } },
];

async function ensureCollectionIndexes(
  db: Db,
  collectionName: string,
  definitions: Array<{
    keys: Record<string, 1 | -1>;
    options?: Pick<CreateIndexesOptions, "unique">;
  }>,
): Promise<void> {
  const exists = await db
    .listCollections({ name: collectionName }, { nameOnly: true })
    .hasNext();
  if (!exists) await db.createCollection(collectionName);
  const collection = db.collection(collectionName);
  let indexes = await collection.listIndexes().toArray();
  for (const definition of definitions) {
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
}

export async function up(db: Db): Promise<void> {
  await ensureCollectionIndexes(
    db,
    "app_v2_chat_remotes",
    appV2ChatRemoteIndexes,
  );
  await ensureCollectionIndexes(
    db,
    "app_v2_github_deliveries",
    appV2GitHubDeliveryIndexes,
  );

  await db.collection("app_v2_projects").updateMany(
    {
      github: { $exists: true },
      githubBindingGeneration: { $exists: false },
    },
    { $set: { githubBindingGeneration: 1 } },
  );
  await db.collection("app_v2_projects").updateMany(
    {
      github: { $exists: true },
      "github.bindingFingerprint": { $exists: false },
    },
    [
      {
        $set: {
          "github.bindingFingerprint": {
            $concat: [
              "v1\n",
              { $toString: "$github.installationId" },
              "\n",
              { $toLower: "$github.owner" },
              "\n",
              { $toLower: "$github.repo" },
              "\n",
              "$github.baseBranch",
              "\n",
              { $ifNull: ["$github.subdirectory", ""] },
            ],
          },
        },
      },
    ],
  );
  await db.collection("app_v2_projects").updateMany(
    {
      github: { $exists: false },
      githubBindingGeneration: { $exists: false },
    },
    { $set: { githubBindingGeneration: 0 } },
  );
  await db
    .collection("app_v2_chat_remotes")
    .updateMany({ remoteBranch: { $regex: /^mako\/chat\// } }, [
      {
        $set: {
          remoteBranch: {
            $concat: [
              "mako/app/",
              { $toString: "$projectId" },
              "/chat/",
              "$chatId",
            ],
          },
          generation: { $ifNull: ["$generation", 0] },
          bindingGeneration: {
            $ifNull: ["$bindingGeneration", "$operationBindingGeneration", 0],
          },
          bindingFingerprint: {
            $ifNull: ["$bindingFingerprint", "legacy-binding"],
          },
          observedRemoteShas: { $ifNull: ["$observedRemoteShas", []] },
        },
      },
    ]);
  await db.collection("app_v2_chat_remotes").updateMany(
    {
      $or: [
        { bindingGeneration: { $exists: false } },
        { bindingFingerprint: { $exists: false } },
      ],
    },
    [
      {
        $set: {
          bindingGeneration: {
            $ifNull: ["$bindingGeneration", "$operationBindingGeneration", 0],
          },
          bindingFingerprint: {
            $ifNull: ["$bindingFingerprint", "legacy-binding"],
          },
        },
      },
    ],
  );
  log.info("Ensured Apps v2 GitHub mirror metadata");
}
