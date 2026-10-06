/**
 * The apps index — git is the list, Mongo is the derived read model.
 *
 * Every app in a workspace is a folder holding `mako.json`, anywhere under
 * `apps/` or `users/<id>/apps/` (apps.md §13.6, folders per §16's consoles
 * pattern). This module reads that tree at `main` ONCE per push and writes
 * one flat row per app (`app_index`), so the sidebar, the agent's list, search
 * and the binding scheduler never open the repo themselves. The rows are
 * disposable: drop the collection and the next read rebuilds it.
 *
 * Identity comes from the manifest's `id`; a manifest without one keeps its
 * existing project id, or derives one from its path when it has no state. Two folders declaring the same id
 * (a copied app that kept its source's manifest) is a conflict the index
 * records rather than resolves: the incumbent keeps the id, the copy is filed
 * under a derived id with `duplicateOf` set, and the UI offers to stamp it.
 *
 * Must not import worktree.service (it imports this module).
 */
import { Types } from "mongoose";
import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
  type IAppIndexEntry,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { parseBindingFrontMatter } from "./bindings.service";
import { freshenForServe } from "./cloud-repo.service";
import { runGit } from "./git";
import {
  DEFAULT_BRANCH,
  readBlobsBatch,
  resolveCommit,
} from "./repository.service";
import { boundRepoDirIfExists } from "./workspace-repo-required";
import { createSerializer } from "./serialized";
import {
  APPS_DIR,
  APP_MANIFEST,
  USERS_DIR,
  appKeyOf,
  derivedAppId,
  isAppId,
  parseAppAliases,
  parseAppFolderPath,
  parseAppManifest,
  parseAppRepoPath,
  type AppScope,
} from "./app-paths";

const logger = loggers.api("apps-index");

const MAIN = `refs/heads/${DEFAULT_BRANCH}`;
// 2: rows carry `aliases` (a v1 index is rebuilt once to pick them up).
const INDEX_SCHEMA_VERSION = 2;

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
  ownerId?: string;
  treeOid: string;
  title: string;
  description?: string;
  hasManifestId: boolean;
  duplicateOf?: string;
  /**
   * Previous slugs/paths of the app: the manifest's `aliases` plus what the
   * index learned on its own (a laptop `git mv`, renames in git history).
   * See {@link findAppInSnapshot}.
   */
  aliases: string[];
  schedules: AppSchedule[];
}

/**
 * How many aliases one app keeps, manifest and index together. An app that
 * has been renamed more often than this keeps its most recent names; a
 * link to a name older than that is a link nobody has followed in years.
 */
export const MAX_ALIASES_PER_APP = 24;

/**
 * How far back the history scan looks for renamed manifests, in commits
 * touching the app trees. A full index build on a busy repo must stay a
 * single bounded git call, not a crawl.
 */
export const HISTORY_SCAN_MAX_COMMITS = 500;

export interface AppsIndexSnapshot {
  /** The main commit the rows describe; "" when the workspace has no repo. */
  sha: string;
  apps: AppIndexRow[];
  /** Every folder in the app trees (`apps/Sales`, `users/<id>/apps/x`). */
  folders: string[];
}

const EMPTY: AppsIndexSnapshot = { sha: "", apps: [], folders: [] };

// ---------------------------------------------------------------------------
// Discovery — pure over a tree listing
// ---------------------------------------------------------------------------

