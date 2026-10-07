/**
 * Consoles in the workspace repo — git is the source of truth, Mongo's
 * `SavedConsole` is the derived index (apps.md §16).
 *
 * Three responsibilities, one file so the invariants stay in view:
 *
 * 1. WRITE-THROUGH. Every saved-console mutation commits to `main` first
 *    (`commitConsoleState` / `commitConsoleRemoval` / `commitConsoleBatch`),
 *    then the caller updates the row with the returned `path` and
 *    `sourceBlobSha`. Index plumbing, no clone (`commitBlobsOnBranch`).
 * 2. SYNC. `syncConsolesIndexFromRepo` reconciles the index with the tree
 *    after any push (terminal, laptop clone, GitHub webhook). Content
 *    addressed: a row whose blob id equals the tree's is skipped; a vanished
 *    row whose blob reappears elsewhere is a rename, and so is one git's
 *    rename detection (`diff -M`, rename/git-renames.ts) pairs with a new
 *    path — a laptop `git mv` plus an edit in the same push keeps the row
 *    (id, telemetry, shares, schedule, embedding survive); a vanished path
 *    nothing claims soft-deletes its row. Never touches a repo that has not
 *    adopted (`consoles/README.md` absent).
 * 3. READ. GET/list serves the files at `main` (`consoles/`,
 *    `users/<id>/consoles/`). Mongo is joined only for ACL, runtime, SHA,
 *    and embeddings. A file with no row still appears; a row with no file
 *    is not a live definition. Reads never reconcile Mongo or publish
 *    realtime events — push/webhook sync owns that mutation — with ONE
 *    exception: a GET by id whose row points at a path that is no longer
 *    in the tree runs the (serialized, idempotent) sync once before
 *    answering 404, because between a push and its sync the row is stale
 *    and the console would otherwise vanish for the seconds in between. No
 *    GitHub binding → empty list, never 412. Leftover local git without a
 *    binding is not a read surface.
 * 4. DERIVATION. Description + embedding are derived from the file and
 *    stamped with `descriptionSourceSha`; `deriveConsoleDescription` runs
 *    only while that differs from `sourceBlobSha`, behind a debounced
 *    Inngest function. Search itself does not change — it keeps reading the
 *    index (§16.4).
 *
 * Adoption (`adoptWorkspaceConsoles`) replays `entity_versions` as commits
 * and writes the marker; the DB migration and the operator CLI both call it,
 * and so does the first console write on a not-yet-adopted workspace.
 *
 * Must not import worktree.service (it imports this module for the push
 * hook) — everything needed is in repository.service / cloud-repo.service.
 */
import { createHash } from "node:crypto";
import { Types } from "mongoose";
import { inngest } from "../inngest/client";
import { User } from "../database/schema";
import {
  ConsoleFolder,
  EntityVersion,
  SavedConsole,
  type ConsoleAccessLevel,
  type IEntityVersion,
  type ISavedConsole,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  generateDescriptionAndEmbedding,
  isDescriptionGenAvailable,
} from "../services/console-description.service";
import {
  embedText,
  getEmbeddingModelName,
  isEmbeddingAvailable,
} from "../services/embedding.service";
import { publishRealtimeEvent } from "../services/realtime.service";
import {
  getNextScheduledConsoleRunAt,
  validateScheduledConsoleSchedule,
} from "../services/scheduled-query-schedule.service";
import {
  freshenBeforeMainWrite,
  mirrorPushNow,
  queueMirrorPush,
  resolveMirrorTarget,
} from "./cloud-repo.service";
import { RepoRequiredError, appsRequireConnectedRepo } from "./config";
import { createSerializer } from "./serialized";
import {
  requireWorkspaceRepo,
  boundRepoDirIfExists,
} from "./workspace-repo-required";
import { detectRenamedPaths } from "../rename/git-renames";
import {
  CONSOLES_DIR,
  CONSOLES_README,
  CONSOLES_README_PATH,
  USERS_DIR,
  chartSidecarPath,
  consoleRepoPath,
  parseChartSpec,
  parseConsoleFile,
  parseConsoleRepoPath,
  serializeChartSpec,
  serializeConsoleFile,
  type ConsoleFileState,
  type ConsoleLanguage,
  type ConsoleRepoLocation,
  type ParsedConsoleFile,
} from "./console-files";
import {
  BlobPreconditionError,
  DEFAULT_BRANCH,
  blobOid,
  blobOidAt,
  caseVariantOf,
  commitBlobsOnBranch,
  diffNameStatus,
  lastDeletionCommit,
  listTree,
  log as repoLog,
  logFollow,
  readBlob,
  readBlobByOid,
  readBlobsBatch,
  resolveCommit,
  type BlobMutation,
  type ChangedFile,
  type FollowedCommit,
  type GitAuthor,
  type TreeEntry,
} from "./repository.service";
import { commitBranchFor } from "./branch-policy";
import { EMPTY_TREE } from "./git";

const logger = loggers.api("consoles-git");

const MAIN = `refs/heads/${DEFAULT_BRANCH}`;

export const CONSOLE_DESCRIPTION_EVENT = "console/description.requested";

export interface ConsoleDescriptionEventData {
  workspaceId: string;
  consoleId: string;
  /** Agent-turn context that only exists inside the turn (§16.4). */
  context?: { conversationExcerpt?: string; resultSample?: string };
  tracking?: { userId: string; userEmail?: string };
}

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

const authorCache = new Map<string, GitAuthor | undefined>();

/** Git author for a Mako user id; undefined (→ Mako) when unknown. */
export async function authorForUser(
  userId: string | undefined | null,
): Promise<GitAuthor | undefined> {
  if (!userId) return undefined;
  if (authorCache.has(userId)) return authorCache.get(userId);
  let author: GitAuthor | undefined;
  try {
    const user = await User.findById(userId)
      .select("email name")
      .lean<{ email?: string; name?: string } | null>();
    if (user?.email) {
      author = {
        name: user.name?.trim() || user.email.split("@")[0] || user.email,
        email: user.email,
      };
    }
  } catch (error) {
    if ((error as Error | null)?.name !== "CastError") return undefined;
  }
  authorCache.set(userId, author);
  return author;
}

// ---------------------------------------------------------------------------
// Folders ↔ directories
// ---------------------------------------------------------------------------

type FolderLean = {
  _id: Types.ObjectId;
  name: string;
  parentId?: Types.ObjectId | null;
};

/** The folder chain of a console as path segments, root first. */
export async function folderSegmentsFor(
  folderId: Types.ObjectId | string | undefined | null,
  workspaceId: string,
  cache: Map<string, FolderLean | null> = new Map(),
): Promise<string[]> {
  const segments: string[] = [];
  let current = folderId ? folderId.toString() : null;
  for (let depth = 0; current && depth < 32; depth++) {
    let folder = cache.get(current);
    if (folder === undefined) {
      folder = await ConsoleFolder.findOne({
        _id: new Types.ObjectId(current),
        workspaceId: new Types.ObjectId(workspaceId),
      })
        .select("name parentId")
        .lean<FolderLean | null>();
      cache.set(current, folder);
    }
    if (!folder) break;
    segments.unshift(folder.name);
    current = folder.parentId ? folder.parentId.toString() : null;
  }
  return segments;
}

/**
 * Find-or-create the folder chain for a directory. Folders are organization,
 * not authorization (§10), but a folder created under `users/<id>/consoles`
 * is that user's private folder so the tree renders where the file lives.
 *
 * The lookup is SCOPED: `users/<id>/consoles/Team` is that user's private
 * "Team", never the workspace folder of the same name (a private console
 * filed into a workspace folder is workspace-visible by inheritance — the
 * folder, not the file, would have published it), and `consoles/Team` is
 * the workspace "Team", never someone's private one.
 */
export async function ensureFolderChain(
  segments: string[],
  workspaceId: string,
  scope: { access: ConsoleAccessLevel; ownerId?: string },
): Promise<Types.ObjectId | undefined> {
  return walkFolderChain(segments, workspaceId, scope, true);
}

/**
 * The folder chain `segments` in `scope` when it already exists there —
 * `ensureFolderChain`'s scoped lookup, creating nothing. Null when any
 * link is missing (or `segments` is empty: the scope's root).
 */
export async function findFolderChain(
  segments: string[],
  workspaceId: string,
  scope: { access: ConsoleAccessLevel; ownerId?: string },
): Promise<Types.ObjectId | null> {
  if (segments.length === 0) return null;
  return (await walkFolderChain(segments, workspaceId, scope, false)) ?? null;
}

async function walkFolderChain(
  segments: string[],
  workspaceId: string,
  scope: { access: ConsoleAccessLevel; ownerId?: string },
  create: boolean,
): Promise<Types.ObjectId | undefined> {
  const ws = new Types.ObjectId(workspaceId);
  const scopeFilter =
    scope.access === "private"
      ? {
          ownerId: scope.ownerId,
          $or: [{ access: "private" }, { isPrivate: true }],
        }
      : { $nor: [{ access: "private" }, { isPrivate: true }] };
  let parentId: Types.ObjectId | undefined;
  for (const name of segments) {
    const parentFilter = parentId
      ? { parentId }
      : { $or: [{ parentId: null }, { parentId: { $exists: false } }] };
    let folder = await ConsoleFolder.findOne({
      workspaceId: ws,
      name,
      $and: [parentFilter, scopeFilter],
    })
      .select("_id")
      .lean<{ _id: Types.ObjectId } | null>();
    if (!folder && !create) return undefined;
    if (!folder) {
      const created = await ConsoleFolder.create({
        workspaceId: ws,
        name,
        parentId,
        isPrivate: scope.access === "private",
        access: scope.access,
        ownerId: scope.ownerId,
      });
      folder = { _id: created._id };
    }
    parentId = folder._id;
  }
  return parentId;
}

// ---------------------------------------------------------------------------
// Row ↔ file
// ---------------------------------------------------------------------------

type RowLike = Pick<
  ISavedConsole,
  | "name"
  | "language"
  | "code"
  | "connectionId"
  | "databaseName"
  | "databaseId"
  | "description"
  | "descriptionSource"
  | "descriptionGeneratedAt"
  | "schedule"
  | "resultsViewMode"
  | "mongoOptions"
  | "chartSpec"
  | "access"
  | "isPrivate"
  | "owner_id"
  | "createdBy"
  | "folderId"
  | "workspaceId"
>;

function rowLanguage(row: Pick<RowLike, "language">): ConsoleLanguage {
  return row.language === "javascript" || row.language === "mongodb"
    ? row.language
    : "sql";
}

/** Is this row's description authored (belongs in the file) or generated? */
export function descriptionIsAuthored(
  row: Pick<
    RowLike,
    "description" | "descriptionSource" | "descriptionGeneratedAt"
  >,
): boolean {
  if (!row.description?.trim()) return false;
  if (row.descriptionSource) return row.descriptionSource === "authored";
  // Legacy rows: a description nobody generated was typed by someone.
  return !row.descriptionGeneratedAt;
}

export function rowScope(
  row: Pick<RowLike, "access" | "isPrivate" | "owner_id" | "createdBy">,
): { scope: "workspace" | "private"; ownerId?: string } {
  const access: ConsoleAccessLevel =
    row.access ?? (row.isPrivate ? "private" : "workspace");
  if (access === "workspace") return { scope: "workspace" };
  return { scope: "private", ownerId: row.owner_id || row.createdBy };
}

