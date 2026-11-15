/**
 * What the apps index holds: one row per app, the snapshot of a commit, and
 * the owner of a personal app by the handle mapping.
 */
import { DEFAULT_BRANCH } from "../repository.service";
import type { OwnerDirectory } from "../user-handles";
import { parseAppRepoPath, type AppScope } from "../app-paths";

export const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
// 2: rows carry `tables` (search), who first added the app and its
// thumbnail (discovery).
// 3: rows carry `bindings` (the names on main), so freshness ignores state
// rows left behind by deleted or renamed bindings.
// 4: rows carry `bindingTables` (which binding reads which table), and
// `tables` keeps `{{ dbt_schema }}.model` references the extraction dropped.
export const INDEX_SCHEMA_VERSION = 4;

export interface AppSchedule {
  binding: string;
  cron: string;
  timezone?: string;
}

/** One app as the index knows it — the shape every reader gets. */
export interface AppIndexRow {
  appId: string;
  path: string;
  slug: string;
  scope: AppScope;
  /**
   * For a personal app: the userId the `users/<handle>` segment resolves to
   * through the workspace's handle mapping — absent when the handle is
   * nobody's. Never the raw folder name.
   */
  ownerId?: string;
  treeOid: string;
  title: string;
  description?: string;
  hasManifestId: boolean;
  duplicateOf?: string;
  schedules: AppSchedule[];
  /** Binding names on main (`bindings/<name>.sql`). */
  bindings: string[];
  /** Tables the app's bindings read (`FROM`/`JOIN`), for search. */
  tables: string[];
  /**
   * The same tables per binding, so "who reads this model" can name the
   * binding file (model_readers). Absent on rows built before version 4.
   */
  bindingTables?: AppBindingTables[];
  /**
   * Who committed the app's `mako.json` first, and when — the closest thing
   * a folder-only app has to an author and a creation date. Absent when git
   * could not say (history rewritten, a shallow clone).
   */
  authorEmail?: string;
  firstCommitAt?: string;
  /** The app's own thumbnail image at its root (see APP_THUMBNAIL_FILES). */
  thumbnail?: AppThumbnailRef;
}

export interface AppBindingTables {
  binding: string;
  tables: string[];
}

export interface AppThumbnailRef {
  file: string;
  oid: string;
}

/**
 * The thumbnail convention: an image at the app's root, first match wins.
 * Builders ship it themselves (the starter template writes a placeholder);
 * the Apps home shows it on the app's card. Served by blob oid, so a new
 * picture is a new URL and an old one caches forever.
 */
export const APP_THUMBNAIL_FILES = [
  "thumbnail.png",
  "thumbnail.webp",
  "thumbnail.jpg",
  "thumbnail.jpeg",
  "thumbnail.svg",
] as const;

export interface AppsIndexSnapshot {
  /** The main commit the rows describe; "" when the workspace has no repo. */
  sha: string;
  apps: AppIndexRow[];
  /** Every folder in the app trees (`apps/Sales`, `users/<handle>/apps/x`). */
  folders: string[];
}

export const EMPTY: AppsIndexSnapshot = { sha: "", apps: [], folders: [] };

/** The userId a personal app's folder belongs to, by the handle mapping. */
export function ownerOfAppPath(
  path: string,
  directory: OwnerDirectory,
): string | undefined {
  const loc = parseAppRepoPath(path);
  if (loc?.scope !== "private") return undefined;
  return directory.ownerOf(loc.ownerHandle) ?? undefined;
}

const resolvedSnapshots = new WeakMap<
  AppsIndexSnapshot,
  { directory: OwnerDirectory; snapshot: AppsIndexSnapshot }
>();

/**
 * The snapshot with every personal row's owner resolved against the CURRENT
 * mapping. Stored rows carry the owner as of their sync; a handle assigned
 * since (a member who just joined) must not wait for the next push.
 */
export function withOwners(
  snapshot: AppsIndexSnapshot,
  directory: OwnerDirectory,
): AppsIndexSnapshot {
  const hit = resolvedSnapshots.get(snapshot);
  if (hit?.directory === directory) return hit.snapshot;
  const resolved: AppsIndexSnapshot = {
    ...snapshot,
    apps: snapshot.apps.map(app => {
      if (app.scope !== "private") return app;
      const ownerId = ownerOfAppPath(app.path, directory);
      return ownerId === app.ownerId ? app : { ...app, ownerId };
    }),
  };
  resolvedSnapshots.set(snapshot, { directory, snapshot: resolved });
  return resolved;
}
