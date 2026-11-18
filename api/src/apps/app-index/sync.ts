/**
 * Syncing the index rows from the tree at main (once per push, serialized
 * per workspace), the per-process memo, and the authors of each app.
 */
import { Types } from "mongoose";
import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
  type IAppIndexEntry,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { freshenForServe } from "../cloud-repo.service";
import { runGit } from "../git";
import { timed } from "../../middleware/server-timing";
import { resolveCommit } from "../repository.service";
import { boundRepoDirIfExists } from "../workspace-repo-required";
import { createSerializer } from "../serialized";
import { scheduleThumbnailWarm } from "../thumbnail-variants.service";
import { scheduleAppEmbeddings } from "../app-embeddings.service";
import { loadOwnerDirectory } from "../user-handles.service";
import {
  APPS_DIR,
  appKeyOf,
  derivedAppId,
  parseAppRepoPath,
} from "../app-paths";
import {
  MAIN,
  INDEX_SCHEMA_VERSION,
  AppIndexRow,
  AppsIndexSnapshot,
  EMPTY,
  withOwners,
} from "./rows";
import { readAppsAt } from "./discovery";
import {
  assignAppIds,
  treeIncumbentsOf,
  renamedAppFolders,
  commitExists,
  isAncestor,
} from "./identity";

const logger = loggers.api("apps-index");

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

const serialized = createSerializer();

/** Per-process memo: the rows cannot change while main's sha does not. */
const snapshotCache = new Map<string, AppsIndexSnapshot>();

export function rowToIndex(
  row: Pick<IAppIndexEntry, keyof AppIndexRow>,
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
    schedules: (row.schedules ?? []).map(s => ({
      binding: s.binding,
      cron: s.cron,
      ...(s.timezone ? { timezone: s.timezone } : {}),
    })),
    tables: row.tables ?? [],
    bindingTables: (row.bindingTables ?? []).map(b => ({
      binding: b.binding,
      tables: [...(b.tables ?? [])],
    })),
    bindings: row.bindings ?? [],
    authorEmail: row.authorEmail ?? undefined,
    firstCommitAt: row.firstCommitAt
      ? new Date(row.firstCommitAt).toISOString()
      : undefined,
    thumbnail: row.thumbnail
      ? { file: row.thumbnail.file, oid: row.thumbnail.oid }
      : undefined,
    icon: row.icon ? { file: row.icon.file, oid: row.icon.oid } : undefined,
  };
}

/**
 * Platform identities that commit on people's behalf (the box agent's
 * fallback, GitHub apps): never an app's author. A person's GitHub noreply
 * address (`123+name@users.noreply.github.com`) is a person and stays.
 */
export function isBotCommitter(email: string): boolean {
  const e = email.toLowerCase();
  const local = e.split("@")[0];
  return PLATFORM_LOCAL_PARTS.has(local) || e.includes("[bot]");
}

/** Local parts Mako and git hosts commit as (`bot@mako.ai`, `session@mako.ai`). */
const PLATFORM_LOCAL_PARTS = new Set([
  "bot",
  "session",
  "publish",
  "noreply",
  "no-reply",
]);

/**
 * When each app folder first appeared, and who made it, by app path: one
 * `git log` limited to the folders the index has not dated yet (new apps),
 * newest first — so the last commit seen for a folder is its oldest. The
 * author is the oldest HUMAN author: the commit that put a folder at its
 * path is often a platform one (an import, a reorganisation, bot@mako.ai),
 * while the person who built the app is the first to edit it. A move starts
 * a folder's history over at the new path, which is why a row that already
 * has a date keeps it — the identity follows the app, and so does its age.
 * Best effort: a failure leaves the rows undated.
 */
