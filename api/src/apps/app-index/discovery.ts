/**
 * Discovery — pure over a tree listing — and reading the app trees and
 * manifests at a commit.
 */
import { parseBindingFrontMatter } from "../bindings.service";
import { extractTables } from "../app-search";
import { runGit } from "../git";
import { readBlobsBatch } from "../repository.service";
import {
  APPS_DIR,
  APP_MANIFEST,
  USERS_DIR,
  parseAppFolderPath,
  parseAppManifest,
  parseAppRepoPath,
  type AppScope,
} from "../app-paths";
import {
  AppSchedule,
  AppBindingTables,
  AppThumbnailRef,
  APP_ICON_FILES,
  APP_THUMBNAIL_FILES,
} from "./rows";

// ---------------------------------------------------------------------------
// Discovery — pure over a tree listing
// ---------------------------------------------------------------------------

export interface DiscoveredApp {
  path: string;
  slug: string;
  scope: AppScope;
  /** The raw `users/<handle>` segment; resolved into a row's ownerId. */
  ownerHandle?: string;
  treeOid: string;
  manifestOid: string;
  /** `bindings/<name>.sql` blobs, by binding name. */
  bindingBlobs: Map<string, string>;
  thumbnail?: AppThumbnailRef;
  icon?: AppThumbnailRef;
}

export interface Discovery {
  apps: DiscoveredApp[];
  folders: string[];
}

interface TreeRecord {
  type: "tree" | "blob";
  oid: string;
  path: string;
}

/**
 * Which folders under the app trees are apps, which are folders, and what
 * each app's tree oid is. An app is a folder with a manifest; nothing inside
 * an app is another app, so a nested `mako.json` (a vendored example, a
 * fixture) does not split the app in two. Pure, so it is unit-tested.
 */
export function discoverApps(records: TreeRecord[]): Discovery {
  const appDirs = new Set<string>();
  const manifestOids = new Map<string, string>();
  for (const r of records) {
    if (r.type !== "blob") continue;
    const slash = r.path.lastIndexOf("/");
    if (slash < 0 || r.path.slice(slash + 1) !== APP_MANIFEST) continue;
    const dir = r.path.slice(0, slash);
    if (!parseAppRepoPath(dir)) continue;
    appDirs.add(dir);
    manifestOids.set(dir, r.oid);
  }
  // Outermost wins: drop any app dir with an app dir above it.
  const sorted = [...appDirs].sort();
  const roots: string[] = [];
  for (const dir of sorted) {
    if (roots.some(r => dir.startsWith(`${r}/`))) continue;
    roots.push(dir);
  }
  const rootSet = new Set(roots);
  const insideApp = (p: string): string | null => {
    for (const r of roots) if (p === r || p.startsWith(`${r}/`)) return r;
    return null;
  };

  // A folder holds apps and folders, nothing else: a directory with files
  // of its own (a manifest-less project under apps/, or its src/) is not a
  // folder, and neither is anything beneath it. `.gitkeep` is the one file
  // a folder may hold (an empty folder is a commit of that marker).
  // The tree roots (`apps`, `users/<handle>/apps`) may hold stray files
  // (a README) without disqualifying everything beneath them.
  const withOwnFiles = new Set<string>();
  for (const r of records) {
    if (r.type !== "blob") continue;
    const slash = r.path.lastIndexOf("/");
    if (slash < 0 || r.path.slice(slash + 1) === ".gitkeep") continue;
    const dir = r.path.slice(0, slash);
    const parsed = parseAppFolderPath(dir);
    if (!parsed || parsed.folderSegments.length === 0) continue;
    withOwnFiles.add(dir);
  }
  const insideProject = (p: string): boolean => {
    for (const dir of withOwnFiles) {
      if (p === dir || p.startsWith(`${dir}/`)) return true;
    }
    return false;
  };

  const treeOids = new Map<string, string>();
  const folders: string[] = [];
  for (const r of records) {
    if (r.type !== "tree") continue;
    if (rootSet.has(r.path)) {
      treeOids.set(r.path, r.oid);
      continue;
    }
    if (insideApp(r.path) || insideProject(r.path)) continue;
    const folder = parseAppFolderPath(r.path);
    // The tree roots themselves (`apps`, `users/<handle>/apps`) are implicit.
    if (folder && folder.folderSegments.length > 0) folders.push(r.path);
  }

  const bindings = new Map<string, Map<string, string>>();
  const thumbnails = new Map<string, AppThumbnailRef>();
  const thumbRank = (file: string) =>
    (APP_THUMBNAIL_FILES as readonly string[]).indexOf(file);
  const icons = new Map<string, AppThumbnailRef>();
  const iconRank = (file: string) =>
    (APP_ICON_FILES as readonly string[]).indexOf(file);
  for (const r of records) {
    if (r.type !== "blob") continue;
    const app = insideApp(r.path);
    if (!app) continue;
    const rel = r.path.slice(app.length + 1);
    if (thumbRank(rel) >= 0) {
      const prev = thumbnails.get(app);
      if (!prev || thumbRank(rel) < thumbRank(prev.file)) {
        thumbnails.set(app, { file: rel, oid: r.oid });
      }
      continue;
    }
    if (iconRank(rel) >= 0) {
      const prev = icons.get(app);
      if (!prev || iconRank(rel) < iconRank(prev.file)) {
        icons.set(app, { file: rel, oid: r.oid });
      }
      continue;
    }
    const m = /^bindings\/([A-Za-z0-9_][A-Za-z0-9_-]*)\.sql$/.exec(
      r.path.slice(app.length + 1),
    );
    if (!m) continue;
    let map = bindings.get(app);
    if (!map) bindings.set(app, (map = new Map()));
    map.set(m[1], r.oid);
  }

  const apps: DiscoveredApp[] = [];
  for (const dir of roots) {
    const loc = parseAppRepoPath(dir);
    const treeOid = treeOids.get(dir);
    if (!loc || !treeOid) continue;
    apps.push({
      path: dir,
      slug: loc.slug,
      scope: loc.scope,
      ownerHandle: loc.ownerHandle,
      treeOid,
      manifestOid: manifestOids.get(dir) ?? "",
      bindingBlobs: bindings.get(dir) ?? new Map(),
      ...(thumbnails.get(dir) ? { thumbnail: thumbnails.get(dir) } : {}),
      ...(icons.get(dir) ? { icon: icons.get(dir) } : {}),
    });
  }
  apps.sort((a, b) => a.path.localeCompare(b.path));
  folders.sort();
  return { apps, folders };
}