/** The authored part of a row — what the file carries. */
export function fileStateFromRow(row: RowLike): ConsoleFileState {
  const state: ConsoleFileState = {
    name: row.name,
    language: rowLanguage(row),
    code: row.code ?? "",
  };
  if (row.connectionId) state.connectionId = row.connectionId.toString();
  if (row.databaseName) state.databaseName = row.databaseName;
  if (row.databaseId) state.databaseId = row.databaseId;
  if (descriptionIsAuthored(row)) state.description = row.description;
  if (row.schedule?.cron) {
    state.schedule = {
      cron: row.schedule.cron,
      timezone: row.schedule.timezone || "UTC",
    };
  }
  if (row.resultsViewMode) state.resultsViewMode = row.resultsViewMode;
  if (row.mongoOptions?.collection) {
    state.mongoOptions = {
      collection: row.mongoOptions.collection,
      operation: row.mongoOptions.operation,
    };
  }
  if (row.chartSpec && Object.keys(row.chartSpec).length > 0) {
    state.chartSpec = row.chartSpec;
  }
  return state;
}

/** Where a row lives in the repo, given its folder chain. */
export async function repoPathForRow(
  row: RowLike,
  folderCache?: Map<string, FolderLean | null>,
): Promise<string> {
  const segments = await folderSegmentsFor(
    row.folderId,
    row.workspaceId.toString(),
    folderCache,
  );
  return consoleRepoPath({
    ...rowScope(row),
    folderSegments: segments,
    name: row.name,
    language: rowLanguage(row),
  });
}

/** The file (and sidecar) a state projects to, keyed by path. */
function filesFor(
  path: string,
  state: ConsoleFileState,
): { writes: Record<string, string>; deletes: string[] } {
  const writes: Record<string, string> = {
    [path]: serializeConsoleFile(state),
  };
  const sidecar = chartSidecarPath(path);
  const deletes: string[] = [];
  if (state.chartSpec) writes[sidecar] = serializeChartSpec(state.chartSpec);
  else deletes.push(sidecar);
  return { writes, deletes };
}

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

/** The workspace bare repo, restored from its mirror or initialized. */
export async function ensureConsolesRepo(workspaceId: string): Promise<string> {
  return requireWorkspaceRepo(workspaceId);
}

async function readAt(
  repoDir: string,
  relPath: string,
): Promise<string | null> {
  try {
    const blob = await readBlob(repoDir, MAIN, relPath);
    return blob.isBinary ? null : blob.contents;
  } catch {
    return null;
  }
}

/** Whether this repo's consoles folder has been adopted (module doc). */
export async function consolesAdopted(repoDir: string): Promise<boolean> {
  return (await readAt(repoDir, CONSOLES_README_PATH)) !== null;
}

// ---------------------------------------------------------------------------
// GET/list — git is the definition, Mongo is the overlay
// ---------------------------------------------------------------------------

/**
 * Stable id for a console that exists as a file but has no index row yet
 * (same contract as `derivedAppId`: the id is a function of identity, so a
 * later sync that creates the row does not mint a second one).
 */
export function derivedConsoleId(
  workspaceId: string,
  path: string,
  /**
   * 1 is the id every git-only file has always had. A higher generation is
   * used only when that id is already held by a row at ANOTHER path — a
   * git-born console that was renamed keeps its id, so a new file later
   * pushed at its old name must not collide with it (`freeDerivedConsoleId`).
   */
  generation = 1,
): Types.ObjectId {
  const digest = createHash("sha1")
    .update(
      `consoles:${workspaceId}:${path}${generation > 1 ? `#${generation}` : ""}`,
    )
    .digest("hex");
  return new Types.ObjectId(digest.slice(0, 24));
}

/**
 * The stable id for a file with no row: the first derivation no row at a
 * different path holds (a deleted, path-less row holds it too). Read from
 * the index each time, so GET/list (which hands it out) and push-sync
 * (which creates the row under it) agree, and a tab opened before the push
 * keeps resolving after it. Same contract as the flows' `freeDerivedFlowId`.
 */
export async function freeDerivedConsoleId(
  workspaceId: string,
  path: string,
): Promise<Types.ObjectId> {
  for (let generation = 1; generation <= 32; generation++) {
    const id = derivedConsoleId(workspaceId, path, generation);
    const holder = await SavedConsole.findById(id)
      .select("path")
      .lean<{ path?: string } | null>();
    if (!holder || holder.path === path) return id;
  }
  return new Types.ObjectId();
}

export interface ConsoleDefinitionAtMain {
  path: string;
  oid: string;
  location: ConsoleRepoLocation;
  parsed: ParsedConsoleFile;
  chartSpec?: Record<string, unknown>;
}

export interface LiveConsole extends ConsoleDefinitionAtMain {
  /** Derived index row when one exists (ACL, lastRun, embeddings, id). */
  row: ISavedConsole | null;
  /** Row `_id`, or a derived id when the file has no row yet. */
  id: Types.ObjectId;
}

const consoleDefCache = new Map<
  string,
  { sha: string; defs: ConsoleDefinitionAtMain[] }
>();
const consoleDefLoads = new Map<
  string,
  { sha: string; promise: Promise<ConsoleDefinitionAtMain[]> }
>();

function isBinaryBuffer(buf: Buffer): boolean {
  return buf.includes(0);
}

/**
 * Authored console files at `main`. Empty when no GitHub repo is bound —
 * leftover local git is not a definition store (issue #956). Never throws
 * `RepoRequiredError`; a missing binding is an empty list, not 412.
 */
export async function listConsoleDefinitionsAtMain(
  workspaceId: string,
): Promise<ConsoleDefinitionAtMain[]> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return [];
  const sha = await resolveCommit(repoDir, MAIN);
  if (!sha) return [];
  const cached = consoleDefCache.get(workspaceId);
  if (cached && cached.sha === sha) return cached.defs;

  // A fresh Cloud Run replica can receive a whole workspace's explorer
  // requests before the first tree read fills the cache. Share that cold
  // load: parsing every console blob once per request is CPU-bound and can
  // exhaust the service before autoscaling catches up.
  const pending = consoleDefLoads.get(workspaceId);
  if (pending && pending.sha === sha) return pending.promise;

  const promise = loadConsoleDefinitions(repoDir, sha);
  consoleDefLoads.set(workspaceId, { sha, promise });
  try {
    const defs = await promise;
    // Do not let an older load that finished late replace a newer sha.
    if (consoleDefLoads.get(workspaceId)?.promise === promise) {
      consoleDefCache.set(workspaceId, { sha, defs });
    }
    return defs;
  } finally {
    if (consoleDefLoads.get(workspaceId)?.promise === promise) {
      consoleDefLoads.delete(workspaceId);
    }
  }
}

async function loadConsoleDefinitions(
  repoDir: string,
  sha: string,
): Promise<ConsoleDefinitionAtMain[]> {
  const entries = (await listTree(repoDir, sha)).filter(e =>
    parseConsoleRepoPath(e.path),
  );
  const sidecarPaths = entries.map(e => {
    try {
      return chartSidecarPath(e.path);
    } catch {
      return null;
    }
  });
  const toRead = [
    ...entries.map(e => e.path),
    ...sidecarPaths.filter((p): p is string => Boolean(p)),
  ];
  const blobs = await readBlobsBatch(repoDir, sha, toRead);

  const defs: ConsoleDefinitionAtMain[] = [];
  for (const entry of entries) {
    const location = parseConsoleRepoPath(entry.path);
    if (!location) continue;
    const buf = blobs.get(entry.path);
    if (!buf || isBinaryBuffer(buf)) continue;
    const parsed = parseConsoleFile(buf.toString("utf8"), location.language);
    const sidecarPath = chartSidecarPath(entry.path);
    const sidecarBuf = blobs.get(sidecarPath);
    const chartSpec =
      sidecarBuf && !isBinaryBuffer(sidecarBuf)
        ? parseChartSpec(sidecarBuf.toString("utf8"))
        : undefined;
    defs.push({
      path: entry.path,
      oid: entry.oid,
      location,
      parsed,
      chartSpec,
    });
  }

  return defs;
}

export async function readConsoleDefinitionAtMain(
  workspaceId: string,
  path: string,
): Promise<ConsoleDefinitionAtMain | null> {
  const defs = await listConsoleDefinitionsAtMain(workspaceId);
  return defs.find(d => d.path === path) ?? null;
}

async function savedIndexRows(workspaceId: string): Promise<ISavedConsole[]> {
  return SavedConsole.find({
    workspaceId: new Types.ObjectId(workspaceId),
    isSaved: true,
  });
}

async function joinLiveConsoles(
  workspaceId: string,
  defs: ConsoleDefinitionAtMain[],
  rows: ISavedConsole[],
): Promise<LiveConsole[]> {
  const byPath = new Map<string, ISavedConsole>();
  for (const row of rows) {
    if (row.path && !row.is_deleted) byPath.set(row.path, row);
  }
  const out: LiveConsole[] = [];
  for (const def of defs) {
    const row = byPath.get(def.path) ?? null;
    out.push({
      ...def,
      row,
      id: row?._id ?? (await freeDerivedConsoleId(workspaceId, def.path)),
    });
  }
  return out;
}

/**
 * Live saved consoles: files at main, overlaying the Mongo index.
 *
 * Unbound workspace → `[]` (leftover Mongo rows and leftover local git do
 * not populate the list). Git-only files appear; Mongo-only rows do not.
 * This is deliberately a pure read: reconciliation belongs to the push and
 * webhook paths, never a request that can be fanned out by realtime clients.
 */
export async function loadLiveConsoles(
  workspaceId: string,
): Promise<LiveConsole[]> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return [];
  const [defs, rows] = await Promise.all([
    listConsoleDefinitionsAtMain(workspaceId),
    savedIndexRows(workspaceId),
  ]);
  return joinLiveConsoles(workspaceId, defs, rows);
}

/**
 * Resolve a console id for GET. Drafts stay on the Mongo working copy;
 * saved consoles are live only when the file exists at main.
 */
/**
 * The code to EXECUTE for a console: the file at main when the console is
 * live there, else null (draft, unbound workspace, file gone). Every runner
 * — the execute route, the scheduled executor, the agent's load — used to
 * run `SavedConsole.code`, i.e. the last push, so a query edited in git ran
 * stale until the webhook landed.
 */
export async function liveConsoleCode(
  workspaceId: string,
  consoleId: string,
): Promise<{ code: string; language: ConsoleLanguage; path: string } | null> {
  const hit = await loadLiveConsoleById(workspaceId, consoleId);
  if (!hit || !("live" in hit)) return null;
  return {
    code: hit.live.parsed.code,
    language: hit.live.location.language,
    path: hit.live.path,
  };
}