export interface DiscoveredApp {
  path: string;
  slug: string;
  scope: AppScope;
  ownerId?: string;
  treeOid: string;
  manifestOid: string;
  /** `bindings/<name>.sql` blobs, by binding name. */
  bindingBlobs: Map<string, string>;
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
  // The tree roots (`apps`, `users/<id>/apps`) may hold stray files
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
    // The tree roots themselves (`apps`, `users/<id>/apps`) are implicit.
    if (folder && folder.folderSegments.length > 0) folders.push(r.path);
  }

  const bindings = new Map<string, Map<string, string>>();
  for (const r of records) {
    if (r.type !== "blob") continue;
    const app = insideApp(r.path);
    if (!app) continue;
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
      ownerId: loc.ownerId,
      treeOid,
      manifestOid: manifestOids.get(dir) ?? "",
      bindingBlobs: bindings.get(dir) ?? new Map(),
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
  for (const app of discovery.apps) {
    const manifest = blobs.get(`${app.path}/${APP_MANIFEST}`);
    manifests.set(
      app.path,
      parseAppManifest(manifest ? manifest.toString("utf8") : null, app.slug),
    );
    const list: AppSchedule[] = [];
    for (const name of [...app.bindingBlobs.keys()].sort()) {
      const blob = blobs.get(`${app.path}/bindings/${name}.sql`);
      if (!blob) continue;
      const meta = parseBindingFrontMatter(blob.toString("utf8"));
      if (meta.schedule) {
        list.push({
          binding: name,
          cron: meta.schedule,
          ...(meta.timezone ? { timezone: meta.timezone } : {}),
        });
      }
    }
    schedules.set(app.path, list);
  }
  return { ...discovery, manifests, schedules };
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

/**
 * Assign each discovered app its id. Pure; `incumbents` says which path a
 * contested id was last filed under (the previous index or a project row),
 * so a copy never steals the original's identity.
 */
export function assignAppIds(
  workspaceId: string,
  apps: Array<{ path: string; declaredId?: string; treeOid?: string }>,
  incumbents: Map<string, string>,
  unavailableIds: ReadonlySet<string> = new Set(),
  /**
   * Tree oid → id of an UNSTAMPED app whose folder is no longer where the
   * index last saw it. A laptop `git mv` of a legacy app (no `id` in its
   * manifest) keeps the folder's tree oid, and that is the only trace of its
   * identity left in git — without this tier the move reads as a delete plus
   * a brand-new app, and its deployment, share link and env vars are lost.
   * Each entry is consumed once, so a copy never inherits it too.
   */
  treeIncumbents: Map<string, string> = new Map(),
  /**
   * New path → old path for app folders git recognises as renamed between
   * the previously indexed commit and this one (`git diff -M` on the
   * manifests). Catches a legacy app moved AND edited in one push, which
   * neither the path nor the tree oid can match.
   */
  renames: Map<string, string> = new Map(),
): Map<
  string,
  { appId: string; hasManifestId: boolean; duplicateOf?: string }
> {
  const idByPath = new Map([...incumbents].map(([id, path]) => [path, id]));
  for (const [to, from] of renames) {
    const id = idByPath.get(from);
    if (id && !idByPath.has(to)) idByPath.set(to, id);
  }
  const byTree = new Map(treeIncumbents);
  const claims = new Map<string, string[]>();
  const wanted = new Map<string, { id: string; declared: boolean }>();
  for (const app of apps) {
    const derived = derivedAppId(workspaceId, appKeyOf(app.path)).toHexString();
    let id = app.declaredId ?? idByPath.get(app.path);
    if (!id && app.treeOid && byTree.has(app.treeOid)) {
      id = byTree.get(app.treeOid);
      byTree.delete(app.treeOid);
    }
    id ??= derived;
    wanted.set(app.path, { id, declared: !!app.declaredId });
    const list = claims.get(id) ?? [];
    list.push(app.path);
    claims.set(id, list);
  }
  const out = new Map<
    string,
    { appId: string; hasManifestId: boolean; duplicateOf?: string }
  >();
  const taken = new Set<string>([...claims.keys(), ...unavailableIds]);
  for (const [id, paths] of claims) {
    let winner: string | undefined;
    if (unavailableIds.has(id)) {
      winner = undefined;
    } else if (paths.length === 1) {
      winner = paths[0];
    } else {
      // The incumbent path keeps the id; failing that, a path that DECLARES
      // it beats one that merely derives to it; failing that, the first.
      const incumbent = incumbents.get(id);
      winner =
        (incumbent && paths.includes(incumbent) ? incumbent : undefined) ??
        paths.find(p => wanted.get(p)?.declared) ??
        [...paths].sort()[0];
    }
    if (winner) {
      out.set(winner, {
        appId: id,
        hasManifestId: !!wanted.get(winner)?.declared,
      });
    }
    for (const loser of paths) {
      if (loser === winner) continue;
      // File the copy under an id of its own, derived from where it sits, so
      // it keeps working — just not as the original.
      let fallback = derivedAppId(workspaceId, appKeyOf(loser)).toHexString();
      let n = 2;
      while (taken.has(fallback)) {
        fallback = derivedAppId(
          workspaceId,
          `${appKeyOf(loser)}#${n++}`,
        ).toHexString();
      }
      taken.add(fallback);
      out.set(loser, {
        appId: fallback,
        hasManifestId: false,
        duplicateOf: id,
      });
    }
  }
  return out;
}

/**
 * Tree oid → id for the unstamped apps among `rows` whose path is not in
 * `presentPaths`: the identities a laptop `git mv` can only be matched to by
 * content. Ambiguous oids (two vanished folders with identical trees) are
 * left out rather than guessed.
 */
export function treeIncumbentsOf(
  rows: Array<
    Pick<AppIndexRow, "appId" | "path" | "treeOid" | "hasManifestId">
  >,
  presentPaths: ReadonlySet<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    if (row.hasManifestId || presentPaths.has(row.path)) continue;
    if (out.has(row.treeOid)) ambiguous.add(row.treeOid);
    out.set(row.treeOid, row.appId);
  }
  for (const oid of ambiguous) out.delete(oid);
  return out;
}

/**
 * App folders git sees as RENAMED between two commits, by their manifests:
 * new app path → old app path. `-M` matches on content similarity, so a
 * manifest that moved untouched (or nearly) is found even when the rest of
 * the app changed in the same commit. Empty when either commit is unknown.
 */
