import assert from "node:assert/strict";
import type { Db, IndexDescriptionInfo } from "mongodb";
import { findCompatibleIndex } from "../migrations/2026-07-11-201825_create_apps_v2_metadata_indexes";
import {
  appV2SessionIndexes,
  up as migrateAppV2Sessions,
} from "../migrations/2026-07-11-221500_create_app_v2_sessions";
import { appV2ConversationWorktreeIndexes } from "../migrations/2026-07-12-095943_add_app_v2_conversation_worktrees";
import { appV2ChatTurnIndexes } from "../migrations/2026-07-12-102123_create_app_v2_chat_turns";
import {
  appV2ChatRemoteIndexes,
  appV2GitHubDeliveryIndexes,
  up as migrateAppV2ChatRemotes,
} from "../migrations/2026-07-12-114500_add_app_v2_github_binding";
import {
  AppV2ChatRemote,
  AppV2GitHubDelivery,
  AppV2ChatTurn,
  AppV2Worktree,
} from "../database/workspace-schema";
import {
  appV2ConversationBranch,
  appV2GitHubConversationBranch,
} from "./conversation-branch";

assert.equal(
  appV2ConversationBranch("64b7f0f0f0f0f0f0f0f0f0f0"),
  "mako/chat/64b7f0f0f0f0f0f0f0f0f0f0",
);
assert.equal(
  appV2GitHubConversationBranch(
    "64b7f0f0f0f0f0f0f0f0f0f1",
    "64b7f0f0f0f0f0f0f0f0f0f0",
  ),
  "mako/app/64b7f0f0f0f0f0f0f0f0f0f1/chat/64b7f0f0f0f0f0f0f0f0f0f0",
);
for (const unsafe of ["", "../main", "a/b", "A".repeat(24), "f".repeat(40)]) {
  assert.throws(() => appV2ConversationBranch(unsafe), /Invalid Apps v2 chat/);
}

assert.deepEqual(appV2SessionIndexes, [
  {
    keys: { worktreeId: 1, actorId: 1, purpose: 1 },
    options: { unique: true },
  },
  { keys: { workspaceId: 1, projectId: 1 } },
  { keys: { sandboxId: 1 }, options: { unique: true } },
  { keys: { status: 1, lastActiveAt: 1 } },
  { keys: { operationExpiresAt: 1 } },
  { keys: { status: 1, operationExpiresAt: 1 } },
]);

assert.deepEqual(appV2ConversationWorktreeIndexes, [
  {
    keys: { projectId: 1, actorId: 1, contextKey: 1 },
    options: { unique: true },
  },
  { keys: { workspaceId: 1, chatId: 1, kind: 1 } },
]);
assert.deepEqual(appV2ChatTurnIndexes, [
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
]);
assert.deepEqual(appV2ChatRemoteIndexes, [
  {
    keys: { projectId: 1, chatId: 1 },
    options: { unique: true },
  },
  { keys: { workspaceId: 1, projectId: 1, updatedAt: -1 } },
  { keys: { remoteBranch: 1, pushStatus: 1 } },
  { keys: { operationId: 1, generation: 1 } },
]);
assert.deepEqual(appV2GitHubDeliveryIndexes, [
  { keys: { deliveryId: 1 }, options: { unique: true } },
  { keys: { status: 1, expiresAt: 1 } },
]);

const worktreeSchemaIndexes = AppV2Worktree.schema.indexes();
assert(
  worktreeSchemaIndexes.some(
    ([index, options]) =>
      JSON.stringify(index) ===
        JSON.stringify({ projectId: 1, actorId: 1, contextKey: 1 }) &&
      options.unique === true,
  ),
);

const turnSchemaIndexes = AppV2ChatTurn.schema.indexes();
const remoteSchemaIndexes = AppV2ChatRemote.schema.indexes();
const deliverySchemaIndexes = AppV2GitHubDelivery.schema.indexes();
assert(
  turnSchemaIndexes.some(
    ([index, options]) =>
      JSON.stringify(index) ===
        JSON.stringify({
          workspaceId: 1,
          chatId: 1,
          turnId: 1,
          actorId: 1,
        }) && options.unique === true,
  ),
);
assert(
  deliverySchemaIndexes.some(
    ([index, options]) =>
      JSON.stringify(index) === JSON.stringify({ deliveryId: 1 }) &&
      options.unique === true,
  ),
);
assert(
  remoteSchemaIndexes.some(
    ([index, options]) =>
      JSON.stringify(index) === JSON.stringify({ projectId: 1, chatId: 1 }) &&
      options.unique === true,
  ),
);
assert(
  worktreeSchemaIndexes.some(
    ([index]) =>
      JSON.stringify(index) ===
      JSON.stringify({ workspaceId: 1, chatId: 1, kind: 1 }),
  ),
);
assert(
  !worktreeSchemaIndexes.some(
    ([index]) =>
      JSON.stringify(index) === JSON.stringify({ projectId: 1, actorId: 1 }),
  ),
);