export async function loadLiveConsoleById(
  workspaceId: string,
  consoleId: string,
): Promise<{ draft: ISavedConsole } | { live: LiveConsole } | null> {
  if (!Types.ObjectId.isValid(consoleId)) return null;
  const row = await SavedConsole.findOne({
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (row && row.isSaved === false) return { draft: row };

  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return null;

  if (row?.path) {
    const def = await readConsoleDefinitionAtMain(workspaceId, row.path);
    if (def) return { live: { ...def, row, id: row._id } };
    // A soft-deleted row is the settled answer of an earlier sync: its file
    // is gone and no heal would bring it back. Every reader of a deleted
    // console (GET, execute, the scheduler, the agent) lands here, so this
    // must stay a plain miss.
    if (row.is_deleted) return null;
    // The row's path is not in the tree: a push moved (or removed) the file
    // and its sync has not landed yet — or lost the race with this read.
    // Reconcile once (joining the push's own sync when one is queued, a
    // no-op when it already ran) and answer from the healed row, so a
    // console renamed from a laptop never 404s for the window between push
    // and sync.
    return healedLiveConsole(workspaceId, consoleId, row.path, repoDir);
  }

  const live = await loadLiveConsoles(workspaceId);
  const match = live.find(item => item.id.toString() === consoleId);
  return match ? { live: match } : null;
}

/**
 * The index row of a console addressed by its id — indexing it first when
 * the id is the one a file at main with no row yet is listed under (its
 * derived id: pushed, not synced — the tree hands that id out). Every
 * route that acts on a console by id (rename, move, delete, duplicate,
 * sharing, a draft autosave) loads through this, so a git-only console is
 * the same console everywhere: a rename from the tree does not 404, and a
 * draft typed into it is never a second row holding its id while the file
 * is re-listed under another.
 *
 * The on-demand sync runs WITHOUT an actor (as `findRow` in the rename
 * handler does): indexing makes nobody the owner of a pushed file. Null
 * when there is no row and no such file — or a file the index cannot hold
 * (a folder no record can be named after), which stays read-only.
 */
export async function consoleRowForId(
  workspaceId: string,
  consoleId: string,
): Promise<ISavedConsole | null> {
  if (!Types.ObjectId.isValid(consoleId)) return null;
  const ws = new Types.ObjectId(workspaceId);
  const id = new Types.ObjectId(consoleId);
  const row = await SavedConsole.findOne({ _id: id, workspaceId: ws });
  if (row) return row;
  const live = (await loadLiveConsoles(workspaceId)).find(
    item => !item.row && item.id.equals(id),
  );
  if (!live) return null;
  await syncConsolesIndexFromRepo(workspaceId);
  return SavedConsole.findOne({
    _id: id,
    workspaceId: ws,
    path: live.path,
    is_deleted: { $ne: true },
  });
}

/**
 * `${workspaceId}:${consoleId}` → the main sha a heal already found
 * nothing at. A row that stays stale (the deletion pass soft-deletes it on
 * the next sync, but a sync that found nothing to do leaves it) must not
 * cost a sync per read; the next push moves main and clears the entry.
 */
const healMisses = new Map<string, string>();
const HEAL_MISSES_MAX = 2_000;

/** Remember a miss; the oldest entries go first once the map is full. */
function rememberHealMiss(key: string, head: string): void {
  healMisses.delete(key);
  healMisses.set(key, head);
  while (healMisses.size > HEAL_MISSES_MAX) {
    const oldest = healMisses.keys().next().value;
    if (oldest === undefined) break;
    healMisses.delete(oldest);
  }
}

async function healedLiveConsole(
  workspaceId: string,
  consoleId: string,
  stalePath: string,
  repoDir: string,
): Promise<{ draft: ISavedConsole } | { live: LiveConsole } | null> {
  const missKey = `${workspaceId}:${consoleId}`;
  const head = await resolveCommit(repoDir, MAIN);
  if (head && healMisses.get(missKey) === head) return null;
  try {
    await joinConsoleIndexSync(workspaceId);
  } catch (error) {
    logger.warn("Console index heal on a stale path failed", {
      workspaceId,
      consoleId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  const row = await SavedConsole.findOne({
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  // Still at the stale path, or gone: the file really was deleted.
  if (!row?.path || row.path === stalePath || row.is_deleted) {
    if (head) rememberHealMiss(missKey, head);
    return null;
  }
  const def = await readConsoleDefinitionAtMain(workspaceId, row.path);
  return def ? { live: { ...def, row, id: row._id } } : null;
}

// ---------------------------------------------------------------------------
// Write-through
// ---------------------------------------------------------------------------

export interface ConsoleCommitResult {
  commitOid: string;
  unchanged: boolean;
}

/**
 * Commit an arbitrary console mutation (writes and deletes, already in
 * file form) onto main, adopting the workspace first when it has not been.
 * Queues the mirror push; the caller updates Mongo afterwards.
 */
export async function commitConsoleBatch(input: {
  workspaceId: string;
  actorUserId?: string | null;
  mutation: BlobMutation;
  message: string;
  /** Skip adoption — used by adoption itself. */
  skipAdoption?: boolean;
  /**
   * Compare-and-swap on content (see commitBlobsOnBranch): path → the blob
   * oid the caller read at main, `null` = must be absent. A relocation
   * decided from a file that moved or changed since, or whose target
   * appeared, is refused (`BlobPreconditionError`), never re-applied.
   */
  expectBlobs?: Record<string, string | null>;
  /** The caller already ran `freshMain` for this write; do not fetch twice. */
  alreadyFresh?: boolean;
}): Promise<ConsoleCommitResult> {
  const repoDir = input.alreadyFresh
    ? await requireWorkspaceRepo(input.workspaceId)
    : await freshMain(input.workspaceId);
  if (!input.skipAdoption && !(await consolesAdopted(repoDir))) {
    // First console write on a workspace that never adopted: bring every
    // saved console in (snapshot; the CLI replays history).
    await adoptWorkspaceConsoles(input.workspaceId, {
      replayHistory: false,
      actorUserId: input.actorUserId ?? undefined,
    });
  }
  const author = await authorForUser(input.actorUserId);
  // Ref policy: consoles pin to the default branch while their Mongo index
  // is main-scoped — see branch-policy.ts for the doctrine.
  const branch = await commitBranchFor(
    "console",
    input.workspaceId,
    input.actorUserId ?? "api-key",
  );
  const result = await commitBlobsOnBranch(repoDir, branch, input.mutation, {
    message: input.message,
    author,
    expectBlobs: input.expectBlobs,
    // A console's name is unique in its folder ignoring letter case: two
    // files that differ only in case break every macOS / Windows checkout.
    foldCase: true,
  });
  if (!result.unchanged) queueMirrorPush(input.workspaceId);
  return { commitOid: result.commitOid, unchanged: result.unchanged };
}

/**
 * The workspace repo with main freshened from the mirror — what every
 * write must read from before deciding what to write (a laptop push that
 * arrives in that fetch must be seen, not overwritten). Returns the repo
 * dir; throws RepoRequiredError exactly as commitConsoleBatch does.
 */
async function freshMain(workspaceId: string): Promise<string> {
  const repoDir = await requireWorkspaceRepo(workspaceId);
  if (appsRequireConnectedRepo() && !(await resolveMirrorTarget(workspaceId))) {
    throw new RepoRequiredError();
  }
  // Commit onto the mirror's main, not a stale cached tip (consoles pin to
  // the default branch — see branch-policy.ts).
  await freshenBeforeMainWrite(workspaceId);
  return repoDir;
}

/**
 * A console file at main, as a relocation needs it: the raw contents and
 * blob oid (the CAS expectation) plus the chart sidecar, if any.
 */
async function fileAtMainFor(
  repoDir: string,
  head: string,
  path: string,
): Promise<{
  contents: string;
  oid: string;
  sidecar: { contents: string; oid: string } | null;
} | null> {
  const oid = await blobOidAt(repoDir, head, path);
  if (!oid) return null;
  const contents = await readAt(repoDir, path);
  if (contents === null) return null;
  const sidecarPath = chartSidecarPath(path);
  const sidecarOid = await blobOidAt(repoDir, head, sidecarPath);
  const sidecarContents =
    sidecarOid === null ? null : await readAt(repoDir, sidecarPath);
  return {
    contents,
    oid,
    sidecar:
      sidecarOid !== null && sidecarContents !== null
        ? { contents: sidecarContents, oid: sidecarOid }
        : null,
  };
}

/**
 * Project a row's desired (in-memory) state onto the repo. `previousPath`
 * is the row's current `path` when it may have moved (rename, folder move,
 * access change) so the old file goes in the same commit.
 */
export async function commitConsoleState(input: {
  row: RowLike;
  previousPath?: string | null;
  actorUserId?: string | null;
  message: string;
  /**
   * The console has no file yet (a draft's first save, a never-committed
   * row): the path must be free at commit time. A file a laptop pushed
   * there, synced or not, is never overwritten by a first save — the
   * compare-and-swap refuses (`BlobPreconditionError`) and the caller says
   * so. A console that already owns a file saves over it as before.
   */
  expectAbsent?: boolean;
}): Promise<ConsoleCommitResult & { path: string; sourceBlobSha: string }> {
  const workspaceId = input.row.workspaceId.toString();
  const path = await repoPathForRow(input.row);
  const state = fileStateFromRow(input.row);
  const { writes, deletes } = filesFor(path, state);
  if (input.previousPath && input.previousPath !== path) {
    deletes.push(input.previousPath, chartSidecarPath(input.previousPath));
  }
  const result = await commitConsoleBatch({
    workspaceId,
    actorUserId: input.actorUserId,
    mutation: { writes, deletes },
    message: input.message,
    expectBlobs: input.expectAbsent
      ? { [path]: null, [chartSidecarPath(path)]: null }
      : undefined,
  });
  return { ...result, path, sourceBlobSha: blobOid(writes[path]) };
}

/**
 * Put a deleted console's file back as it was LAST COMMITTED: the blob the
 * row's `sourceBlobSha` names is read from the object store (a deleted
 * file's blob outlives the deletion) and written at the row's (possibly
 * re-chosen) path, path-must-be-absent; its chart sidecar comes back as it
 * was just before the deletion. The row's working copy — an unsaved draft —
 * is never what a restore commits. A row with no committed blob (never
 * adopted) is projected from the row, its only definition.
 */
export async function restoreConsoleBlob(input: {
  row: RowLike & { sourceBlobSha?: string | null; path?: string | null };
  actorUserId?: string | null;
  message: string;
}): Promise<ConsoleCommitResult & { path: string; sourceBlobSha: string }> {
  const workspaceId = input.row.workspaceId.toString();
  const repoDir = await freshMain(workspaceId);
  const contents = input.row.sourceBlobSha
    ? await readBlobByOid(repoDir, input.row.sourceBlobSha)
    : null;
  if (contents === null) {
    return commitConsoleState({
      row: input.row,
      actorUserId: input.actorUserId,
      message: input.message,
      expectAbsent: true,
    });
  }
  const path = await repoPathForRow(input.row);
  const sidecarPath = chartSidecarPath(path);
  const writes: Record<string, string> = { [path]: contents };
  const sidecar = await committedSidecarFor(
    repoDir,
    input.row.path,
    input.row.sourceBlobSha as string,
  );
  if (sidecar !== null) writes[sidecarPath] = sidecar;
  const result = await commitConsoleBatch({
    workspaceId,
    actorUserId: input.actorUserId,
    mutation: { writes },
    message: input.message,
    expectBlobs: { [path]: null, [sidecarPath]: null },
    alreadyFresh: true,
  });
  return { ...result, path, sourceBlobSha: blobOid(contents) };
}

/**
 * The chart sidecar that sat beside `path` while it held `blob`: read in
 * the commit just before the last one that touched `path` (the deletion),
 * or in that commit itself. Null when there was none or the history does
 * not show that blob there any more (the path was reused).
 */
async function committedSidecarFor(
  repoDir: string,
  path: string | null | undefined,
  blob: string,
): Promise<string | null> {
  if (!path || !parseConsoleRepoPath(path)) return null;
  const head = await resolveCommit(repoDir, MAIN);
  if (!head) return null;
  const [last] = await repoLog(repoDir, head, 1, path);
  if (!last) return null;
  for (const at of [`${last.oid}^`, last.oid]) {
    if ((await blobOidAt(repoDir, at, path)) !== blob) continue;
    const sidecar = await readBlob(repoDir, at, chartSidecarPath(path)).catch(
      () => null,
    );
    return sidecar && !sidecar.isBinary ? sidecar.contents : null;
  }
  return null;
}

/** Remove a console's file (and sidecar) from the repo. */
export async function commitConsoleRemoval(input: {
  workspaceId: string;
  path: string;
  actorUserId?: string | null;
  message: string;
}): Promise<ConsoleCommitResult> {
  return commitConsoleBatch({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    mutation: { deletes: [input.path, chartSidecarPath(input.path)] },
    message: input.message,
  });
}

/**
 * Move a console's file (and chart sidecar) AS IT IS AT MAIN to a new path,
 * in one commit. A rename or move must never publish the row's working
 * copy: `SavedConsole.code` can hold an unreviewed draft (an agent's
 * `modify_console`, an editor autosave), and projecting the row — what
 * `commitConsoleState` does, rightly, for a SAVE — would land that draft
 * on main authored as the user under a "rename:" subject. Returns null when
 * there is no file at `fromPath`; the caller then falls back to projecting
 * the row, which is the only definition left.
 *
 * The commit is a compare-and-swap (`expectBlobs`): `fromPath` must still
 * hold the blob read here and `toPath` (and its sidecar) must be absent at
 * commit time — so two renames racing for one free name cannot both win,
 * a laptop push that lands the target name between read and commit is
 * not overwritten, and a save racing the rename is not undone. The read
 * happens AFTER main is freshened from the mirror for the same reason.
 *
 * `sourceBlobSha` is what the row's fields were derived from. When the
 * file at `fromPath` is a different blob, a push edited it and its sync
 * has not run: moving that blob and stamping the row with its oid would
 * make the sync believe the row is current for ever (a laptop-added
 * schedule would never register), so the move is refused for the caller
 * to sync and retry. Throws `BlobPreconditionError` (repository.service)
 * when refused.
 */
export async function commitConsoleRelocation(input: {
  workspaceId: string;
  fromPath: string;
  toPath: string;
  actorUserId?: string | null;
  message: string;
  /** The blob the row's fields came from; a different one at main = drift. */
  sourceBlobSha?: string | null;
}): Promise<
  (ConsoleCommitResult & { path: string; sourceBlobSha: string }) | null
> {
  const repoDir = await freshMain(input.workspaceId);
  const head = await resolveCommit(repoDir, MAIN);
  if (!head) return null;
  const file = await fileAtMainFor(repoDir, head, input.fromPath);
  if (!file) return null;
  if (input.sourceBlobSha && file.oid !== input.sourceBlobSha) {
    throw new BlobPreconditionError(
      input.fromPath,
      input.sourceBlobSha,
      file.oid,
    );
  }
  const fromSidecar = chartSidecarPath(input.fromPath);
  const toSidecar = chartSidecarPath(input.toPath);
  const writes: Record<string, string> = { [input.toPath]: file.contents };
  if (file.sidecar) writes[toSidecar] = file.sidecar.contents;
  const deletes = [input.fromPath, fromSidecar];
  if (!file.sidecar) deletes.push(toSidecar);
  const result = await commitConsoleBatch({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    mutation: { writes, deletes: deletes.filter(d => !(d in writes)) },
    message: input.message,
    expectBlobs: {
      [input.fromPath]: file.oid,
      [fromSidecar]: file.sidecar?.oid ?? null,
      [input.toPath]: null,
      [toSidecar]: null,
    },
    alreadyFresh: true,
  });
  return { ...result, path: input.toPath, sourceBlobSha: file.oid };
}

/**
 * Has a push reached main that the index has not taken in, for any of
 * these rows? True when a row's file is missing at (freshened) main or is
 * a different blob than the row was derived from. A folder operation asks
 * this BEFORE it touches Mongo: syncing afterwards would re-home the rows
 * under the tree's (old) folder names and strand the renamed folder.
 */
export async function consoleFilesDrifted(
  workspaceId: string,
  rows: ReadonlyArray<{ path?: string | null; sourceBlobSha?: string | null }>,
): Promise<boolean> {
  const tracked = rows.filter(r => r.path);
  if (tracked.length === 0) return false;
  const repoDir = await freshMain(workspaceId);
  const head = await resolveCommit(repoDir, MAIN);
  if (!head) return false;
  for (const row of tracked) {
    const oid = await blobOidAt(repoDir, head, row.path as string);
    if (!oid || (row.sourceBlobSha && oid !== row.sourceBlobSha)) return true;
  }
  return false;
}

/**
 * Move a set of rows whose paths changed together (folder rename or move,
 * folder access change) in one commit. Each entry is the row's desired
 * state plus the path it currently occupies. Like `commitConsoleRelocation`
 * this moves each file AS IT IS AT MAIN — a folder rename must not publish
 * every console's unsaved draft — and projects a row only when it was
 * never committed (no `previousPath`). A row whose file is missing at main
 * or is a different blob than its `sourceBlobSha` (a push not yet synced)
 * refuses the whole batch with `BlobPreconditionError`: the caller syncs
 * and retries. The batch is also a compare-and-swap: every source must
 * still be the blob read, every destination that is not also a source
 * must be absent.
 */
export async function commitConsoleMoves(input: {
  workspaceId: string;
  rows: Array<{
    id: string;
    row: RowLike;
    previousPath?: string | null;
    /** The blob the row's fields came from (see commitConsoleRelocation). */
    sourceBlobSha?: string | null;
  }>;
  actorUserId?: string | null;
  message: string;
}): Promise<
  ConsoleCommitResult & {
    /** row id → where it now lives. */
    paths: Map<string, { path: string; sourceBlobSha: string }>;
  }
> {
  const repoDir = await freshMain(input.workspaceId);
  const head = await resolveCommit(repoDir, MAIN);
  const folderCache = new Map<string, FolderLean | null>();
  const writes: Record<string, string> = {};
  const deletes: string[] = [];
  const expectBlobs: Record<string, string | null> = {};
  const paths = new Map<string, { path: string; sourceBlobSha: string }>();
  for (const { id, row, previousPath, sourceBlobSha } of input.rows) {
    const path = await repoPathForRow(row, folderCache);
    if (previousPath) {
      const file = head
        ? await fileAtMainFor(repoDir, head, previousPath)
        : null;
      if (!file) {
        throw new BlobPreconditionError(
          previousPath,
          sourceBlobSha ?? "?",
          null,
        );
      }
      if (sourceBlobSha && file.oid !== sourceBlobSha) {
        throw new BlobPreconditionError(previousPath, sourceBlobSha, file.oid);
      }
      // Two consoles of the batch landing on one file would be "last wins"
      // under a CAS that cannot see it; the caller pre-checks, this holds.
      if (path in writes) {
        throw new Error(`Two consoles would be written to ${path}`);
      }
      writes[path] = file.contents;
      if (file.sidecar) writes[chartSidecarPath(path)] = file.sidecar.contents;
      else deletes.push(chartSidecarPath(path));
      expectBlobs[previousPath] = file.oid;
      expectBlobs[chartSidecarPath(previousPath)] = file.sidecar?.oid ?? null;
      paths.set(id, { path, sourceBlobSha: file.oid });
    } else {
      const files = filesFor(path, fileStateFromRow(row));
      Object.assign(writes, files.writes);
      deletes.push(...files.deletes);
      paths.set(id, { path, sourceBlobSha: blobOid(files.writes[path]) });
    }
    if (previousPath && previousPath !== path) {
      deletes.push(previousPath, chartSidecarPath(previousPath));
    }
  }
  // Destinations must be free — unless they are also a source in this same
  // batch (A→B while another goes B→A), whose expectation is its blob.
  for (const path of Object.keys(writes)) {
    if (!(path in expectBlobs)) expectBlobs[path] = null;
  }
  // A path both written and deleted (A→B while another goes B→A) must end
  // up written: deletes are applied first by the index-info order.
  const finalDeletes = deletes.filter(d => !(d in writes));
  const result = await commitConsoleBatch({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    mutation: { writes, deletes: finalDeletes },
    message: input.message,
    expectBlobs,
    alreadyFresh: true,
  });
  return { ...result, paths };
}

// ---------------------------------------------------------------------------
// Descriptions (derived)
// ---------------------------------------------------------------------------

/** Ask for description + embedding derivation; debounced server-side. */
export function requestConsoleDescription(
  data: ConsoleDescriptionEventData,
): void {
  void inngest.send({ name: CONSOLE_DESCRIPTION_EVENT, data }).catch(error => {
    logger.warn("Console description request could not be queued", {
      consoleId: data.consoleId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export type DeriveOutcome =
  | "updated"
  | "current"
  | "unavailable"
  | "missing"
  | "raced";

/**
 * Derive description + embedding for one console from its indexed content.
 * Runs only while `descriptionSourceSha` differs from `sourceBlobSha`; the
 * write is guarded on `sourceBlobSha` so a slow result never lands on a
 * newer file. Authored descriptions are embedded as they are — no LLM call.
 */
export async function deriveConsoleDescription(
  consoleId: string,
  options: {
    context?: ConsoleDescriptionEventData["context"];
    tracking?: ConsoleDescriptionEventData["tracking"];
    force?: boolean;
  } = {},
): Promise<DeriveOutcome> {
  const row = await SavedConsole.findById(consoleId).populate<{
    connectionId?: { name?: string; type?: string } | null;
  }>("connectionId", "name type");
  if (!row) return "missing";
  const sourceSha = row.sourceBlobSha;
  const currentModel = getEmbeddingModelName();
  const modelStale =
    Boolean(row.embeddingModel) && row.embeddingModel !== currentModel;
  if (
    !options.force &&
    sourceSha &&
    row.descriptionSourceSha === sourceSha &&
    !modelStale
  ) {
    return "current";
  }

  const authored = descriptionIsAuthored(row);
  let description: string | null = authored ? (row.description ?? null) : null;
  if (!authored) {
    if (!isDescriptionGenAvailable()) return "unavailable";
    const connection = row.connectionId as
      | { name?: string; type?: string }
      | null
      | undefined;
    const generated = await generateDescriptionAndEmbedding(
      {
        code: row.code ?? "",
        title: row.name,
        connectionName: connection?.name,
        databaseType: connection?.type,
        databaseName: row.databaseName,
        language: row.language,
        conversationExcerpt: options.context?.conversationExcerpt,
        resultSample: options.context?.resultSample,
      },
      options.tracking
        ? { workspaceId: row.workspaceId.toString(), ...options.tracking }
        : undefined,
    );
    description = generated.description;
    if (!description) return "unavailable";
    const set: Record<string, unknown> = {
      description,
      descriptionSource: "generated",
      descriptionGeneratedAt: new Date(),
      descriptionSourceSha: sourceSha ?? null,
    };
    if (generated.embedding) {
      set.descriptionEmbedding = generated.embedding;
      set.embeddingModel = generated.embeddingModel;
    }
    return guardedWrite(row._id, sourceSha, set);
  }

  // Authored: embed the text as written.
  const set: Record<string, unknown> = {
    descriptionSource: "authored",
    descriptionSourceSha: sourceSha ?? null,
  };
  if (isEmbeddingAvailable() && description) {
    try {
      const embedding = await embedText(description);
      if (embedding) {
        set.descriptionEmbedding = embedding;
        set.embeddingModel = currentModel;
      }
    } catch (error) {
      logger.warn("Console embedding failed", {
        consoleId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return guardedWrite(row._id, sourceSha, set);
}

async function guardedWrite(
  id: Types.ObjectId,
  sourceSha: string | undefined,
  set: Record<string, unknown>,
): Promise<DeriveOutcome> {
  const filter: Record<string, unknown> = { _id: id };
  // Rows never projected to git (drafts, unadopted workspaces) have no sha
  // to guard on; a projected row must still be at the sha we derived from.
  if (sourceSha) filter.sourceBlobSha = sourceSha;
  else filter.sourceBlobSha = { $in: [null, undefined] };
  const result = await SavedConsole.updateOne(filter, { $set: set });
  return result.matchedCount > 0 ? "updated" : "raced";
}

/**
 * Queue derivation for every row whose description is behind its content or
 * whose embedding model is stale — the one reconcile rule (§16.4). Scoped
 * to a workspace when given.
 */
export async function reconcileConsoleDescriptions(
  workspaceId?: string,
): Promise<number> {
  const currentModel = getEmbeddingModelName();
  const filter: Record<string, unknown> = {
    isSaved: true,
    $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
    $and: [
      {
        $or: [
          { $expr: { $ne: ["$descriptionSourceSha", "$sourceBlobSha"] } },
          ...(currentModel
            ? [{ embeddingModel: { $exists: true, $ne: currentModel } }]
            : []),
        ],
      },
    ],
  };
  if (workspaceId) filter.workspaceId = new Types.ObjectId(workspaceId);
  const rows = await SavedConsole.find(filter)
    .select("_id workspaceId")
    .lean<Array<{ _id: Types.ObjectId; workspaceId: Types.ObjectId }>>();
  for (const row of rows) {
    requestConsoleDescription({
      workspaceId: row.workspaceId.toString(),
      consoleId: row._id.toString(),
    });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Sync: repo → index
// ---------------------------------------------------------------------------

export interface ConsoleSyncStats {
  created: number;
  updated: number;
  renamed: number;
  deleted: number;
  restored: number;
  skipped: number;
}

/** Serialize per workspace: two rapid pushes must not interleave a sync. */
const serialized = createSerializer();

type IndexRow = ISavedConsole;

/**
 * Reconcile the index with `main`. Called after every push that reaches
 * the workspace repo (worktree.service.notifyRepoPushed, the GitHub
 * webhook). Idempotent and content-addressed — a push that touched nothing
 * under consoles/ costs one ls-tree.
 */
export function syncConsolesIndexFromRepo(
  workspaceId: string,
  userId?: string,
): Promise<ConsoleSyncStats | null> {
  const run = serialized(workspaceId, () => syncNow(workspaceId, userId));
  latestSync.set(workspaceId, run);
  void run
    .finally(() => {
      if (latestSync.get(workspaceId) === run) latestSync.delete(workspaceId);
    })
    .catch(() => undefined);
  return run;
}

/**
 * Give each console file that sits in a folder with no folder record (in
 * the file's scope) that record, and point its row at it — what the index
 * sync does for a pushed file, for files whose rows it skips as current: a
 * copy made before copies were filed in the copier's own folders kept the
 * ORIGINAL's folder id (another member's private folder) while its file
 * sits under the copier's `users/<id>/consoles/Team Drafts/`; the tree
 * listed it at the root, the breadcrumb (from the file) said "My Consoles
 * › Team Drafts". Serialized with the sync, so a folder is created once.
 */
export function ensureConsoleFolderRecords(
  workspaceId: string,
  files: Array<{
    rowId?: Types.ObjectId;
    segments: string[];
    access: ConsoleAccessLevel;
    ownerId?: string;
  }>,
): Promise<void> {
  if (files.length === 0) return Promise.resolve();
  return serialized(workspaceId, async () => {
    for (const file of files) {
      // A name a record cannot hold as-is is never written (it would fail
      // validation, or be stored trimmed and never match the file again).
      if (!file.segments.every(storableFolderName)) continue;
      // One file's failure is that file's: the listing that asked for the
      // repair must still list everything.
      try {
        const folderId = await ensureFolderChain(file.segments, workspaceId, {
          access: file.access,
          ownerId: file.ownerId,
        });
        if (file.rowId && folderId) {
          await SavedConsole.updateOne(
            {
              _id: file.rowId,
              workspaceId: new Types.ObjectId(workspaceId),
            },
            { $set: { folderId } },
          );
        }
      } catch (error) {
        logger.warn("Console folder record could not be made; skipped", {
          workspaceId,
          segments: file.segments,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
}

/**
 * Whether a ConsoleFolder record holds `name` as it is: the schema trims and
 * requires names, so " " fails validation and "Team " is stored as "Team"
 * — a record that never matches the file's folder (a laptop can push any
 * directory name).
 */
export function storableFolderName(name: string): boolean {
  return name.length > 0 && name.trim() === name;
}

/**
 * The console file at main beside `path` that differs from it only in
 * letter case — other than `ownPath`, the console's own file (a case-only
 * rename) — or null.
 */
export async function consoleCaseVariantAtMain(
  workspaceId: string,
  path: string,
  ownPath?: string | null,
): Promise<string | null> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null || !(await resolveCommit(repoDir, MAIN))) return null;
  return caseVariantOf(repoDir, MAIN, path, new Set(ownPath ? [ownPath] : []));
}

/** The newest sync queued per workspace, while it is still pending. */
const latestSync = new Map<string, Promise<ConsoleSyncStats | null>>();

/**
 * For readers that merely need the index to be current (the stale-path
 * heal): join the sync already queued or running rather than adding one
 * more to the chain. The serializer orders writes; it does not coalesce
 * them, and N readers of one stale console must not mean N syncs.
 */
function joinConsoleIndexSync(
  workspaceId: string,
): Promise<ConsoleSyncStats | null> {
  return latestSync.get(workspaceId) ?? syncConsolesIndexFromRepo(workspaceId);
}

/**
 * May a vanished row be re-keyed onto `to`? Only inside one ownership
 * boundary: the workspace tree, or ONE user's private tree. A pair across
 * the boundary would hand a row — with its `sharedWith` collaborators —
 * to a file in someone else's private folder, or publish a private one.
 */
function sameConsoleOwner(from: string, to: string): boolean {
  const a = parseConsoleRepoPath(from);
  const b = parseConsoleRepoPath(to);
  if (!a || !b) return false;
  return a.scope === b.scope && (a.ownerId ?? null) === (b.ownerId ?? null);
}

async function syncNow(
  workspaceId: string,
  userId?: string,
): Promise<ConsoleSyncStats | null> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return null;
  if (!(await consolesAdopted(repoDir))) return null;
  const head = await resolveCommit(repoDir, MAIN);
  if (!head) return null;

  const stats: ConsoleSyncStats = {
    created: 0,
    updated: 0,
    renamed: 0,
    deleted: 0,
    restored: 0,
    skipped: 0,
  };
  const entries = await listTree(repoDir, head);
  const byPath = new Map<string, TreeEntry>();
  for (const e of entries) byPath.set(e.path, e);
  const consoleEntries = entries.filter(e => parseConsoleRepoPath(e.path));

  const ws = new Types.ObjectId(workspaceId);
  const rows = (await SavedConsole.find({
    workspaceId: ws,
    isSaved: true,
    path: { $exists: true, $ne: null },
  }).select("+descriptionEmbedding")) as IndexRow[];
  // A path is answered by its LIVE row. A soft-deleted row keeps `path` so
  // the file coming back at that very path restores it — but it never
  // outranks a live claimant (a row already at the path, or a vanished live
  // row the file's blob or git's rename detection pairs with): a dead
  // private console must not come back, collaborators and all, wearing a
  // file someone just moved onto its old name. When a live row takes a
  // path a dead row still holds, the dead row's path is unset for good.
  const liveByPath = new Map<string, IndexRow>();
  const deadByPath = new Map<string, IndexRow>();
  for (const r of rows) {
    if (!r.path) continue;
    if (r.is_deleted) deadByPath.set(r.path, r);
    else liveByPath.set(r.path, r);
  }
  const seenRows = new Set<string>();
  const touched: IndexRow[] = [];
  const actor = userId && userId.length > 0 ? userId : "git";

  // Rows whose path is gone are rename candidates: first for new paths with
  // the same blob (a pure `git mv`), then for the paths git's own rename
  // detection pairs them with (a `git mv` plus an edit in the same push —
  // brief rule 3). Anything unclaimed at the end is a deletion.
  // Only LIVE orphans are rename candidates, for the blob pass as much as
  // for git's rename detection: a soft-deleted row is a settled deletion,
  // and it comes back only when a file reappears AT ITS OWN PATH (the
  // `rowByPath` hit below, counted as restored) — never by content, which
  // would hand a long-deleted row and its collaborators to whoever pushes
  // the same query later. The set of deleted rows also grows for the life
  // of the workspace and must never be walked per push.
  const orphans = rows.filter(r => r.path && !byPath.has(r.path));
  const liveOrphans = orphans.filter(o => !o.is_deleted);
  const orphanByBlob = new Map<string, IndexRow[]>();
  for (const o of liveOrphans) {
    if (!o.sourceBlobSha) continue;
    const list = orphanByBlob.get(o.sourceBlobSha) ?? [];
    list.push(o);
    orphanByBlob.set(o.sourceBlobSha, list);
  }
  // Rename detection is bounded on purpose: only when some new file has no
  // row and no identical-blob claimant (else there is nothing a rename
  // could explain). null marks a new path two vanished rows were both
  // mapped to: keep neither guess — the blob pass or a deletion is honest,
  // a wrong re-key is not.
  const orphanByNewPath = new Map<string, IndexRow | null>();
  const unclaimed = consoleEntries.some(
    e => !liveByPath.has(e.path) && !orphanByBlob.has(e.oid),
  );
  if (liveOrphans.length > 0 && unclaimed) {
    const renamed = await detectRenamedPaths(
      repoDir,
      head,
      liveOrphans.map(o => o.path as string),
      [CONSOLES_DIR, USERS_DIR],
    );
    for (const o of liveOrphans) {
      const to = renamed.get(o.path as string);
      if (!to || !sameConsoleOwner(o.path as string, to)) continue;
      orphanByNewPath.set(to, orphanByNewPath.has(to) ? null : o);
    }
  }

  for (const entry of consoleEntries) {
    // One file's failure is that file's problem: a folder-name validation
    // error or a front-matter value the schema cannot cast must not skip
    // every file after it, the deletion pass, and the realtime events.
    try {
      const location = parseConsoleRepoPath(entry.path);
      if (!location) continue;
      const sidecar = byPath.get(chartSidecarPath(entry.path));
      let row = liveByPath.get(entry.path);

      if (!row) {
        // An identical blob is matched inside one ownership boundary too:
        // a workspace console's row (and its collaborators) must not follow
        // its content into a member's private tree, nor the reverse.
        const candidates = orphanByBlob.get(entry.oid);
        const moved =
          candidates?.find(
            c =>
              !seenRows.has(c._id.toString()) &&
              sameConsoleOwner(c.path as string, entry.path),
          ) ??
          orphanByNewPath.get(entry.path) ??
          undefined;
        if (moved && !seenRows.has(moved._id.toString())) {
          row = moved;
          stats.renamed++;
        }
      }

      const dead = deadByPath.get(entry.path);
      if (dead) {
        if (!row) {
          // Nothing live claims the path: the file is back where the
          // deleted console lived — restore it.
          row = dead;
        } else if (!dead._id.equals(row._id)) {
          await SavedConsole.updateOne(
            { _id: dead._id },
            { $unset: { path: "" } },
          );
        }
      }

      if (row) {
        seenRows.add(row._id.toString());
        const contentSame =
          row.sourceBlobSha === entry.oid && row.path === entry.path;
        const chartSame = await sidecarMatches(sidecar, row.chartSpec);
        if (contentSame && chartSame && !row.is_deleted) {
          stats.skipped++;
          continue;
        }
        if (row.is_deleted) stats.restored++;
        else if (row.path === entry.path) stats.updated++;
      }

      const contents = await readAt(repoDir, entry.path);
      // Unreadable files are not healed from Mongo. Skip; GET/list omits them.
      if (contents === null) continue;
      const parsed = parseConsoleFile(contents, location.language);
      const chartSpec = sidecar
        ? parseChartSpec((await readAt(repoDir, sidecar.path)) ?? "")
        : undefined;
      const access: ConsoleAccessLevel =
        location.scope === "private" ? "private" : "workspace";
      const ownerId =
        location.scope === "private" && location.ownerId
          ? location.ownerId
          : (row?.owner_id ?? row?.createdBy ?? actor);
      // The folder the row is in, when the file is still in it (see
      // `folderStillHolding`); else the folder chain of the file's path.
      // A folder that first appears from git belongs to whoever pushed it
      // (the console's owner), so they can rename or delete it later.
      const folderId =
        (row
          ? await folderStillHolding(row, location, ownerId, workspaceId)
          : undefined) ??
        (await ensureFolderChain(location.folderSegments, workspaceId, {
          access,
          ownerId,
        }));

      const set: Record<string, unknown> = {
        path: entry.path,
        sourceBlobSha: entry.oid,
        name: location.name,
        language: location.language,
        code: parsed.code,
        folderId: folderId ?? null,
        access,
        isPrivate: access === "private",
        owner_id: ownerId,
        connectionId:
          parsed.meta.connectionId &&
          Types.ObjectId.isValid(parsed.meta.connectionId)
            ? new Types.ObjectId(parsed.meta.connectionId)
            : null,
        databaseName: parsed.meta.databaseName ?? null,
        databaseId: parsed.meta.databaseId ?? null,
        resultsViewMode: parsed.meta.resultsViewMode ?? null,
        chartSpec: chartSpec ?? null,
        is_deleted: false,
        isSaved: true,
        lastDraftOrigin: "user",
        updatedAt: new Date(),
      };
      if (parsed.meta.description) {
        set.description = parsed.meta.description;
        set.descriptionSource = "authored";
      } else if (row && descriptionIsAuthored(row)) {
        // The author removed their description: the generated one takes over
        // on the next derivation.
        set.description = "";
        set.descriptionSource = "generated";
      }
      const scheduleSet = scheduleFields(parsed.meta.schedule, row);
      Object.assign(set, scheduleSet.set);
      // `mongoOptions` is a nested object in the schema: it is the file's
      // pair or ABSENT, never null — a null here made every later
      // `new SavedConsole({... mongoOptions: row.mongoOptions })` (Duplicate)
      // fail validation ("Cast to Object failed for value null").
      const mongoOptions = mongoOptionsFromFile(parsed.meta.mongoOptions);
      if (mongoOptions) set.mongoOptions = mongoOptions;

      if (row) {
        await SavedConsole.updateOne(
          { _id: row._id },
          {
            $set: set,
            $inc: { version: 1, draftRevision: 1 },
            $unset: {
              deletedAt: "",
              ...scheduleSet.unset,
              ...(mongoOptions ? {} : { mongoOptions: "" }),
            },
          },
        );
        const fresh = await SavedConsole.findById(row._id);
        if (fresh) touched.push(fresh);
        continue;
      }

      // The first derivation no row at another path holds: a renamed
      // git-born console keeps its id, and a new file at its old name must
      // get its own row, never be folded into the renamed one.
      const newId = await freeDerivedConsoleId(workspaceId, entry.path);
      try {
        const created = await SavedConsole.create({
          _id: newId,
          workspaceId: ws,
          createdBy: actor,
          executionCount: 0,
          version: 1,
          draftRevision: 1,
          ...set,
        });
        stats.created++;
        seenRows.add(created._id.toString());
        touched.push(created);
      } catch {
        // Unique-id race with a concurrent list/sync: keep the winner so a
        // git-only file that already appeared under the derived id does not
        // mint a second row — but only a winner AT THIS PATH; an id held by
        // a row elsewhere is not ours.
        const winner =
          (await SavedConsole.findOne({
            workspaceId: ws,
            path: entry.path,
            isSaved: true,
          })) ?? (await SavedConsole.findOne({ _id: newId, path: entry.path }));
        if (!winner) throw new Error("Could not persist the console index row");
        stats.created++;
        seenRows.add(winner._id.toString());
        touched.push(winner);
      }
    } catch (error) {
      logger.warn("Console file could not be reconciled; skipped", {
        workspaceId,
        path: entry.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Deletions: adopted repo, path gone, blob not claimed by a rename.
  for (const row of rows) {
    if (seenRows.has(row._id.toString())) continue;
    if (!row.path || byPath.has(row.path) || row.is_deleted) continue;
    // Its file's history up to the push that deleted it — kept for when it
    // is restored (as a new file, where git's history of it starts).
    const segment = await deletionSegment(repoDir, row.path, {
      ownBlob: row.sourceBlobSha,
    }).catch(() => null);
    const deleted = await SavedConsole.updateOne(
      { _id: row._id, is_deleted: { $ne: true } },
      {
        $set: { is_deleted: true, deletedAt: new Date() },
        ...(segment ? { $addToSet: { historySegments: segment } } : {}),
      },
    );
    // Duplicate push deliveries or concurrent instances may reconcile the
    // same commit. Only the process that changed the row may broadcast it.
    if (deleted.modifiedCount === 0) continue;
    stats.deleted++;
    publishRealtimeEvent(workspaceId, {
      type: "console.deleted",
      consoleId: row._id.toString(),
      via: "git",
    });
  }

  for (const row of touched) {
    publishRealtimeEvent(workspaceId, {
      type: "console.updated",
      consoleId: row._id.toString(),
      draftRevision: row.draftRevision ?? 1,
      name: row.name,
      updatedBy: actor,
      origin: "save",
      via: "git",
    });
    if (row.descriptionSourceSha !== row.sourceBlobSha) {
      requestConsoleDescription({
        workspaceId,
        consoleId: row._id.toString(),
      });
    }
  }

  if (stats.created || stats.updated || stats.renamed || stats.deleted) {
    logger.info("Console index synced from repo", { workspaceId, ...stats });
  }
  return stats;
}

/**
 * The row's folder, when the file at `location` is still in it: the
 * folder's chain of names is the file's directory chain, and it is a
 * folder the console may be filed in (a workspace folder, or its owner's
 * own private one). A sync must not re-home such a row: a PRIVATE console
 * filed in a WORKSPACE folder — seen by the workspace through it — has
 * its file under its owner's private root, and the scoped chain of that
 * path is the owner's private namesake, so a mere content edit pushed from
 * a laptop used to hide it from the workspace behind its owner's back (a
 * visibility change only its owner or an admin may make). A file that
 * moved folders is filed by its path, as before.
 */
async function folderStillHolding(
  row: Pick<ISavedConsole, "folderId">,
  location: ConsoleRepoLocation,
  ownerId: string,
  workspaceId: string,
): Promise<Types.ObjectId | undefined> {
  if (!row.folderId) return undefined;
  const segments = await folderSegmentsFor(row.folderId, workspaceId);
  const wanted = location.folderSegments;
  if (
    segments.length !== wanted.length ||
    segments.some((name, i) => name !== wanted[i])
  ) {
    return undefined;
  }
  const folder = await ConsoleFolder.findOne({
    _id: row.folderId,
    workspaceId: new Types.ObjectId(workspaceId),
  })
    .select("access isPrivate ownerId")
    .lean<{
      access?: ConsoleAccessLevel;
      isPrivate?: boolean;
      ownerId?: string;
    } | null>();
  if (!folder) return undefined;
  const folderAccess =
    folder.access ?? (folder.isPrivate ? "private" : "workspace");
  if (folderAccess === "private" && folder.ownerId?.toString() !== ownerId) {
    return undefined;
  }
  return row.folderId;
}

async function sidecarMatches(
  sidecar: TreeEntry | undefined,
  chartSpec: Record<string, unknown> | undefined,
): Promise<boolean> {
  const rowHas = Boolean(chartSpec && Object.keys(chartSpec).length > 0);
  if (!sidecar) return !rowHas;
  if (!rowHas || !chartSpec) return false;
  return sidecar.oid === blobOid(serializeChartSpec(chartSpec));
}

/**
 * A console file's collection/operation as the index stores them: both set,
 * or nothing — an empty or partial pair is no Mongo target at all.
 */
export function mongoOptionsFromFile(
  meta: { collection?: string; operation?: string } | null | undefined,
): ISavedConsole["mongoOptions"] | undefined {
  if (!meta?.collection) return undefined;
  return {
    collection: meta.collection,
    operation: (meta.operation || "find") as NonNullable<
      ISavedConsole["mongoOptions"]
    >["operation"],
  };
}

function scheduleFields(
  schedule: { cron: string; timezone: string } | undefined,
  row: IndexRow | undefined,
): { set: Record<string, unknown>; unset: Record<string, ""> } {
  if (!schedule) {
    return row?.schedule?.cron
      ? { set: {}, unset: { schedule: "", scheduledRun: "" } }
      : { set: {}, unset: {} };
  }
  try {
    const valid = validateScheduledConsoleSchedule(schedule);
    const same =
      row?.schedule?.cron === valid.cron &&
      row?.schedule?.timezone === valid.timezone;
    if (same) return { set: {}, unset: {} };
    return {
      set: {
        schedule: valid,
        scheduledRun: {
          ...(row?.scheduledRun ?? { runCount: 0, consecutiveFailures: 0 }),
          nextAt: getNextScheduledConsoleRunAt(valid),
        },
      },
      unset: {},
    };
  } catch (error) {
    logger.warn("Ignoring invalid console schedule from repo", {
      schedule,
      error: error instanceof Error ? error.message : String(error),
    });
    return { set: {}, unset: {} };
  }
}

// ---------------------------------------------------------------------------
// Adoption / migration
// ---------------------------------------------------------------------------

export interface AdoptionReport {
  workspaceId: string;
  consoles: number;
  alreadyCurrent: number;
  versionsReplayed: number;
  commits: number;
  adopted: boolean;
  durable: boolean;
  dryRun: boolean;
}

interface VersionState {
  state: ConsoleFileState;
  scope: { scope: "workspace" | "private"; ownerId?: string };
  folderSegments: string[];
}

/** A version snapshot, completed from the live row where it is silent. */
async function stateFromSnapshot(
  row: ISavedConsole,
  snapshot: Record<string, unknown>,
  folderCache: Map<string, FolderLean | null>,
): Promise<VersionState> {
  const s = snapshot as Partial<{
    name: string;
    description: string;
    code: string;
    language: string;
    connectionId: string;
    databaseName: string;
    databaseId: string;
    chartSpec: Record<string, unknown>;
    resultsViewMode: "table" | "json" | "chart";
    mongoOptions: { collection: string; operation: string };
    folderId: string;
    access: ConsoleAccessLevel;
  }>;
  const merged: RowLike = {
    workspaceId: row.workspaceId,
    name: s.name ?? row.name,
    // Snapshot descriptions predate the authored/generated split; a
    // description that the live row calls generated stays out of the file.
    description: s.description ?? row.description,
    descriptionSource: row.descriptionSource,
    descriptionGeneratedAt: row.descriptionGeneratedAt,
    code: s.code ?? row.code,
    language: (s.language as ConsoleLanguage) ?? row.language,
    connectionId:
      s.connectionId && Types.ObjectId.isValid(s.connectionId)
        ? new Types.ObjectId(s.connectionId)
        : row.connectionId,
    databaseName: s.databaseName ?? row.databaseName,
    databaseId: s.databaseId ?? row.databaseId,
    chartSpec: s.chartSpec ?? row.chartSpec,
    resultsViewMode: s.resultsViewMode ?? row.resultsViewMode,
    mongoOptions:
      (s.mongoOptions as ISavedConsole["mongoOptions"]) ?? row.mongoOptions,
    schedule: row.schedule,
    access: s.access ?? row.access,
    isPrivate: (s.access ?? row.access) === "private",
    owner_id: row.owner_id,
    createdBy: row.createdBy,
    folderId:
      s.folderId && Types.ObjectId.isValid(s.folderId)
        ? new Types.ObjectId(s.folderId)
        : row.folderId,
  };
  const folderSegments = await folderSegmentsFor(
    merged.folderId,
    row.workspaceId.toString(),
    folderCache,
  );
  return {
    state: fileStateFromRow(merged),
    scope: rowScope(merged),
    folderSegments,
  };
}

async function versionAuthors(
  versions: IEntityVersion[],
): Promise<Map<string, GitAuthor>> {
  const out = new Map<string, GitAuthor>();
  for (const id of new Set(versions.map(v => v.savedBy).filter(Boolean))) {
    const author = await authorForUser(id);
    if (author) out.set(id, author);
  }
  return out;
}

function versionAuthor(
  version: IEntityVersion,
  known: Map<string, GitAuthor>,
): GitAuthor {
  if (version.savedByName === "System") {
    return { name: "Mako", email: "bot@mako.ai", date: version.createdAt };
  }
  const found = known.get(version.savedBy);
  if (found) return { ...found, date: version.createdAt };
  const email =
    version.savedByName && version.savedByName.includes("@")
      ? version.savedByName
      : `${version.savedBy || "unknown"}@users.invalid`;
  return {
    name: version.savedByName || version.savedBy || "Unknown",
    email,
    date: version.createdAt,
  };
}

/**
 * Bring a workspace's saved consoles into its repo. Re-runnable: rows whose
 * file is already at head with the recorded blob are skipped; with
 * `replayHistory` every `entity_versions` snapshot becomes a commit first
 * (original author, timestamp, comment — §13.18), then the live state when
 * it differs from the last version. Existing embeddings are kept by
 * stamping `descriptionSourceSha` (§16.4). Ends by writing the adoption
 * marker and pushing the mirror.
 */
export async function adoptWorkspaceConsoles(
  workspaceId: string,
  options: {
    replayHistory: boolean;
    dryRun?: boolean;
    actorUserId?: string;
  },
): Promise<AdoptionReport> {
  const ws = new Types.ObjectId(workspaceId);
  const report: AdoptionReport = {
    workspaceId,
    consoles: 0,
    alreadyCurrent: 0,
    versionsReplayed: 0,
    commits: 0,
    adopted: false,
    durable: false,
    dryRun: Boolean(options.dryRun),
  };
  const rows = (await SavedConsole.find({
    workspaceId: ws,
    isSaved: true,
    $or: [{ is_deleted: { $ne: true } }, { is_deleted: { $exists: false } }],
  })
    .select("+descriptionEmbedding")
    .sort({ createdAt: 1 })) as ISavedConsole[];
  report.consoles = rows.length;
  if (options.dryRun) {
    if (options.replayHistory) {
      report.versionsReplayed = await EntityVersion.countDocuments({
        workspaceId: ws,
        entityType: "console",
        entityId: { $in: rows.map(r => r._id) },
      });
    }
    return report;
  }

  const repoDir = await ensureConsolesRepo(workspaceId);
  const alreadyAdopted = await consolesAdopted(repoDir);
  const head = await resolveCommit(repoDir, MAIN);
  const tree = new Map<string, string>();
  if (head) {
    for (const e of await listTree(repoDir, head)) tree.set(e.path, e.oid);
  }
  const folderCache = new Map<string, FolderLean | null>();
  const actorAuthor = await authorForUser(options.actorUserId);
  const takenPaths = new Set<string>(tree.keys());
  // Paths other rows already own. A file at the wanted path with the SAME
  // blob and no owner is this console (an earlier run that stopped between
  // its commit and its stamp) — claim it rather than minting "(2)".
  const claimed = new Set<string>(
    rows.map(r => r.path).filter((p): p is string => Boolean(p)),
  );

  const commit = async (
    mutation: BlobMutation,
    message: string,
    author?: GitAuthor,
    // Version replays commit even when file-identical (a schedule-only or
    // comment-only save still happened); lifecycle commits stay deduped.
    allowEmpty = false,
  ) => {
    const r = await commitBlobsOnBranch(repoDir, DEFAULT_BRANCH, mutation, {
      message,
      author,
      allowEmpty,
    });
    if (!r.unchanged) report.commits++;
    return r;
  };

  for (const row of rows) {
    const finalState = fileStateFromRow(row);
    const finalContents = serializeConsoleFile(finalState);
    const finalSha = blobOid(finalContents);
    const wanted = await repoPathForRow(row, folderCache);
    const finalPath =
      !row.path && tree.get(wanted) === finalSha && !claimed.has(wanted)
        ? wanted
        : uniquePath(wanted, takenPaths, row.path);
    claimed.add(finalPath);
    if (row.path === finalPath && tree.get(finalPath) === finalSha) {
      report.alreadyCurrent++;
      await stampRow(row, finalPath, finalSha);
      continue;
    }

    let previousPath: string | null =
      row.path && tree.has(row.path) ? row.path : null;
    if (options.replayHistory && !row.path) {
      const versions = (await EntityVersion.find({
        entityType: "console",
        entityId: row._id,
      }).sort({ version: 1 })) as IEntityVersion[];
      const known = await versionAuthors(versions);
      for (const version of versions) {
        const vs = await stateFromSnapshot(
          row,
          version.snapshot ?? {},
          folderCache,
        );
        const vPath = uniquePath(
          consoleRepoPath({
            ...vs.scope,
            folderSegments: vs.folderSegments,
            name: vs.state.name,
            language: vs.state.language,
          }),
          takenPaths,
          previousPath ?? undefined,
        );
        const files = filesFor(vPath, vs.state);
        const deletes = [...files.deletes];
        if (previousPath && previousPath !== vPath) {
          deletes.push(previousPath, chartSidecarPath(previousPath));
        }
        await commit(
          { writes: files.writes, deletes },
          (version.comment ?? "").trim() || `v${version.version}`,
          versionAuthor(version, known),
          true,
        );
        report.versionsReplayed++;
        previousPath = vPath;
      }
    }

    const files = filesFor(finalPath, finalState);
    const deletes = [...files.deletes];
    if (previousPath && previousPath !== finalPath) {
      deletes.push(previousPath, chartSidecarPath(previousPath));
    }
    const author =
      actorAuthor ?? (await authorForUser(row.owner_id || row.createdBy));
    await commit(
      { writes: files.writes, deletes },
      previousPath
        ? `Adopt current state: ${finalPath}`
        : `Adopt console: ${finalPath}`,
      author,
    );
    takenPaths.add(finalPath);
    await stampRow(row, finalPath, finalSha);
  }

  if (!alreadyAdopted) {
    await commit(
      { writes: { [CONSOLES_README_PATH]: CONSOLES_README } },
      `Adopt consoles into git (${rows.length} console${rows.length === 1 ? "" : "s"})`,
      actorAuthor,
    );
  }
  report.adopted = true;

  // Durable tier (§13.17): the connected repo when bound; local-only otherwise.
  const durable = await resolveMirrorTarget(workspaceId);
  if (durable) {
    await mirrorPushNow(workspaceId);
    report.durable = true;
  }
  logger.info("Workspace consoles adopted into git", { ...report });
  return report;
}

/** Two rows that sanitize to the same path get " (2)", " (3)", … */
export function uniquePath(
  wanted: string,
  taken: Set<string>,
  ownPath: string | undefined | null,
): string {
  // Ignoring letter case: "Report" and "report" in one folder are one file
  // on macOS / Windows. The console's own file is not in the way (a
  // case-only rename of it is the same file).
  const takenFolded = new Set(
    [...taken].filter(p => p !== ownPath).map(p => p.toLowerCase()),
  );
  const free = (p: string) =>
    p === ownPath || !takenFolded.has(p.toLowerCase());
  if (free(wanted)) return wanted;
  const location = parseConsoleRepoPath(wanted);
  if (!location) return wanted;
  for (let i = 2; ; i++) {
    const candidate = consoleRepoPath({
      ...location,
      name: `${location.name} (${i})`,
    });
    if (free(candidate)) return candidate;
  }
}

async function stampRow(
  row: ISavedConsole,
  path: string,
  sourceBlobSha: string,
): Promise<void> {
  const set: Record<string, unknown> = { path, sourceBlobSha };
  const hasEmbedding =
    Array.isArray(row.descriptionEmbedding) &&
    row.descriptionEmbedding.length > 0;
  if (!row.descriptionSource) {
    set.descriptionSource = descriptionIsAuthored(row)
      ? "authored"
      : "generated";
  }
  // Keep every existing embedding: it described this same content.
  if (hasEmbedding && !row.descriptionSourceSha) {
    set.descriptionSourceSha = sourceBlobSha;
  }
  await SavedConsole.updateOne({ _id: row._id }, { $set: set });
}

// ---------------------------------------------------------------------------
// Route-side projection: `$set`-shaped writes
// ---------------------------------------------------------------------------

export interface Projection {
  path: string;
  sourceBlobSha: string;
  /**
   * Undo the commit when the Mongo write that followed it lost (a 409 on a
   * version guard): re-commit the previous file, or remove the new one when
   * the console did not exist. Honest history, no divergence.
   */
  revert: () => Promise<void>;
}

/**
 * Git-first projection for a handler that is about to run
 * `findOneAndUpdate({ $set, $setOnInsert })` on a saved console: merge the
 * current row with the pending fields into the desired state, commit it, and
 * hand back the `path`/`sourceBlobSha` to include in the same `$set`.
 */
export async function projectSavedConsole(input: {
  workspaceId: string;
  current: ISavedConsole | null;
  set: Record<string, unknown>;
  onInsert?: Record<string, unknown>;
  actorUserId: string;
  message: string;
  /**
   * The file the save replaces when there is no row yet (a git-only console
   * saved under its derived id): without it the projection writes a second
   * file next to the original instead of moving it.
   */
  previousPath?: string | null;
}): Promise<Projection> {
  const base: Record<string, unknown> = input.current
    ? (input.current.toObject() as Record<string, unknown>)
    : {
        workspaceId: new Types.ObjectId(input.workspaceId),
        language: "sql",
        access: "private",
        isPrivate: true,
        createdBy: input.actorUserId,
        owner_id: input.actorUserId,
        ...(input.onInsert ?? {}),
      };
  // Same semantics as the `$set` that follows: Mongoose drops undefined keys,
  // so `undefined` means "unchanged", never "cleared" (handlers clear with
  // `$unset`, which is not part of a projection).
  const desired = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(input.set)) {
    if (value !== undefined) desired[key] = value;
  }
  const row = desired as unknown as RowLike;
  const previousPath = input.current?.path ?? input.previousPath ?? null;
  const committed = await commitConsoleState({
    row,
    previousPath,
    actorUserId: input.actorUserId,
    message: input.message,
    // No file of its own yet: a first save must find its path free.
    expectAbsent: !previousPath,
  });
  const revert = async () => {
    try {
      if (input.current?.path) {
        await commitConsoleState({
          row: input.current,
          previousPath: committed.path,
          actorUserId: input.actorUserId,
          message: `revert: ${committed.path}`,
        });
      } else {
        await commitConsoleRemoval({
          workspaceId: input.workspaceId,
          path: committed.path,
          actorUserId: input.actorUserId,
          message: `revert: ${committed.path}`,
        });
      }
    } catch (error) {
      logger.error("Could not revert a console commit after a lost write", {
        path: committed.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return {
    path: committed.path,
    sourceBlobSha: committed.sourceBlobSha,
    revert,
  };
}

// ---------------------------------------------------------------------------
// History: the same shapes the apps History popover consumes
// ---------------------------------------------------------------------------

/**
 * A console's commits, newest first — ACROSS its renames and moves
 * (`git log --follow`): a rename keeps the console's id and is the same
 * file under a new name, so its history did not start there. Each commit
 * says where the file was in it (`path`, and `previousPath` on the commit
 * that moved it).
 *
 * Only ITS OWN commits: the walk ends at the file's creation — it does
 * not continue into the console it was copied from ("Save as copy",
 * Duplicate) nor into an earlier console that held the same path
 * (`parseFollowLog`). Either can be another member's private console.
 */
export async function consoleHistory(
  row: Pick<ISavedConsole, "workspaceId" | "path" | "historySegments">,
  limit = 50,
): Promise<FollowedCommit[]> {
  if (!row.path && !row.historySegments?.length) return [];
  const repoDir = await boundRepoDirIfExists(row.workspaceId.toString());
  if (repoDir == null) return [];
  if (!(await resolveCommit(repoDir, MAIN))) return [];
  return consoleLineage(repoDir, row, limit);
}

/**
 * Every commit of this console, newest first: its file's lineage at main,
 * then each EARLIER life — before a trip to the trash, which ended its
 * file (a restore adds a new one, where git's history of it starts) —
 * walked back from the commit that deleted it. The segments are this
 * row's own (`historySegments`), recorded when it was trashed.
 */
async function consoleLineage(
  repoDir: string,
  row: Pick<ISavedConsole, "path" | "historySegments">,
  limit: number,
): Promise<FollowedCommit[]> {
  const out: FollowedCommit[] = [];
  const seen = new Set<string>();
  const add = (commits: FollowedCommit[]) => {
    for (const c of commits) {
      if (seen.has(c.oid)) continue;
      seen.add(c.oid);
      out.push(c);
    }
  };
  if (row.path) add(await logFollow(repoDir, MAIN, limit, row.path));
  // Newest life first.
  for (const segment of [...(row.historySegments ?? [])].reverse()) {
    if (out.length >= limit) break;
    // A deleting commit that is no longer in the repo (history rewritten)
    // takes that life with it.
    const until = await resolveCommit(repoDir, segment.until);
    if (!until) continue;
    add(await logFollow(repoDir, until, limit, segment.path));
  }
  return out.slice(0, limit);
}

/**
 * The earlier life to record when a console's file at `path` leaves main
 * for the trash: the commit that deleted it — `removalCommit` when the
 * caller just made it, else the newest commit on main that deleted `path`,
 * accepted only when the blob it deleted is `ownBlob` (the console's own
 * file, never a later tenant's). Null: nothing of this console to keep.
 */
async function deletionSegment(
  repoDir: string,
  path: string,
  opts: { removalCommit?: string; ownBlob?: string | null },
): Promise<{ path: string; until: string } | null> {
  const until =
    opts.removalCommit ?? (await lastDeletionCommit(repoDir, MAIN, path));
  if (!until) return null;
  // The commit must have deleted a file at `path` (a removal that found
  // only the chart sidecar deleted none of the console's history).
  const deleted = await blobOidAt(repoDir, `${until}^`, path);
  if (!deleted) return null;
  if (!opts.removalCommit && deleted !== opts.ownBlob) return null;
  return { path, until };
}

/** `deletionSegment` for a workspace (null when no repo is bound). */
export async function consoleDeletionSegment(
  workspaceId: string,
  path: string,
  opts: { removalCommit?: string; ownBlob?: string | null },
): Promise<{ path: string; until: string } | null> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return null;
  return deletionSegment(repoDir, path, opts);
}

/** The chart sidecar of a path that may not be a console path (a file the
 * console was renamed from outside the consoles tree has none). */
function sidecarOf(p: string): string | undefined {
  try {
    return chartSidecarPath(p);
  } catch {
    return undefined;
  }
}

/**
 * This console's entry for commit `oid` in its own history — where its
 * file was in that commit — or null when the commit is not one of its own
 * (another console's commit, or older than its creation).
 */
async function consolePathsAt(
  repoDir: string,
  row: Pick<ISavedConsole, "path" | "historySegments">,
  oid: string,
): Promise<FollowedCommit | null> {
  if (!row.path && !row.historySegments?.length) return null;
  const history = await consoleLineage(repoDir, row, 200);
  return history.find(c => c.oid === oid) ?? null;
}

/**
 * A commit or path the history routes may not read through this console:
 * not one of its own commits, or not its file at that commit.
 */
export class NotThisConsoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotThisConsoleError";
  }
}

/** What one commit did to this console (its file and chart sidecar). */
export async function consoleCommitChanges(
  row: Pick<ISavedConsole, "workspaceId" | "path" | "historySegments">,
  sha: string,
): Promise<{ sha: string; parent: string | null; files: ChangedFile[] }> {
  const repoDir = await boundRepoDirIfExists(row.workspaceId.toString());
  if (repoDir == null) throw new Error(`No such commit: ${sha}`);
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  const parent = await resolveCommit(repoDir, `${oid}^`);
  // The file under the name it had IN THAT commit (an older commit of a
  // renamed console touched its old path, not today's). A commit that is
  // not this console's changed nothing of it.
  const at = await consolePathsAt(repoDir, row, oid);
  if (!at) return { sha: oid, parent, files: [] };
  const all = await diffNameStatus(repoDir, parent ?? EMPTY_TREE, oid);
  const mine = new Set(
    [at.path, at.previousPath]
      .filter((p): p is string => !!p)
      .flatMap(p => [p, sidecarOf(p)])
      .filter((p): p is string => !!p),
  );
  return { sha: oid, parent, files: all.filter(f => mine.has(f.path)) };
}

/**
 * Which repo paths `consoleFileVersions` reads for `relPath` at commit
 * `oid`: the console's file (or chart sidecar) under the name it had IN
 * that commit — `after` at its path, `before` at the name it had in the
 * parent (its previous path on the commit that moved it, nothing on the
 * commit that created it). Never "any name it ever had" at any commit: the
 * name it had then may hold another console at another commit (a private
 * console that took the name back, the file it was copied from).
 */
function fileVersionPaths(
  at: FollowedCommit,
  relPath: string,
): { beforePath: string | null; afterPath: string | null } | null {
  const before = at.created ? null : (at.previousPath ?? at.path);
  if (relPath === at.path) return { afterPath: at.path, beforePath: before };
  const sidecar = sidecarOf(at.path);
  if (sidecar && relPath === sidecar) {
    return {
      afterPath: sidecar,
      beforePath: before ? (sidecarOf(before) ?? null) : null,
    };
  }
  if (at.previousPath) {
    // The commit that moved it: its old name, as it was before the move.
    if (relPath === at.previousPath) {
      return { afterPath: null, beforePath: at.previousPath };
    }
    const oldSidecar = sidecarOf(at.previousPath);
    if (oldSidecar && relPath === oldSidecar) {
      return { afterPath: null, beforePath: oldSidecar };
    }
  }
  return null;
}

/**
 * This console's file (or chart sidecar) before and after one of ITS
 * commits (null = absent on that side). `relPath` must be the name the
 * file had in that commit (or the name it moved from, on the commit that
 * moved it); omitted, it is that name. A commit that is not this
 * console's reads nothing — except its current file at the current head.
 * Throws `NotThisConsoleError` for any other path.
 */
export async function consoleFileVersions(
  row: Pick<ISavedConsole, "workspaceId" | "path" | "historySegments">,
  sha: string,
  relPath?: string,
): Promise<{ before: string | null; after: string | null; binary: boolean }> {
  const repoDir = await boundRepoDirIfExists(row.workspaceId.toString());
  if (repoDir == null) throw new Error(`No such commit: ${sha}`);
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  const parent = await resolveCommit(repoDir, `${oid}^`);
  const at = await consolePathsAt(repoDir, row, oid);
  const target = relPath ?? at?.path ?? row.path ?? "";
  let paths = at ? fileVersionPaths(at, target) : null;
  if (!at && row.path && oid === (await resolveCommit(repoDir, MAIN))) {
    // The head did not touch this console: its file as it is now.
    const sidecar = sidecarOf(row.path);
    if (target === row.path || (sidecar && target === sidecar)) {
      paths = { beforePath: target, afterPath: target };
    }
  }
  if (!paths) {
    throw new NotThisConsoleError("Path is not this console at that commit");
  }
  const read = async (ref: string | null, rel: string | null) => {
    if (!ref || !rel) return null;
    try {
      return await readBlob(repoDir, ref, rel);
    } catch {
      return null;
    }
  };
  const [before, after] = await Promise.all([
    read(parent, paths.beforePath),
    read(oid, paths.afterPath),
  ]);
  return {
    before: before?.isBinary ? null : (before?.contents ?? null),
    after: after?.isBinary ? null : (after?.contents ?? null),
    binary: Boolean(before?.isBinary || after?.isBinary),
  };
}

/**
 * Restore a console to its content at `sha` — a NEW commit, history is
 * append-only — and project the restored file back onto the row. `sha`
 * must be one of the console's own commits; the file is read under the
 * name it had in that commit (it may have moved since). Another console's
 * commit restores nothing: its file is not this console's to copy in.
 */
export async function restoreConsoleTo(
  row: ISavedConsole,
  sha: string,
  actorUserId: string,
): Promise<{ commitOid: string; unchanged: boolean }> {
  if (!row.path) throw new Error("This console has no file in the repo yet");
  const repoDir = await boundRepoDirIfExists(row.workspaceId.toString());
  if (repoDir == null) throw new RepoRequiredError();
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  const then = await consolePathsAt(repoDir, row, oid);
  if (!then) {
    throw new NotThisConsoleError(
      "That commit is not in this console's history",
    );
  }
  const at = then.path;
  const blob = await readBlob(repoDir, oid, at).catch(() => null);
  if (!blob || blob.isBinary) {
    throw new Error("That commit has no readable version of this console");
  }
  const location = parseConsoleRepoPath(at);
  const parsed = parseConsoleFile(
    blob.contents,
    location?.language ?? rowLanguage(row),
  );
  const sidecar = await readBlob(repoDir, oid, chartSidecarPath(at)).catch(
    () => null,
  );
  const [info] = await repoLog(repoDir, oid, 1);
  const subject = info?.subject ? ` "${info.subject}"` : "";

  row.code = parsed.code;
  row.connectionId =
    parsed.meta.connectionId && Types.ObjectId.isValid(parsed.meta.connectionId)
      ? new Types.ObjectId(parsed.meta.connectionId)
      : undefined;
  row.databaseName = parsed.meta.databaseName;
  row.databaseId = parsed.meta.databaseId;
  row.resultsViewMode = parsed.meta.resultsViewMode;
  row.mongoOptions = parsed.meta.mongoOptions as ISavedConsole["mongoOptions"];
  row.chartSpec =
    sidecar && !sidecar.isBinary ? parseChartSpec(sidecar.contents) : undefined;
  if (parsed.meta.description) {
    row.description = parsed.meta.description;
    row.descriptionSource = "authored";
  } else if (descriptionIsAuthored(row)) {
    row.description = "";
    row.descriptionSource = "generated";
  }
  if (parsed.meta.schedule) {
    try {
      row.schedule = validateScheduledConsoleSchedule(parsed.meta.schedule);
    } catch {
      row.schedule = undefined;
    }
  } else {
    row.schedule = undefined;
  }
  const committed = await commitConsoleState({
    row,
    previousPath: row.path,
    actorUserId,
    message: `Restore${subject} (${oid.slice(0, 7)})`,
  });
  row.path = committed.path;
  row.sourceBlobSha = committed.sourceBlobSha;
  row.version = (row.version ?? 1) + 1;
  row.draftRevision = (row.draftRevision ?? 1) + 1;
  row.lastDraftOrigin = "user";
  await row.save();
  return { commitOid: committed.commitOid, unchanged: committed.unchanged };
}

/**
 * The last explicitly saved state of a console — its file at HEAD. Git is
 * the history now; snapshot rows are no longer written (§16.6).
 */
export async function savedConsoleStateFromRepo(
  row: Pick<ISavedConsole, "workspaceId" | "path">,
): Promise<{
  code: string;
  connectionId?: string;
  databaseId?: string;
  databaseName?: string;
} | null> {
  if (!row.path) return null;
  const location = parseConsoleRepoPath(row.path);
  if (!location) return null;
  const repoDir = await boundRepoDirIfExists(row.workspaceId.toString());
  if (repoDir == null) return null;
  const contents = await readAt(repoDir, row.path);
  if (contents === null) return null;
  const parsed = parseConsoleFile(contents, location.language);
  return {
    code: parsed.code,
    connectionId: parsed.meta.connectionId,
    databaseId: parsed.meta.databaseId,
    databaseName: parsed.meta.databaseName,
  };
}
