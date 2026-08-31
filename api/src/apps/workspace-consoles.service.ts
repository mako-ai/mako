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
 *    row whose blob reappears elsewhere is a rename (id, telemetry, shares,
 *    embedding survive); a vanished path soft-deletes its row. Never touches
 *    a repo that has not adopted (`consoles/README.md` absent).
 * 3. DERIVATION. Description + embedding are derived from the file and
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
  ensureWorkspaceRepo,
  mirrorPushNow,
  queueMirrorPush,
  resolveMirrorTarget,
} from "./cloud-repo.service";
import { RepoRequiredError, appsRequireConnectedRepo } from "./config";
import {
  CONSOLES_README,
  CONSOLES_README_PATH,
  chartSidecarPath,
  consoleRepoPath,
  parseChartSpec,
  parseConsoleFile,
  parseConsoleRepoPath,
  serializeChartSpec,
  serializeConsoleFile,
  type ConsoleFileState,
  type ConsoleLanguage,
} from "./console-files";
import {
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  diffNameStatus,
  listTree,
  log as repoLog,
  readBlob,
  repoDirFor,
  repoExists,
  resolveCommit,
  type BlobMutation,
  type ChangedFile,
  type CommitInfo,
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
 */
export async function ensureFolderChain(
  segments: string[],
  workspaceId: string,
  scope: { access: ConsoleAccessLevel; ownerId?: string },
): Promise<Types.ObjectId | undefined> {
  const ws = new Types.ObjectId(workspaceId);
  let parentId: Types.ObjectId | undefined;
  for (const name of segments) {
    const parentFilter = parentId
      ? { parentId }
      : { $or: [{ parentId: null }, { parentId: { $exists: false } }] };
    let folder = await ConsoleFolder.findOne({
      workspaceId: ws,
      name,
      ...parentFilter,
    })
      .select("_id")
      .lean<{ _id: Types.ObjectId } | null>();
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
  return ensureWorkspaceRepo(workspaceId);
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
}): Promise<ConsoleCommitResult> {
  // Production: the workspace's own repo is the only durable store (§17).
  if (
    appsRequireConnectedRepo() &&
    !(await resolveMirrorTarget(input.workspaceId))
  ) {
    throw new RepoRequiredError();
  }
  const repoDir = await ensureConsolesRepo(input.workspaceId);
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
  });
  if (!result.unchanged) queueMirrorPush(input.workspaceId);
  return { commitOid: result.commitOid, unchanged: result.unchanged };
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
  });
  return { ...result, path, sourceBlobSha: blobOid(writes[path]) };
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
 * Re-project a set of rows whose paths changed together (folder rename or
 * move, folder access change). Each entry is the row's desired state plus
 * the path it currently occupies.
 */
export async function commitConsoleMoves(input: {
  workspaceId: string;
  rows: Array<{ id: string; row: RowLike; previousPath?: string | null }>;
  actorUserId?: string | null;
  message: string;
}): Promise<
  ConsoleCommitResult & {
    /** row id → where it now lives. */
    paths: Map<string, { path: string; sourceBlobSha: string }>;
  }