const keys = { projectId: 1 as const, actorId: 1 as const };
assert.equal(
  findCompatibleIndex(
    [{ name: "correct", key: keys, unique: true }],
    keys,
    { unique: true },
    "app_v2_worktrees",
  )?.name,
  "correct",
);
assert.throws(
  () =>
    findCompatibleIndex(
      [{ name: "unsafe", key: keys }],
      keys,
      { unique: true },
      "app_v2_worktrees",
    ),
  /index option mismatch.*"unique":true.*"unique":false/,
);

for (const incompatible of [
  { unique: true, sparse: true },
  {
    unique: true,
    partialFilterExpression: { status: { $eq: "active" } },
  },
  { unique: true, collation: { locale: "fr" } },
]) {
  assert.throws(
    () =>
      findCompatibleIndex(
        [{ name: "incompatible", key: keys, ...incompatible }],
        keys,
        { unique: true },
        "app_v2_worktrees",
      ),
    /index option mismatch/,
  );
}

assert.equal(
  findCompatibleIndex(
    [
      {
        name: "compatible-collation",
        key: keys,
        unique: true,
        collation: {
          locale: "en",
          strength: 3,
          caseLevel: false,
          caseFirst: "off",
          numericOrdering: false,
          alternate: "non-ignorable",
          maxVariable: "punct",
          normalization: false,
          backwards: false,
          version: "57.1",
        },
      },
    ],
    keys,
    { unique: true, collation: { locale: "en" } },
    "app_v2_worktrees",
  )?.name,
  "compatible-collation",
);

async function assertSessionIndexMigrationOrdering(): Promise<void> {
  const indexes: IndexDescriptionInfo[] = [
    { name: "_id_", key: { _id: 1 } },
    {
      name: "legacy_worktree_actor_unique",
      key: { worktreeId: 1, actorId: 1 },
      unique: true,
    },
  ];
  const operations: Array<{
    type: "create" | "drop";
    keys?: Record<string, unknown>;
    options?: Record<string, unknown>;
    name?: string;
  }> = [];
  const collection = {
    updateMany: async () => ({ acknowledged: true }),
    listIndexes: () => ({ toArray: async () => indexes }),
    createIndex: async (
      keys: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => {
      operations.push({ type: "create", keys, options });
      indexes.push({
        name: `created_${indexes.length}`,
        key: keys,
        ...options,
      } as IndexDescriptionInfo);
      return indexes.at(-1)?.name ?? "created";
    },
    dropIndex: async (name: string) => {
      operations.push({ type: "drop", name });
      const index = indexes.findIndex(candidate => candidate.name === name);
      if (index >= 0) indexes.splice(index, 1);
      return { ok: 1 };
    },
  };
  const db = {
    listCollections: () => ({ hasNext: async () => true }),
    createCollection: async () => collection,
    collection: () => collection,
  } as unknown as Db;

  await migrateAppV2Sessions(db);

  const replacementCreate = operations.findIndex(
    operation =>
      operation.type === "create" &&
      JSON.stringify(operation.keys) ===
        JSON.stringify({ worktreeId: 1, actorId: 1, purpose: 1 }) &&
      operation.options?.unique === true,
  );
  const obsoleteDrop = operations.findIndex(
    operation =>
      operation.type === "drop" &&
      operation.name === "legacy_worktree_actor_unique",
  );
  assert(replacementCreate >= 0);
  assert(obsoleteDrop > replacementCreate);

  const indexMutationCount = operations.length;
  await migrateAppV2Sessions(db);
  assert.equal(operations.length, indexMutationCount);
}

void assertSessionIndexMigrationOrdering();

async function assertChatRemoteMigrationIdempotency(): Promise<void> {
  const indexesByCollection = new Map<string, IndexDescriptionInfo[]>();
  const migrationUpdates: Array<{
    collection: string;
    query: unknown;
    update: unknown;
  }> = [];
  let creates = 0;
  const collection = (name: string) => {
    const indexes = indexesByCollection.get(name) ?? [
      { name: "_id_", key: { _id: 1 } },
    ];
    indexesByCollection.set(name, indexes);
    return {
      updateMany: async (query: unknown, update: unknown) => {
        migrationUpdates.push({ collection: name, query, update });
        return { acknowledged: true };
      },
      listIndexes: () => ({ toArray: async () => indexes }),
      createIndex: async (
        keys: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => {
        creates += 1;
        indexes.push({
          name: `created_${creates}`,
          key: keys,
          ...options,
        } as IndexDescriptionInfo);
        return `created_${creates}`;
      },
    };
  };
  const db = {
    listCollections: () => ({ hasNext: async () => true }),
    createCollection: async (name: string) => collection(name),
    collection: (name: string) => collection(name),
  } as unknown as Db;

  await migrateAppV2ChatRemotes(db);
  await migrateAppV2ChatRemotes(db);
  assert.equal(
    creates,
    appV2ChatRemoteIndexes.length + appV2GitHubDeliveryIndexes.length,
  );
  assert(
    migrationUpdates.some(operation => {
      const query = operation.query as {
        remoteBranch?: { $regex?: RegExp };
      };
      return (
        operation.collection === "app_v2_chat_remotes" &&
        query.remoteBranch?.$regex?.source === "^mako\\/chat\\/"
      );
    }),
  );
}

void assertChatRemoteMigrationIdempotency();
