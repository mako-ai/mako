/**
 * The cut (apps.md §17): the v1 app data, its public links, its
 * materialized parquet, and the Mako-hosted repo tier all go.
 *
 * 1. Bucket: every v1 binding artifact —
 *    `<prefix>/workspaces/<ws>/apps/<makoAppId>/…` — deleted, scoped by the
 *    ids in `makoapps` so nothing a git-backed app or a dashboard wrote is
 *    touched (their keys never carry a MakoApp id).
 * 2. Mongo: `makoapps` dropped (that is where the 22 public links lived —
 *    `/share/<token>` now 404s), `entity_versions` of type "app" removed,
 *    and the pre-monorepo leftovers (`app_v2_*`, `app_*_v2`) dropped.
 * 3. Workspaces: `appsCloudRepo` / `appsV2CloudRepo` pointers and the v1
 *    `settings.appBindingRefreshConcurrency` unset.
 *
 * Runs on deploy with the production bucket in env (GCS_DASHBOARD_BUCKET +
 * DASHBOARD_ARTIFACT_PREFIX) and GCP credentials (the deploy job
 * authenticates before `pnpm run migrate`). Re-runnable: a second run finds
 * nothing to delete. Filesystem stores (dev) prune the same paths on disk.
 *
 * The doomed prefixes are persisted to `v1_artifact_purge_backlog` BEFORE
 * anything is dropped, and the entry is marked purged only after the bucket
 * delete succeeds. A denied bucket (the deployer SA lacked
 * storage.objects.list on the first prod run) therefore cannot orphan the
 * parquet untracked: the migration completes, and
 * `pnpm apps:purge-v1-artifacts` sweeps the backlog once access exists.
 */
import fs from "node:fs/promises";
import { Db, ObjectId } from "mongodb";
import { Storage } from "@google-cloud/storage";
import { loggers } from "../logging";
import { getArtifactPrefix } from "../services/dashboard-cache.service";
import {
  getDashboardArtifactStoreType,
  getFilesystemArtifactPath,
} from "../services/dashboard-artifact-store.service";

const log = loggers.migration();

export const description =
  "Delete v1 app data: public links (makoapps), app entity_versions, binding parquet in the artifact bucket, legacy app_v2_* collections, and mako-cloud repo pointers";

const LEGACY_COLLECTIONS = [
  "app_projects_v2",
  "app_worktrees_v2",
  "app_v2_binding_state",
  "app_v2_commits",
  "app_v2_projects",
  "app_v2_sessions",
  "app_v2_worktrees",
];

async function purgeArtifacts(
  prefixes: string[],
): Promise<{ prefixes: number; deleted: number; skipped: string | null }> {
  if (prefixes.length === 0) return { prefixes: 0, deleted: 0, skipped: null };

  // A configured bucket wins over store-type detection: this runs on the
  // deploy runner, where DASHBOARD_ARTIFACT_STORE may be unset while the
  // bucket env is present — falling back to a filesystem "purge" there
  // would drop makoapps and orphan the parquet forever.
  const bucketName = process.env.GCS_DASHBOARD_BUCKET;
  const storeType = getDashboardArtifactStoreType();
  if (bucketName || storeType === "gcs") {
    if (!bucketName) {
      return {
        prefixes: prefixes.length,
        deleted: 0,
        skipped: "GCS_DASHBOARD_BUCKET unset",
      };
    }
    const bucket = new Storage().bucket(bucketName);
    let deleted = 0;
    for (const p of prefixes) {
      const [files] = await bucket.getFiles({ prefix: p });
      if (files.length === 0) continue;
      await bucket.deleteFiles({ prefix: p, force: true });
      deleted += files.length;
    }
    return { prefixes: prefixes.length, deleted, skipped: null };
  }
  if (storeType === "filesystem") {
    let deleted = 0;
    for (const p of prefixes) {
      const dir = getFilesystemArtifactPath(p.replace(/\/$/, ""));
      const existed = await fs
        .stat(dir)
        .then(() => true)
        .catch(() => false);
      if (!existed) continue;
      await fs.rm(dir, { recursive: true, force: true });
      deleted++;
    }
    return { prefixes: prefixes.length, deleted, skipped: null };
  }
  return {
    prefixes: prefixes.length,
    deleted: 0,
    skipped: `artifact store "${storeType}" has no prefix delete here`,
  };
}

export async function up(db: Db): Promise<void> {
  const collections = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map(
      c => c.name,
    ),
  );

  // 1. Bucket first — it needs the app ids that step 2 drops. The prefix
  // list is persisted before any attempt so a denied bucket loses nothing.
  if (collections.has("makoapps")) {
    const apps = (await db
      .collection("makoapps")
      .find({}, { projection: { _id: 1, workspaceId: 1 } })
      .toArray()) as Array<{ _id: ObjectId; workspaceId?: ObjectId }>;
    const prefix = getArtifactPrefix();
    const prefixes = apps
      .filter(a => a.workspaceId)
      .map(a => `${prefix}/workspaces/${a.workspaceId}/apps/${a._id}/`);
    const backlog = db.collection("v1_artifact_purge_backlog");
    if (prefixes.length > 0) {
      await backlog.insertOne({ prefixes, createdAt: new Date() });
    }
    try {
      const purge = await purgeArtifacts(prefixes);
      log.info("v1 app artifacts purged", { apps: apps.length, ...purge });
      if (!purge.skipped) {
        await backlog.updateMany(
          { purgedAt: { $exists: false } },
          { $set: { purgedAt: new Date() } },
        );
      }
    } catch (error) {
      log.error(
        "v1 artifact purge failed; prefixes are in v1_artifact_purge_backlog — run `pnpm apps:purge-v1-artifacts` once the credential can list the bucket",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }

    // 2. The documents (and with them every v1 public link).
    await db.collection("makoapps").drop();
    log.info("makoapps dropped", { apps: apps.length });
  }

  if (collections.has("entity_versions")) {
    const r = await db
      .collection("entity_versions")
      .deleteMany({ entityType: "app" });
    log.info("app entity_versions removed", { deleted: r.deletedCount });
  }

  for (const name of LEGACY_COLLECTIONS) {
    if (!collections.has(name)) continue;
    await db.collection(name).drop();
    log.info("legacy collection dropped", { name });
  }

  // 3. Workspace fields the code no longer reads.
  const ws = await db.collection("workspaces").updateMany(
    {
      $or: [
        { appsCloudRepo: { $exists: true } },
        { appsV2CloudRepo: { $exists: true } },
        { "settings.appBindingRefreshConcurrency": { $exists: true } },
      ],
    },
    {
      $unset: {
        appsCloudRepo: "",
        appsV2CloudRepo: "",
        "settings.appBindingRefreshConcurrency": "",
      },
    },
  );
  log.info("workspace fields unset", { modified: ws.modifiedCount });
}
