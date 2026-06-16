import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Unified Google-style sharing: backfill workspaceRole + sharedWith on dashboards/consoles/apps and create share indexes";

/**
 * Migration: unified sharing model
 *
 * - Dashboards & consoles: workspaceRole defaults to "viewer" (matches the
 *   pre-existing behavior where workspace-shared items were read-only for
 *   regular members).
 * - Apps: existing workspace-shared apps get workspaceRole "editor" to
 *   preserve the old "any member can edit" behavior; private apps default to
 *   "viewer" like everything else.
 * - sharedWith arrays are initialized to [] where missing (consoles + apps;
 *   dashboards were already backfilled by 2026-06-04 dashboard_shared_with).
 * - Indexes: sharedWith.userId lookups and unique sparse publicShare.token.
 */
function hasIndexOnKeys(
  indexes: Array<{ key?: Record<string, unknown> }>,
  keyPattern: Record<string, unknown>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => idx.key && JSON.stringify(idx.key) === target);
}

async function ensureIndex(
  db: Db,
  collectionName: string,
  keyPattern: Record<string, unknown>,
  options: Record<string, unknown> = {},
): Promise<void> {
  const col = db.collection(collectionName);
  try {
    const existingIndexes = await col.indexes();
    if (hasIndexOnKeys(existingIndexes, keyPattern)) {
      log.info(
        `Index ${JSON.stringify(keyPattern)} already exists on ${collectionName}, skipping`,
      );
      return;
    }
    await col.createIndex(keyPattern as any, { background: true, ...options });
    log.info(
      `Created index ${JSON.stringify(keyPattern)} on ${collectionName}`,
    );
  } catch (err: any) {
    if (err?.code === 85 || err?.codeName === "IndexOptionsConflict") {
      log.info(
        `Index on ${collectionName} already exists (different name), skipping`,
      );
    } else {
      throw err;
    }
  }
}

export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const names = collections.map(c => c.name);

  // ── Dashboards ──
  if (names.includes("dashboards")) {
    const col = db.collection("dashboards");
    const r = await col.updateMany(
      { workspaceRole: { $exists: false } },
      { $set: { workspaceRole: "viewer" } },
    );
    log.info(`dashboards: set workspaceRole=viewer on ${r.modifiedCount} docs`);
    await ensureIndex(
      db,
      "dashboards",
      { "publicShare.token": 1 },
      { unique: true, sparse: true },
    );
  }

  // ── Saved consoles ──
  if (names.includes("savedconsoles")) {
    const col = db.collection("savedconsoles");
    const r1 = await col.updateMany(
      { workspaceRole: { $exists: false } },
      { $set: { workspaceRole: "viewer" } },
    );
    const r2 = await col.updateMany(
      { sharedWith: { $exists: false } },
      { $set: { sharedWith: [] } },
    );
    log.info(
      `savedconsoles: workspaceRole=viewer on ${r1.modifiedCount}, sharedWith=[] on ${r2.modifiedCount}`,
    );
    await ensureIndex(db, "savedconsoles", {
      workspaceId: 1,
      "sharedWith.userId": 1,
    });
  }

  // ── Apps ──
  if (names.includes("makoapps")) {
    const col = db.collection("makoapps");
    // Preserve legacy behavior: workspace-shared apps were editable by any
    // member, so existing ones keep editor as the workspace role.
    const r1 = await col.updateMany(
      { workspaceRole: { $exists: false }, access: "workspace" },
      { $set: { workspaceRole: "editor" } },
    );
    const r2 = await col.updateMany(
      { workspaceRole: { $exists: false } },
      { $set: { workspaceRole: "viewer" } },
    );
    const r3 = await col.updateMany(
      { sharedWith: { $exists: false } },
      { $set: { sharedWith: [] } },
    );
    log.info(
      `makoapps: workspaceRole=editor on ${r1.modifiedCount}, viewer on ${r2.modifiedCount}, sharedWith=[] on ${r3.modifiedCount}`,
    );
    await ensureIndex(db, "makoapps", {
      workspaceId: 1,
      "sharedWith.userId": 1,
    });
    await ensureIndex(
      db,
      "makoapps",
      { "publicShare.token": 1 },
      { unique: true, sparse: true },
    );
  }
}