export async function renamedAppFolders(
  repoDir: string,
  from: string,
  to: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!from || !to || from === to) return out;
  let stdout: string;
  try {
    ({ stdout } = await runGit(
      [
        "-C",
        repoDir,
        "diff",
        "--name-status",
        "-M",
        "-z",
        "--diff-filter=R",
        from,
        to,
        "--",
        APPS_DIR,
        USERS_DIR,
      ],
      { timeoutMs: 60_000 },
    ));
  } catch {
    return out;
  }
  const fields = stdout.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [status, oldPath, newPath] = [
      fields[i],
      fields[i + 1],
      fields[i + 2],
    ];
    if (!status.startsWith("R")) continue;
    const suffix = `/${APP_MANIFEST}`;
    if (!oldPath.endsWith(suffix) || !newPath.endsWith(suffix)) continue;
    const oldDir = oldPath.slice(0, -suffix.length);
    const newDir = newPath.slice(0, -suffix.length);
    if (parseAppRepoPath(oldDir) && parseAppRepoPath(newDir)) {
      out.set(newDir, oldDir);
    }
  }
  return out;
}

/**
 * Where each current app folder USED to be, from git history: every rename
 * of its `mako.json` on main, newest first, as `{ from, to }` app paths.
 * Two signals, because neither alone is enough:
 *
 *  - git's own rename detection (`-M`), which pairs a manifest moved with
 *    little or no change (a plain `git mv`, the UI's move commit);
 *  - a manifest DELETED and one ADDED in the same commit that declare the
 *    same `id` — a move plus an edit of a tiny file, which `-M` scores as
 *    unrelated (a 40-byte manifest shares no 64-byte chunk with its edit).
 *
 * A `-M` pair whose two blobs declare DIFFERENT ids is dropped: git paired
 * one app's deleted manifest with another app's new one. The scan is one
 * bounded `git log` over the app trees plus a batch blob read per commit
 * that touched a manifest, so a full index build stays fast on a big repo.
 * `range` is a commit (`main`) or a range (`old..new`) for the incremental
 * case.
 */
export async function manifestRenamesInHistory(
  repoDir: string,
  range: string,
  options: { maxCommits?: number } = {},
): Promise<Array<{ from: string; to: string }>> {
  const suffix = `/${APP_MANIFEST}`;
  const asAppDir = (p: string): string | null => {
    if (!p.endsWith(suffix)) return null;
    const dir = p.slice(0, -suffix.length);
    return parseAppRepoPath(dir) ? dir : null;
  };
  let stdout: string;
  try {
    ({ stdout } = await runGit(
      [
        "-C",
        repoDir,
        "log",
        "-M",
        "--diff-filter=ADR",
        "--name-status",
        "-z",
        "--format=%H",
        `--max-count=${options.maxCommits ?? HISTORY_SCAN_MAX_COMMITS}`,
        range,
        "--",
        APPS_DIR,
        USERS_DIR,
      ],
      { timeoutMs: 60_000 },
    ));
  } catch {
    return [];
  }
  // `-z` output: `<sha>\0\n` then `<status>\0<path>\0[<path>\0]` per entry.
  interface Touch {
    sha: string;
    renamed: Array<{ from: string; to: string }>;
    deleted: string[];
    added: string[];
  }
  const commits: Touch[] = [];
  const tokens = stdout.split("\0").map(t => t.replace(/^\n+/, ""));
  let current: Touch | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^[0-9a-f]{40}$/.test(token)) {
      current = { sha: token, renamed: [], deleted: [], added: [] };
      commits.push(current);
      continue;
    }
    if (!current || !token) continue;
    if (token.startsWith("R")) {
      const from = asAppDir(tokens[i + 1] ?? "");
      const to = asAppDir(tokens[i + 2] ?? "");
      i += 2;
      if (from && to && from !== to) current.renamed.push({ from, to });
    } else if (token === "D" || token === "A") {
      const dir = asAppDir(tokens[i + 1] ?? "");
      i += 1;
      if (dir) (token === "D" ? current.deleted : current.added).push(dir);
    }
  }

  const out: Array<{ from: string; to: string }> = [];
  for (const commit of commits) {
    if (commit.renamed.length === 0) {
      if (commit.deleted.length === 0 || commit.added.length === 0) continue;
    }
    const oldPaths = [
      ...commit.renamed.map(r => r.from),
      ...commit.deleted,
    ].map(d => `${d}${suffix}`);
    const newPaths = [...commit.renamed.map(r => r.to), ...commit.added].map(
      d => `${d}${suffix}`,
    );
    let before: Map<string, Buffer>;
    let after: Map<string, Buffer>;
    try {
      [before, after] = await Promise.all([
        readBlobsBatch(repoDir, `${commit.sha}^`, oldPaths),
        readBlobsBatch(repoDir, commit.sha, newPaths),
      ]);
    } catch {
      // A root commit (no parent) renames nothing.
      continue;
    }
    const idAt = (blobs: Map<string, Buffer>, dir: string) => {
      const blob = blobs.get(`${dir}${suffix}`);
      return blob
        ? parseAppManifest(blob.toString("utf8"), dir.split("/").pop() ?? "").id
        : undefined;
    };
    for (const pair of commit.renamed) {
      const oldId = idAt(before, pair.from);
      const newId = idAt(after, pair.to);
      if (oldId && newId && oldId !== newId) continue;
      out.push(pair);
    }
    if (commit.deleted.length > 0 && commit.added.length > 0) {
      const addedById = new Map<string, string[]>();
      for (const dir of commit.added) {
        const id = idAt(after, dir);
        if (!id) continue;
        addedById.set(id, [...(addedById.get(id) ?? []), dir]);
      }
      for (const dir of commit.deleted) {
        const id = idAt(before, dir);
        const targets = id ? addedById.get(id) : undefined;
        // One deleted manifest, one added, same id: a move. Several added
        // with the same id are copies of each other, not a move.
        if (targets?.length === 1 && targets[0] !== dir) {
          out.push({ from: dir, to: targets[0] });
        }
      }
    }
  }
  return out;
}

