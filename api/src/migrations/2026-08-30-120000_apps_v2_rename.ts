/**
 * The apps-v2 → apps rename, data plane.
 *
 * With v1 ripped out (#816) the "v2" qualifier stopped meaning anything, so
 * the code dropped it everywhere. This migration moves the stored names in
 * step:
 *
 * 1. Collections: `app_projects_v2` → `app_projects`, `app_worktrees_v2` →
 *    `app_worktrees`. Plain renameCollection when the target is free (keeps
 *    indexes); if the target already has documents (a deploy raced the
 *    migration), documents are merged with the newer collection winning on
 *    _id collisions, then the old collection is dropped and the indexes are
 *    ensured explicitly.
 * 2. Workspace fields: `settings.appsV2Enabled` → `settings.appsEnabled`,
 *    `appsV2Repo` → `appsRepo` (already-deprecated single binding),
 *    `appsV2CloudRepo` → `appsCloudRepo`.
 *
 * v1 data is untouched: `MakoApp` documents, their `migratedToV2ProjectId`
 * stamps, and `entity_versions` are deliberately retained (apps.md §13.21 —
 * 127 workspaces still hold unmigrated v1 docs and 45 public links serve
 * from them).
 */
import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Rename apps-v2 collections (app_*_v2 → app_*) and workspace appsV2* fields";

const COLLECTION_RENAMES: Array<{ from: string; to: string }> = [
  { from: "app_projects_v2", to: "app_projects" },
  { from: "app_worktrees_v2", to: "app_worktrees" },
];

/** Indexes the schema declares, ensured after a document-merge fallback. */
const INDEXES: Record<
  string,
  Array<{
    keys: Record<string, 1 | -1>;
    unique?: boolean;
    sparse?: boolean;
  }>
> = {
  app_projects: [
    { keys: { workspaceId: 1, updatedAt: -1 } },
    { keys: { "publicShare.token": 1 }, unique: true, sparse: true },
    { keys: { workspaceId: 1, slug: 1 }, unique: true, sparse: true },
  ],
  app_worktrees: [{ keys: { workspaceId: 1, userId: 1 }, unique: true }],
};

export async function up(db: Db): Promise<void> {
  const existing = new Set(
    (await db.listCollections().toArray()).map(c => c.name),
  );

  for (const { from, to } of COLLECTION_RENAMES) {
    if (!existing.has(from)) {
      log.info("No legacy collection; nothing to rename", { from });
      continue;
    }
    if (!existing.has(to)) {
      await db.renameCollection(from, to);
      log.info("Renamed collection", { from, to });
      continue;
    }
    // Both exist: new code already wrote to the new name before this ran.
    // Newer documents win on _id collision; then drop the old collection.
    await db
      .collection(from)
      .aggregate([
        {
          $merge: {
            into: to,
            on: "_id",
            whenMatched: "keepExisting",
            whenNotMatched: "insert",
          },
        },
      ])
      .toArray();
    await db.collection(from).drop();
    for (const index of INDEXES[to] ?? []) {
      await db.collection(to).createIndex(index.keys, {
        unique: index.unique,
        sparse: index.sparse,
      });
    }
    log.info("Merged legacy collection into renamed one", { from, to });
  }

  const workspaces = db.collection("workspaces");
  const flag = await workspaces.updateMany(
    { "settings.appsV2Enabled": { $exists: true } },
    { $rename: { "settings.appsV2Enabled": "settings.appsEnabled" } },
  );
  const repo = await workspaces.updateMany(
    { appsV2Repo: { $exists: true } },
    { $rename: { appsV2Repo: "appsRepo" } },
  );
  const cloudRepo = await workspaces.updateMany(
    { appsV2CloudRepo: { $exists: true } },
    { $rename: { appsV2CloudRepo: "appsCloudRepo" } },
  );
  log.info("Renamed workspace appsV2* fields", {
    appsEnabled: flag.modifiedCount,
    appsRepo: repo.modifiedCount,
    appsCloudRepo: cloudRepo.modifiedCount,
  });
}
