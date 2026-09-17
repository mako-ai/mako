import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Apps in real folders + favourites: backfill AppProject.path, replace the unique slug index with a unique path index, create app_index / app_index_heads / favourites";

function hasIndexOnKeys(
  indexes: Array<{ key: Record<string, unknown> }>,
  keyPattern: Record<string, number>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key) === target);
}

async function ensureCollection(db: Db, name: string): Promise<void> {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name);
    log.info(`Created collection '${name}'`);
  }
}

export async function up(db: Db): Promise<void> {
  const projects = db.collection("app_projects");

  // Every legacy row lived at apps/<slug>; that is now an explicit column the
  // index sync keeps current as folders move.
  const backfilled = await projects.updateMany(
    { slug: { $exists: true, $ne: null }, path: { $exists: false } },
    [{ $set: { path: { $concat: ["apps/", "$slug"] } } }],
  );
  log.info("Backfilled AppProject.path", {
    modified: backfilled.modifiedCount,
  });

  // Slugs stop being unique once folders nest (apps/a/report, apps/b/report).
  // The path is what cannot collide.
  const indexes = (await projects.indexes()) as Array<{
    name: string;
    key: Record<string, unknown>;
    unique?: boolean;
  }>;
  const slugIndex = indexes.find(
    idx =>
      JSON.stringify(idx.key) === JSON.stringify({ workspaceId: 1, slug: 1 }),
  );
  if (slugIndex?.unique) {
    await projects.dropIndex(slugIndex.name);
    log.info("Dropped unique (workspaceId, slug) index", {
      name: slugIndex.name,
    });
  }
  const after = (await projects.indexes()) as Array<{
    name: string;
    key: Record<string, unknown>;
    sparse?: boolean;
    partialFilterExpression?: unknown;
  }>;
  if (!hasIndexOnKeys(after, { workspaceId: 1, slug: 1 })) {
    await projects.createIndex({ workspaceId: 1, slug: 1 });
  }
  // Partial, not sparse: a compound sparse index still indexes rows whose
  // `path` is missing (workspaceId is present), so two rows with the path
  // unset — mid-move, or orphaned state rows — would collide on null.
  const pathIndex = after.find(
    idx =>
      JSON.stringify(idx.key) === JSON.stringify({ workspaceId: 1, path: 1 }),
  );
  if (pathIndex && !pathIndex.partialFilterExpression) {
    await projects.dropIndex(pathIndex.name);
  }
  if (!pathIndex || !pathIndex.partialFilterExpression) {
    await projects.createIndex(
      { workspaceId: 1, path: 1 },
      { unique: true, partialFilterExpression: { path: { $exists: true } } },
    );
  }

  await ensureCollection(db, "app_index");
  const appIndex = db.collection("app_index");
  const appIndexIndexes = await appIndex.indexes();
  if (!hasIndexOnKeys(appIndexIndexes, { workspaceId: 1, appId: 1 })) {
    await appIndex.createIndex({ workspaceId: 1, appId: 1 }, { unique: true });
  }
  if (!hasIndexOnKeys(appIndexIndexes, { workspaceId: 1, path: 1 })) {
    await appIndex.createIndex({ workspaceId: 1, path: 1 }, { unique: true });
  }
  if (!hasIndexOnKeys(appIndexIndexes, { workspaceId: 1, slug: 1 })) {
    await appIndex.createIndex({ workspaceId: 1, slug: 1 });
  }

  await ensureCollection(db, "app_index_heads");
  const heads = db.collection("app_index_heads");
  if (!hasIndexOnKeys(await heads.indexes(), { workspaceId: 1 })) {
    await heads.createIndex({ workspaceId: 1 }, { unique: true });
  }

  await ensureCollection(db, "favourites");
  const favourites = db.collection("favourites");
  const favIndexes = await favourites.indexes();
  if (
    !hasIndexOnKeys(favIndexes, {
      workspaceId: 1,
      userId: 1,
      parentId: 1,
      position: 1,
    })
  ) {
    await favourites.createIndex({
      workspaceId: 1,
      userId: 1,
      parentId: 1,
      position: 1,
    });
  }
  if (
    !hasIndexOnKeys(favIndexes, {
      workspaceId: 1,
      userId: 1,
      kind: 1,
      refId: 1,
    })
  ) {
    await favourites.createIndex(
      { workspaceId: 1, userId: 1, kind: 1, refId: 1 },
      { unique: true, partialFilterExpression: { type: "item" } },
    );
  }
}