/**
 * The aliases history gives each current app: walk its path back through
 * `renames` (newest first) and record every earlier folder name — the
 * slug, plus the path where the slug alone would not say where it was.
 * Pure. Walking in commit order keeps two apps that passed through the
 * same folder name apart: a rename INTO a path that is newer than the
 * app's own arrival there is skipped before the walk reaches it.
 */
export function aliasesFromHistory(
  apps: ReadonlyArray<Pick<AppIndexRow, "path">>,
  renames: ReadonlyArray<{ from: string; to: string }>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const app of apps) {
    const found: string[] = [];
    let current = app.path;
    for (const rename of renames) {
      if (rename.to !== current) continue;
      current = rename.from;
      const slug = current.split("/").pop() ?? current;
      found.push(slug);
      if (current !== `${APPS_DIR}/${slug}`) found.push(current);
      if (found.length >= MAX_ALIASES_PER_APP) break;
    }
    if (found.length > 0) out.set(app.path, found);
  }
  return out;
}

/**
 * One alias list from several sources, each name once, nothing that names
 * the app's own current slug or path, newest sources first, capped.
 */
export function mergeAliases(
  sources: ReadonlyArray<readonly string[]>,
  drop: readonly string[] = [],
): string[] {
  const merged = parseAppAliases(sources.flat()).aliases.filter(
    alias => !drop.includes(alias),
  );
  return merged.slice(0, MAX_ALIASES_PER_APP);
}

/** Is the commit in this repo's object store? */
async function commitExists(repoDir: string, sha: string): Promise<boolean> {
  return runGit(["-C", repoDir, "cat-file", "-e", `${sha}^{commit}`])
    .then(() => true)
    .catch(() => false);
}

/** Is `ancestor` reachable from `descendant`? False when either is unknown here. */
async function isAncestor(
  repoDir: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  if (ancestor === descendant) return true;
  return runGit([
    "-C",
    repoDir,
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant,
  ])
    .then(() => true)
    .catch(() => false);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

const serialized = createSerializer();

/** Per-process memo: the rows cannot change while main's sha does not. */
const snapshotCache = new Map<string, AppsIndexSnapshot>();

function rowToIndex(
  row: Pick<IAppIndexEntry, keyof AppIndexRow | "indexAliases">,
): AppIndexRow {
  return {
    appId: row.appId,
    path: row.path,
    slug: row.slug,
    scope: row.scope,
    ownerId: row.ownerId ?? undefined,
    treeOid: row.treeOid,
    title: row.title,
    description: row.description ?? undefined,
    hasManifestId: row.hasManifestId,
    duplicateOf: row.duplicateOf ?? undefined,
    aliases: mergeAliases([row.aliases ?? [], row.indexAliases ?? []]),
    schedules: (row.schedules ?? []).map(s => ({
      binding: s.binding,
      cron: s.cron,
      ...(s.timezone ? { timezone: s.timezone } : {}),
    })),
  };
}

/**
 * Rebuild the index from the tree at main. Idempotent; a no-op when the
 * index already describes main's current commit unless `force`. Returns the
 * snapshot, or null when the workspace has no bound repo.
 */
export function syncAppsIndexFromRepo(
  workspaceId: string,
  options: { force?: boolean } = {},
): Promise<AppsIndexSnapshot | null> {
  return serialized(workspaceId, async () => {
    try {
      return await syncNow(workspaceId, options);
    } catch (error) {
      // Another workspace may have claimed a manifest id after our read.
      // Re-read ownership and assign this copy its own id.
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === 11000
        )
      ) {
        throw error;
      }
      return syncNow(workspaceId, { force: true });
    }
  });
}