export async function firstCommitsOf(
  repoDir: string,
  sha: string,
  paths: ReadonlySet<string>,
): Promise<Map<string, { email?: string; at: string }>> {
  const out = new Map<string, { email?: string; at: string }>();
  if (paths.size === 0) return out;
  let stdout: string;
  try {
    ({ stdout } = await runGit(
      [
        "-C",
        repoDir,
        "log",
        "--no-renames",
        "--name-only",
        "-z",
        "--format=%x01%ae%x00%aI",
        sha,
        "--",
        ...[...paths].map(p => `:(literal)${p}`),
      ],
      { timeoutMs: 60_000, maxBufferBytes: 128 * 1024 * 1024 },
    ));
  } catch (error) {
    logger.warn("Apps index: could not date apps from history", {
      error: error instanceof Error ? error.message : String(error),
    });
    return out;
  }
  const appOf = (file: string): string | null => {
    for (
      let i = file.lastIndexOf("/");
      i > 0;
      i = file.lastIndexOf("/", i - 1)
    ) {
      const dir = file.slice(0, i);
      if (paths.has(dir)) return dir;
    }
    return null;
  };
  for (const commit of stdout.split("\x01")) {
    const [email, rawAt, ...files] = commit.split("\0").map(s => s.trim());
    const ms = Date.parse(rawAt ?? "");
    if (!email || !Number.isFinite(ms)) continue;
    const at = new Date(ms).toISOString();
    const human = !isBotCommitter(email);
    const seen = new Set<string>();
    for (const file of files) {
      const dir = file ? appOf(file) : null;
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      out.set(dir, { email: human ? email : out.get(dir)?.email, at });
    }
  }
  return out;
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
      if (!(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === 11000
      )) {
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
  let sha = await resolveCommit(repoDir, MAIN);
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

  // A schema bump rebuilds the rows, and must not rebuild them BACKWARDS
  // either: while old and new revisions run side by side, an instance on
  // the new schema whose clone is behind the indexed commit rebuilds AT the
  // indexed commit, not at its own stale main.
  if (
    head &&
    head.schemaVersion !== INDEX_SCHEMA_VERSION &&
    !options.force &&
    head.sha !== sha
  ) {
    let headKnown = await commitExists(repoDir, head.sha);
    if (!headKnown) {
      await freshenForServe(workspaceId, 0).catch(() => undefined);
      headKnown = await commitExists(repoDir, head.sha);
      sha = (await resolveCommit(repoDir, MAIN)) ?? sha;
    }
    if (headKnown && (await isAncestor(repoDir, sha, head.sha))) {
      sha = head.sha;
    }
  }

  // Retryable after a migration repairs old collisions; Model.init() retains
  // a rejected index-build promise for the lifetime of the API process.
  await AppIndexEntry.collection.createIndex({ appId: 1 }, { unique: true });
  const read = await readAppsAt(repoDir, sha);
  const directory = await loadOwnerDirectory(workspaceId);
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

  // Author + creation date: kept from the row when it has them (a move must
  // not make an app "new"), read from history only for the rest.
  const datedById = new Map(
    existing
      // A bot author on a dated row is an older reading of history: redo it.
      .filter(
        r =>
          r.firstCommitAt && !(r.authorEmail && isBotCommitter(r.authorEmail)),
      )
      .map(r => [
        r.appId,
        {
          email: r.authorEmail ?? "",
          at: new Date(r.firstCommitAt as Date).toISOString(),
        },
      ]),
  );
  const undated = new Set(
    read.apps
      .filter(a => !datedById.has(ids.get(a.path)?.appId ?? ""))
      .map(a => a.path),
  );
  const firstCommits = await firstCommitsOf(repoDir, sha, undated);

  const rows: AppIndexRow[] = read.apps.map(app => {
    const manifest = read.manifests.get(app.path)!;
    const identity = ids.get(app.path)!;
    const first = datedById.get(identity.appId) ?? firstCommits.get(app.path);
    return {
      appId: identity.appId,
      path: app.path,
      slug: app.slug,
      scope: app.scope,
      ownerId:
        app.scope === "private"
          ? (directory.ownerOf(app.ownerHandle) ?? undefined)
          : undefined,
      treeOid: app.treeOid,
      title: manifest.title,
      description: manifest.description,
      hasManifestId: identity.hasManifestId,
      duplicateOf: identity.duplicateOf,
      schedules: read.schedules.get(app.path) ?? [],
      tables: read.tables.get(app.path) ?? [],
      bindingTables: read.bindingTables.get(app.path) ?? [],
      bindings: [...app.bindingBlobs.keys()].sort(),
      authorEmail: first?.email || undefined,
      firstCommitAt: first?.at,
      thumbnail: app.thumbnail,
      icon: app.icon,
    };
  });

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
              schedules: row.schedules,
              tables: row.tables,
              bindingTables: row.bindingTables ?? [],
              bindings: row.bindings,
              authorEmail: row.authorEmail ?? null,
              firstCommitAt: row.firstCommitAt
                ? new Date(row.firstCommitAt)
                : null,
              thumbnail: row.thumbnail ?? null,
              icon: row.icon ?? null,
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
  const projectById = new Map(projectRows.map(p => [p._id.toString(), p]));
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
        // tree is theirs (private, owner = the tree's owner by the handle
        // mapping); one filed back into the workspace tree is workspace
        // content again. A folder whose handle is nobody's stays private to
        // nobody — its name must not make it someone's.
        const access =
          location?.scope === "private"
            ? { access: "private", owner_id: row.ownerId ?? null }
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
  const repoDir = await timed("index.repo", () =>
    boundRepoDirIfExists(workspaceId),
  );
  if (repoDir == null) return EMPTY;
  if (options.freshen !== false) {
    await timed("index.freshen", () => freshenForServe(workspaceId));
  }
  const sha = await timed("index.revParse", () => resolveCommit(repoDir, MAIN));
  if (!sha) return EMPTY;
  const directory = await timed("index.owners", () =>
    loadOwnerDirectory(workspaceId),
  );
  const cached = snapshotCache.get(workspaceId);
  if (cached?.sha === sha) return withOwners(cached, directory);
  const synced = await timed("index.sync", () =>
    syncAppsIndexFromRepo(workspaceId),
  );
  // Main moved (or this instance just started): make sure the posters'
  // card and link-preview variants are in the shared store before the
  // first crawler or Apps home asks. Once per sha (Inngest does the work).
  if (synced) scheduleThumbnailWarm(workspaceId, synced);
  // Semantic search: re-embed apps whose content changed, in the
  // background — never part of this read (app-embeddings.service).
  if (synced) scheduleAppEmbeddings(workspaceId, synced);
  return synced ? withOwners(synced, directory) : EMPTY;
}

/**
 * The commit this instance's index memo describes, without touching git —
 * how a memo built on the index (app-home-base.service) notices that main
 * moved here since, for free. Undefined when nothing is memoized.
 */
export function peekAppsIndexSha(workspaceId: string): string | undefined {
  return snapshotCache.get(workspaceId)?.sha;
}

/** Forget the memo (tests, and after a lifecycle commit on this instance). */
export function invalidateAppsIndexCache(workspaceId?: string): void {
  if (workspaceId) snapshotCache.delete(workspaceId);
  else snapshotCache.clear();
}
