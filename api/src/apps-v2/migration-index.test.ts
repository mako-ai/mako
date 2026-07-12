import assert from "node:assert/strict";
import { findCompatibleIndex } from "../migrations/2026-07-11-201825_create_apps_v2_metadata_indexes";
import { appV2SessionIndexes } from "../migrations/2026-07-11-221500_create_app_v2_sessions";

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