> {
  const folderCache = new Map<string, FolderLean | null>();
  const writes: Record<string, string> = {};
  const deletes: string[] = [];
  const paths = new Map<string, { path: string; sourceBlobSha: string }>();
  for (const { id, row, previousPath } of input.rows) {
    const path = await repoPathForRow(row, folderCache);
    const files = filesFor(path, fileStateFromRow(row));
    Object.assign(writes, files.writes);
    deletes.push(...files.deletes);
    if (previousPath && previousPath !== path) {
      deletes.push(previousPath, chartSidecarPath(previousPath));
    }
    paths.set(id, { path, sourceBlobSha: blobOid(files.writes[path]) });
  }
  // A path both written and deleted (A→B while another goes B→A) must end
  // up written: deletes are applied first by the index-info order.
  const finalDeletes = deletes.filter(d => !(d in writes));
  const result = await commitConsoleBatch({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    mutation: { writes, deletes: finalDeletes },
    message: input.message,
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

const syncChains = new Map<string, Promise<unknown>>();

/** Serialize per workspace: two rapid pushes must not interleave a sync. */
function serialized<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = syncChains.get(workspaceId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  syncChains.set(
    workspaceId,
    next.catch(() => undefined),
  );
  return next;
}

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
  return serialized(workspaceId, () => syncNow(workspaceId, userId));
}

async function syncNow(
  workspaceId: string,
  userId?: string,
): Promise<ConsoleSyncStats | null> {
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) return null;
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
  const rowByPath = new Map<string, IndexRow>();
  for (const r of rows) if (r.path) rowByPath.set(r.path, r);
  const seenRows = new Set<string>();
  const touched: IndexRow[] = [];
  const actor = userId && userId.length > 0 ? userId : "git";

  // Rows whose path is gone are rename candidates for new paths with the
  // same blob; anything unclaimed at the end is a deletion.
  const orphans = rows.filter(r => r.path && !byPath.has(r.path));
  const orphanByBlob = new Map<string, IndexRow[]>();
  for (const o of orphans) {
    if (!o.sourceBlobSha) continue;
    const list = orphanByBlob.get(o.sourceBlobSha) ?? [];
    list.push(o);
    orphanByBlob.set(o.sourceBlobSha, list);
  }

  for (const entry of consoleEntries) {
    const location = parseConsoleRepoPath(entry.path);
    if (!location) continue;
    const sidecar = byPath.get(chartSidecarPath(entry.path));
    let row = rowByPath.get(entry.path);

    if (!row) {
      const candidates = orphanByBlob.get(entry.oid);
      const moved = candidates?.shift();
      if (moved) {
        row = moved;
        stats.renamed++;
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
    if (contents === null) continue; // binary or unreadable: not a console
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
    // A folder that first appears from git belongs to whoever pushed it
    // (the console's owner), so they can rename or delete it later.
    const folderId = await ensureFolderChain(
      location.folderSegments,
      workspaceId,
      { access, ownerId },
    );

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
      mongoOptions: parsed.meta.mongoOptions ?? null,
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

    if (row) {
      await SavedConsole.updateOne(
        { _id: row._id },
        {
          $set: set,
          $inc: { version: 1, draftRevision: 1 },
          $unset: { deletedAt: "", ...scheduleSet.unset },
        },
      );
      const fresh = await SavedConsole.findById(row._id);
      if (fresh) touched.push(fresh);
      continue;
    }

    const created = await SavedConsole.create({
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
  }

  // Deletions: adopted repo, path gone, blob not claimed by a rename.
  for (const row of rows) {
    if (seenRows.has(row._id.toString())) continue;
    if (!row.path || byPath.has(row.path) || row.is_deleted) continue;
    await SavedConsole.updateOne(
      { _id: row._id },
      { $set: { is_deleted: true, deletedAt: new Date() } },
    );
    stats.deleted++;
    publishRealtimeEvent(workspaceId, {
      type: "console.deleted",
      consoleId: row._id.toString(),
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

async function sidecarMatches(
  sidecar: TreeEntry | undefined,
  chartSpec: Record<string, unknown> | undefined,
): Promise<boolean> {
  const rowHas = Boolean(chartSpec && Object.keys(chartSpec).length > 0);
  if (!sidecar) return !rowHas;
  if (!rowHas || !chartSpec) return false;
  return sidecar.oid === blobOid(serializeChartSpec(chartSpec));
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
function uniquePath(
  wanted: string,
  taken: Set<string>,
  ownPath: string | undefined | null,
): string {
  if (wanted === ownPath || !taken.has(wanted)) return wanted;
  const location = parseConsoleRepoPath(wanted);
  if (!location) return wanted;
  for (let i = 2; ; i++) {
    const candidate = consoleRepoPath({
      ...location,
      name: `${location.name} (${i})`,
    });
    if (candidate === ownPath || !taken.has(candidate)) return candidate;
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
  const previousPath = input.current?.path ?? null;
  const committed = await commitConsoleState({
    row,
    previousPath,
    actorUserId: input.actorUserId,
    message: input.message,
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

/** Commits that touched a console's file (renames included via its row path). */
export async function consoleHistory(
  row: Pick<ISavedConsole, "workspaceId" | "path">,
  limit = 50,
): Promise<CommitInfo[]> {
  if (!row.path) return [];
  const repoDir = repoDirFor(row.workspaceId.toString());
  if (!(await repoExists(repoDir))) return [];
  if (!(await resolveCommit(repoDir, MAIN))) return [];
  return repoLog(repoDir, MAIN, limit, row.path);
}

/** What one commit did to this console (its file and chart sidecar). */
export async function consoleCommitChanges(
  row: Pick<ISavedConsole, "workspaceId" | "path">,
  sha: string,
): Promise<{ sha: string; parent: string | null; files: ChangedFile[] }> {
  const repoDir = repoDirFor(row.workspaceId.toString());
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  const parent = await resolveCommit(repoDir, `${oid}^`);
  const all = await diffNameStatus(repoDir, parent ?? EMPTY_TREE, oid);
  const mine = new Set(row.path ? [row.path, chartSidecarPath(row.path)] : []);
  return { sha: oid, parent, files: all.filter(f => mine.has(f.path)) };
}

/** A repo path before and after one commit (null = absent on that side). */
export async function consoleFileVersions(
  row: Pick<ISavedConsole, "workspaceId">,
  sha: string,
  relPath: string,
): Promise<{ before: string | null; after: string | null; binary: boolean }> {
  const repoDir = repoDirFor(row.workspaceId.toString());
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  const parent = await resolveCommit(repoDir, `${oid}^`);
  const read = async (ref: string | null) => {
    if (!ref) return null;
    try {
      return await readBlob(repoDir, ref, relPath);
    } catch {
      return null;
    }
  };
  const [before, after] = await Promise.all([read(parent), read(oid)]);
  return {
    before: before?.isBinary ? null : (before?.contents ?? null),
    after: after?.isBinary ? null : (after?.contents ?? null),
    binary: Boolean(before?.isBinary || after?.isBinary),
  };
}

/**
 * Restore a console to its content at `sha` — a NEW commit, history is
 * append-only — and project the restored file back onto the row. The file
 * is read at the row's current path, or at the path the console had in
 * that commit when it has since moved.
 */
export async function restoreConsoleTo(
  row: ISavedConsole,
  sha: string,
  actorUserId: string,
): Promise<{ commitOid: string; unchanged: boolean }> {
  if (!row.path) throw new Error("This console has no file in the repo yet");
  const repoDir = repoDirFor(row.workspaceId.toString());
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  let at = row.path;
  let blob = await readBlob(repoDir, oid, at).catch(() => null);
  if (!blob) {
    // The console lived elsewhere at that commit: find its file by blob id
    // lineage is not tracked, so fall back to the commit's own touched path.
    const changes = await diffNameStatus(
      repoDir,
      (await resolveCommit(repoDir, `${oid}^`)) ?? EMPTY_TREE,
      oid,
    );
    const candidate = changes.find(
      f => parseConsoleRepoPath(f.path) && f.status !== "deleted",
    );
    if (candidate) {
      at = candidate.path;
      blob = await readBlob(repoDir, oid, at).catch(() => null);
    }
  }
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
  const repoDir = repoDirFor(row.workspaceId.toString());
  if (!(await repoExists(repoDir))) return null;
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