async function syncNow(
  workspaceId: string,
  options: { force?: boolean },
): Promise<AppsIndexSnapshot | null> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return null;
  const sha = await resolveCommit(repoDir, MAIN);
  if (!sha) return null;
  const ws = new Types.ObjectId(workspaceId);
  const head = await AppIndexHead.findOne({ workspaceId: ws }).lean();
  if (head?.schemaVersion === INDEX_SCHEMA_VERSION && !options.force) {
    if (head.sha === sha) {
      const cached = snapshotCache.get(workspaceId);
      if (cached?.sha === sha) return cached;
      const rows = await AppIndexEntry.find({ workspaceId: ws }).lean();
      const snapshot = {
        sha,
        apps: rows.map(rowToIndex),
        folders: head.folders,
      };
      snapshotCache.set(workspaceId, snapshot);
      return snapshot;
    }
    // Never rebuild BACKWARDS. On a multi-instance host the instance that
    // took a push has the new commit before the others fetch it (up to the
    // freshen interval); an instance still on the older main must not
    // overwrite the rows — and flip a just-moved app's project path back —
    // with what its stale clone says. Serve what the index has instead.
    // An indexed commit this clone has never seen is the same case, only
    // earlier: fetch it from the mirror first. A commit that is not even on
    // the mirror after that was never durable (a re-bound repo, a wiped
    // preview clone): the rows describe history nobody has, so rebuild.
    let headKnown = await commitExists(repoDir, head.sha);
    if (!headKnown) {
      await freshenForServe(workspaceId, 0).catch(() => undefined);
      headKnown = await commitExists(repoDir, head.sha);
    }
    const localSha = headKnown ? await resolveCommit(repoDir, MAIN) : null;
    if (
      headKnown &&
      localSha &&
      (await isAncestor(repoDir, localSha, head.sha))
    ) {
      const rows = await AppIndexEntry.find({ workspaceId: ws }).lean();
      return {
        sha: head.sha,
        apps: rows.map(rowToIndex),
        folders: head.folders,
      };
    }
  }

  // Retryable after a migration repairs old collisions; Model.init() retains
  // a rejected index-build promise for the lifetime of the API process.
  await AppIndexEntry.collection.createIndex({ appId: 1 }, { unique: true });
  const read = await readAppsAt(repoDir, sha);
  const existing = await AppIndexEntry.find({ workspaceId: ws }).lean();
  const incumbents = new Map<string, string>();
  for (const row of existing) incumbents.set(row.appId, row.path);
  // Existing state owns the legacy identity, even before path was backfilled.
  const projectRows = await AppProject.find({ workspaceId: ws })
    .select("_id path slug title description access owner_id")
    .lean();
  for (const p of projectRows) {
    const id = p._id.toString();
    incumbents.set(id, p.path ?? `${APPS_DIR}/${p.slug}`);
  }
  const candidateIds = [
    ...new Set([
      ...incumbents.keys(),
      ...read.apps.flatMap(app => {
        const declaredId = read.manifests.get(app.path)?.id;
        return [
          derivedAppId(workspaceId, appKeyOf(app.path)).toHexString(),
          ...(declaredId ? [declaredId] : []),
        ];
      }),
    ]),
  ];
  const [foreignProjects, foreignEntries] = await Promise.all([
    AppProject.find({ workspaceId: { $ne: ws }, _id: { $in: candidateIds } })
      .select("_id")
      .lean(),
    AppIndexEntry.find({
      workspaceId: { $ne: ws },
      appId: { $in: candidateIds },
    })
      .select("appId")
      .lean(),
  ]);
  const unavailableIds = new Set([
    ...foreignProjects.map(p => p._id.toString()),
    ...foreignEntries.map(p => p.appId),
  ]);
  const ids = assignAppIds(
    workspaceId,
    read.apps.map(a => ({
      path: a.path,
      declaredId: read.manifests.get(a.path)?.id,
      treeOid: a.treeOid,
    })),
    incumbents,
    unavailableIds,
    treeIncumbentsOf(existing, new Set(read.apps.map(a => a.path))),
    head?.sha ? await renamedAppFolders(repoDir, head.sha, sha) : new Map(),
  );

  const rows: AppIndexRow[] = read.apps.map(app => {
    const manifest = read.manifests.get(app.path)!;
    const identity = ids.get(app.path)!;
    return {
      appId: identity.appId,
      path: app.path,
      slug: app.slug,
      scope: app.scope,
      ownerId: app.ownerId,
      treeOid: app.treeOid,
      title: manifest.title,
      description: manifest.description,
      hasManifestId: identity.hasManifestId,
      duplicateOf: identity.duplicateOf,
      aliases: manifest.aliases,
      schedules: read.schedules.get(app.path) ?? [],
    };
  });
  for (const app of read.apps) {
    const rejected = read.manifests.get(app.path)?.rejectedAliases ?? [];
    if (rejected.length > 0) {
      logger.warn("Ignoring malformed app aliases in mako.json", {
        workspaceId,
        sha,
        path: app.path,
        rejected: rejected.map(r => JSON.stringify(r) ?? String(r)),
      });
    }
  }

  // Previous names the manifests do NOT say, which the index keeps on its
  // own so a renamed app's old links work however it was renamed:
  //  - a folder that moved since the last sync without its manifest saying
  //    so (a laptop `git mv`, pushed as-is): the old slug and path, by the
  //    same rule a UI move writes into the manifest (aliasesForMoves);
  //  - renames of the manifest in git history — all of it on a (re)build,
  //    which is how an app renamed BEFORE aliases existed gets its old
  //    links back, and only the new commits on an incremental sync;
  //  - what the row already knew, carried over.
  // Each row's `aliases` is then the union with its manifest's.
  const existingById = new Map(existing.map(row => [row.appId, row]));
  const projectById = new Map(projectRows.map(p => [p._id.toString(), p]));
  const previousPathOf = (appId: string): string | undefined =>
    existingById.get(appId)?.path ?? projectById.get(appId)?.path ?? undefined;
  const laptopMoves = rows.flatMap(row => {
    const from = previousPathOf(row.appId);
    return from && from !== row.path ? [{ from, to: row.path }] : [];
  });
  const movePlans = aliasesForMoves(
    rows.map(row => {
      const from = previousPathOf(row.appId);
      return from && from !== row.path
        ? { ...row, path: from, slug: from.split("/").pop() ?? from }
        : row;
    }),
    laptopMoves,
  );
  const fullScan =
    !head ||
    head.schemaVersion !== INDEX_SCHEMA_VERSION ||
    !!options.force ||
    !(await commitExists(repoDir, head.sha));
  const history = aliasesFromHistory(
    rows,
    await manifestRenamesInHistory(
      repoDir,
      fullScan ? sha : `${head.sha}..${sha}`,
    ),
  );
  const indexAliasesByPath = new Map<string, string[]>();
  for (const row of rows) {
    const from = previousPathOf(row.appId);
    const learned = mergeAliases(
      [
        (from && movePlans.get(from)?.add) || [],
        history.get(row.path) ?? [],
        existingById.get(row.appId)?.indexAliases ?? [],
      ],
      [row.slug, row.path, ...row.aliases],
    );
    indexAliasesByPath.set(row.path, learned);
    row.aliases = mergeAliases([row.aliases, learned]);
  }

  // Rows whose id or path no longer exists go first, so the unique indexes
  // never see a path or id claimed twice mid-write.
  const keepIds = new Set(rows.map(r => r.appId));
  const pathOwner = new Map(rows.map(r => [r.path, r.appId]));
  const stale = existing.filter(
    row => !keepIds.has(row.appId) || pathOwner.get(row.path) !== row.appId,
  );
  if (stale.length > 0) {
    await AppIndexEntry.deleteMany({
      _id: { $in: stale.map(r => r._id) },
    });
  }
  if (rows.length > 0) {
    await AppIndexEntry.bulkWrite(
      rows.map(row => ({
        updateOne: {
          filter: { workspaceId: ws, appId: row.appId },
          update: {
            $set: {
              path: row.path,
              slug: row.slug,
              scope: row.scope,
              ownerId: row.ownerId ?? null,
              treeOid: row.treeOid,
              title: row.title,
              description: row.description ?? null,
              hasManifestId: row.hasManifestId,
              duplicateOf: row.duplicateOf ?? null,
              aliases: read.manifests.get(row.path)?.aliases ?? [],
              indexAliases: indexAliasesByPath.get(row.path) ?? [],
              schedules: row.schedules,
              indexedSha: sha,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  // A state row whose folder is now claimed by a DIFFERENT id (a manifest
  // stamped with another app's id landed at a legacy row's path) must give
  // the path up, or ensureProjectRow for the new id hits the unique path
  // index forever. The row keeps its state (env vars, shares) without a
  // folder; nothing deletes it.
  const orphaned = projectRows.filter(
    p =>
      !keepIds.has(p._id.toString()) &&
      p.path &&
      pathOwner.has(p.path) &&
      pathOwner.get(p.path) !== p._id.toString(),
  );
  if (orphaned.length > 0) {
    await AppProject.updateMany(
      { _id: { $in: orphaned.map(p => p._id) }, workspaceId: ws },
      { $unset: { path: 1 } },
    );
  }

  // Project rows follow the folder: a move in git relocates the app's state
  // row too, so appRootFor() keeps pointing at the right directory.
  const moves = rows.filter(row => {
    const p = projectById.get(row.appId);
    return (
      p && (p.path !== row.path || p.slug !== row.slug || p.title !== row.title)
    );
  });
  if (moves.length > 0) {
    // Two phases, like the index write above: two apps that swapped folders
    // in one commit would each collide with the other's old path under the
    // unique (workspaceId, path) index if set in place. The index is sparse,
    // so rows without a path are free to take any.
    const pathMoves = moves.filter(row => {
      const p = projectById.get(row.appId);
      return p?.path !== row.path;
    });
    if (pathMoves.length > 0) {
      await AppProject.updateMany(
        {
          _id: { $in: pathMoves.map(row => new Types.ObjectId(row.appId)) },
          workspaceId: ws,
        },
        { $unset: { path: 1 } },
      );
    }
    await AppProject.bulkWrite(
      moves.map(row => {
        const p = projectById.get(row.appId);
        const location = parseAppRepoPath(row.path);
        const wasPrivate = parseAppRepoPath(p?.path ?? "")?.scope === "private";
        // Visibility follows the tree: an app filed into someone's personal
        // tree is theirs (private, owner = the tree's owner); one filed back
        // into the workspace tree is workspace content again.
        const access =
          location?.scope === "private"
            ? { access: "private", owner_id: location.ownerId }
            : wasPrivate
              ? { access: "workspace" }
              : {};
        return {
          updateOne: {
            filter: { _id: new Types.ObjectId(row.appId), workspaceId: ws },
            update: {
              $set: {
                path: row.path,
                slug: row.slug,
                title: row.title,
                ...access,
              },
            },
          },
        };
      }),
      { ordered: false },
    );
  }

  await AppIndexHead.updateOne(
    { workspaceId: ws },
    {
      $set: { sha, schemaVersion: INDEX_SCHEMA_VERSION, folders: read.folders },
    },
    { upsert: true },
  );
  const snapshot: AppsIndexSnapshot = {
    sha,
    apps: rows,
    folders: read.folders,
  };
  snapshotCache.set(workspaceId, snapshot);
  const duplicates = rows.filter(r => r.duplicateOf).length;
  logger.info("Apps index synced from repo", {
    workspaceId,
    sha,
    apps: rows.length,
    folders: read.folders.length,
    moved: moves.length,
    removed: stale.length,
    duplicates,
  });
  return snapshot;
}

/**
 * The index as of main's current commit. One throttled mirror fetch (shared
 * with every other reader), one rev-parse, and a sync only when main moved
 * since the last one — so the common read is a memo hit.
 */
export async function loadAppsIndex(
  workspaceId: string,
  options: { freshen?: boolean } = {},
): Promise<AppsIndexSnapshot> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return EMPTY;
  if (options.freshen !== false) await freshenForServe(workspaceId);
  const sha = await resolveCommit(repoDir, MAIN);
  if (!sha) return EMPTY;
  const cached = snapshotCache.get(workspaceId);
  if (cached?.sha === sha) return cached;
  return (await syncAppsIndexFromRepo(workspaceId)) ?? EMPTY;
}

/** Forget the memo (tests, and after a lifecycle commit on this instance). */
export function invalidateAppsIndexCache(workspaceId?: string): void {
  if (workspaceId) snapshotCache.delete(workspaceId);
  else snapshotCache.clear();
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Find an app by whatever a caller has: its id, its repo path (`apps/x/y`,
 * with or without a leading `apps/`), or its slug. A slug that several apps
 * share resolves to the top-level `apps/<slug>` if there is one, otherwise
 * to nothing — an ambiguous name must not silently pick a folder.
 *
 * Only when none of that matches are `aliases` (previous slugs or paths of a
 * moved app) consulted, so an alias can never shadow a live app's current
 * slug or path. An alias matches a ref equal to it, or equal to it with or
 * without the leading `apps/` (a bare-slug alias `x` answers `apps/x`, a
 * path alias `apps/S/x` answers `S/x`). It resolves only when exactly ONE
 * app claims it — two apps that both once used a name get neither.
 *
 * Mirrored by `resolveAppRef` in app/src/lib/apps-explorer-tree.ts; keep the
 * two in step.
 */
export function findAppInSnapshot(
  snapshot: AppsIndexSnapshot,
  ref: string,
): AppIndexRow | null {
  return findAppInSnapshotVia(snapshot, ref)?.app ?? null;
}

/**
 * {@link findAppInSnapshot}, saying HOW the ref matched: `current` (id,
 * path or slug as the app is today) or `alias` (a previous name) — what a
 * link resolver needs to know whether to rewrite the link.
 */
export function findAppInSnapshotVia(
  snapshot: AppsIndexSnapshot,
  ref: string,
): { app: AppIndexRow; via: "current" | "alias" } | null {
  const clean = ref.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return null;
  const current = findCurrent(snapshot.apps, clean);
  if (current) return { app: current, via: "current" };
  const alias = findByAlias(snapshot.apps, clean);
  return alias ? { app: alias, via: "alias" } : null;
}

function findCurrent(
  apps: readonly AppIndexRow[],
  clean: string,
): AppIndexRow | null {
  if (isAppId(clean)) {
    const byId = apps.find(a => a.appId === clean.toLowerCase());
    if (byId) return byId;
  }
  if (clean.includes("/")) {
    return (
      apps.find(a => a.path === clean) ??
      apps.find(a => a.path === `${APPS_DIR}/${clean}`) ??
      null
    );
  }
  const matches = apps.filter(a => a.slug === clean);
  if (matches.length === 1) return matches[0];
  return matches.find(a => a.path === `${APPS_DIR}/${clean}`) ?? null;
}

/** Does `alias` name the (already cleaned) ref? */
export function aliasMatchesRef(alias: string, clean: string): boolean {
  return (
    alias === clean ||
    alias === `${APPS_DIR}/${clean}` ||
    `${APPS_DIR}/${alias}` === clean
  );
}

function findByAlias(
  apps: readonly AppIndexRow[],
  clean: string,
): AppIndexRow | null {
  const claimants = apps.filter(a =>
    (a.aliases ?? []).some(alias => aliasMatchesRef(alias, clean)),
  );
  return claimants.length === 1 ? claimants[0] : null;
}

/**
 * The aliases a move must record, per moved app (keyed by its OLD path):
 * the old folder name when it changes, plus the old path when the name
 * alone would not lead back to the app afterwards — because the app was
 * nested or personal (`apps/Sales/x`, where the slug never was the link),
 * or because another app owns or claims that name now. Never the app's new
 * slug or path. Pure: the caller writes the result into each manifest in
 * the same commit as the move.
 */
export function aliasesForMoves(
  apps: readonly AppIndexRow[],
  moves: ReadonlyArray<{ from: string; to: string }>,
): Map<string, { newPath: string; add: string[]; drop: string[] }> {
  const isWithin = (candidate: string, root: string) =>
    candidate === root || candidate.startsWith(`${root}/`);
  const planned = new Map<
    string,
    { newPath: string; newSlug: string; oldSlug: string; add: string[] }
  >();
  for (const app of apps) {
    const move = moves.find(m => isWithin(app.path, m.from));
    if (!move) continue;
    const newPath = `${move.to}${app.path.slice(move.from.length)}`;
    if (newPath === app.path) continue;
    const newSlug = newPath.split("/").pop() ?? newPath;
    planned.set(app.path, {
      newPath,
      newSlug,
      oldSlug: app.slug,
      add: app.slug !== newSlug ? [app.slug] : [],
    });
  }
  // The world after the commit, with the old names recorded: does the old
  // name alone still find each app?
  const after: AppIndexRow[] = apps.map(app => {
    const plan = planned.get(app.path);
    if (!plan) return app;
    return {
      ...app,
      path: plan.newPath,
      slug: plan.newSlug,
      aliases: [...(app.aliases ?? []), ...plan.add],
    };
  });
  const result = new Map<
    string,
    { newPath: string; add: string[]; drop: string[] }
  >();
  for (const app of apps) {
    const plan = planned.get(app.path);
    if (!plan) continue;
    const found = findAppInSnapshot(
      { sha: "", apps: after, folders: [] },
      plan.oldSlug,
    );
    const add =
      found?.appId === app.appId && app.path === `${APPS_DIR}/${plan.oldSlug}`
        ? plan.add
        : [...plan.add, app.path];
    result.set(app.path, {
      newPath: plan.newPath,
      add,
      drop: [plan.newSlug, plan.newPath],
    });
  }
  return result;
}

/**
 * Resolve a ref against the index, fetching the mirror once on a miss when
 * asked: the read-after-push contract for every app_* tool — a folder pushed
 * a moment ago to another API instance resolves here on the first call.
 */
export async function resolveAppRef(
  workspaceId: string,
  ref: string,
  options: { fetchOnMiss?: boolean } = {},
): Promise<AppIndexRow | null> {
  let found = findAppInSnapshot(await loadAppsIndex(workspaceId), ref);
  if (!found && options.fetchOnMiss) {
    await freshenForServe(workspaceId, 0);
    found = findAppInSnapshot(
      await loadAppsIndex(workspaceId, { freshen: false }),
      ref,
    );
  }
  return found;
}

/** Resolve historical folders using the same identities as the current index. */
export async function readIndexedAppsAt(
  workspaceId: string,
  repoDir: string,
  sha: string,
): Promise<Array<{ appId: string; path: string; treeOid: string }>> {
  const [read, now, projects] = await Promise.all([
    readAppsAt(repoDir, sha),
    loadAppsIndex(workspaceId),
    AppProject.find({ workspaceId }).select("_id path slug").lean(),
  ]);
  const incumbents = new Map(now.apps.map(a => [a.appId, a.path]));
  for (const p of projects) {
    incumbents.set(p._id.toString(), p.path ?? `apps/${p.slug}`);
  }
  // Copies keep the derived identity assigned by the current index.
  const ids = assignAppIds(
    workspaceId,
    read.apps.map(a => ({
      path: a.path,
      declaredId:
        now.apps.find(
          n =>
            n.path === a.path &&
            n.duplicateOf === read.manifests.get(a.path)?.id,
        )?.appId ?? read.manifests.get(a.path)?.id,
      treeOid: a.treeOid,
    })),
    incumbents,
    new Set(),
    // An unstamped app the current index files elsewhere: at this older
    // commit its folder sat at the old path with the same tree oid.
    treeIncumbentsOf(now.apps, new Set(read.apps.map(a => a.path))),
    // …or under a name git recognises as the old one of a current folder.
    new Map(
      [...(await renamedAppFolders(repoDir, sha, now.sha))].map(
        ([newPath, oldPath]) => [oldPath, newPath],
      ),
    ),
  );
  return read.apps.map(a => ({
    appId: ids.get(a.path)!.appId,
    path: a.path,
    treeOid: a.treeOid,
  }));
}