/** `ls-tree -r -t` over the app trees at a commit, parsed. */
export async function listAppTrees(
  repoDir: string,
  sha: string,
): Promise<TreeRecord[]> {
  const { stdout } = await runGit(
    [
      "-C",
      repoDir,
      "ls-tree",
      "-r",
      "-t",
      "-z",
      sha,
      "--",
      APPS_DIR,
      USERS_DIR,
    ],
    { timeoutMs: 60_000 },
  );
  const out: TreeRecord[] = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [, type, oid] = record.slice(0, tab).split(/\s+/);
    if (type !== "tree" && type !== "blob") continue;
    out.push({ type, oid, path: record.slice(tab + 1) });
  }
  return out;
}

/** The apps at a commit, with their manifests and schedules read. */
export async function readAppsAt(
  repoDir: string,
  sha: string,
): Promise<
  Discovery & {
    manifests: Map<string, ReturnType<typeof parseAppManifest>>;
    schedules: Map<string, AppSchedule[]>;
    tables: Map<string, string[]>;
    bindingTables: Map<string, AppBindingTables[]>;
  }
> {
  const discovery = discoverApps(await listAppTrees(repoDir, sha));
  const paths: string[] = [];
  for (const app of discovery.apps) {
    paths.push(`${app.path}/${APP_MANIFEST}`);
    for (const name of app.bindingBlobs.keys()) {
      paths.push(`${app.path}/bindings/${name}.sql`);
    }
  }
  const blobs = await readBlobsBatch(repoDir, sha, paths);
  const manifests = new Map<string, ReturnType<typeof parseAppManifest>>();
  const schedules = new Map<string, AppSchedule[]>();
  const tables = new Map<string, string[]>();
  const bindingTables = new Map<string, AppBindingTables[]>();
  for (const app of discovery.apps) {
    const manifest = blobs.get(`${app.path}/${APP_MANIFEST}`);
    manifests.set(
      app.path,
      parseAppManifest(manifest ? manifest.toString("utf8") : null, app.slug),
    );
    const list: AppSchedule[] = [];
    const reads = new Map<string, string>();
    const perBinding: AppBindingTables[] = [];
    for (const name of [...app.bindingBlobs.keys()].sort()) {
      const blob = blobs.get(`${app.path}/bindings/${name}.sql`);
      if (!blob) continue;
      const sql = blob.toString("utf8");
      const read = extractTables(sql);
      if (read.length > 0) perBinding.push({ binding: name, tables: read });
      for (const t of read) {
        if (!reads.has(t.toLowerCase())) reads.set(t.toLowerCase(), t);
      }
      const meta = parseBindingFrontMatter(sql);
      if (meta.schedule) {
        list.push({
          binding: name,
          cron: meta.schedule,
          ...(meta.timezone ? { timezone: meta.timezone } : {}),
        });
      }
    }
    schedules.set(app.path, list);
    tables.set(app.path, [...reads.values()]);
    bindingTables.set(app.path, perBinding);
  }
  return { ...discovery, manifests, schedules, tables, bindingTables };
}
