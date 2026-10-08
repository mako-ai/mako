/**
 * Notebook checkpoints in the workspace repo (apps.md §24).
 *
 * The notebook STORE (GCS/filesystem) is the hot working copy — the editor
 * autosaves there on every patch, exactly like a sandbox working tree. Git
 * gets CHECKPOINTS: a debounced commit of the stripped `.deepnote` source
 * after edits go quiet (§19 rule 3 — granularity is per-surface, and a
 * commit per keystroke would be noise, not history). Nothing durable is
 * ever only in the timer: the store IS durable; the checkpoint is the
 * review/history/interop surface.
 *
 * Sync back: an external edit to a committed `.deepnote` file (laptop
 * clone, sandbox, PR merge) flows into the store on push — unless the live
 * document changed since its last checkpoint, in which case THE EDITOR
 * WINS: the store keeps the newer work, the external version stays in git
 * history, and the next checkpoint records the resolution. A hot-document
 * system must never clobber the screen someone is typing into.
 *
 * A file MOVED by that push (laptop `git mv`) is recognised by the notebook
 * id the file carries — never by content similarity — and its index row
 * re-keyed to the new path; the next checkpoint keeps that path as long as
 * the name is unchanged (`checkpointPathFor`). The notebook's id, shares
 * and `/n/<id>` links are untouched by a rename from any side.
 */
import { Types } from "mongoose";
import {
  NotebookIndex,
  type INotebookIndex,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { authorForUser } from "../apps/workspace-consoles.service";
import {
  ensureLocalRepo,
  freshenBeforeMainWrite,
  queueMirrorPush,
} from "../apps/cloud-repo.service";
import { RepoRequiredError } from "../apps/config";
import { boundRepoDirIfExists } from "../apps/workspace-repo-required";
import { createSerializer } from "../apps/serialized";
import {
  BlobPreconditionError,
  DEFAULT_BRANCH,
  blobOid,
  blobOidAt,
  commitBlobsOnBranch,
  diffNameStatus,
  listTree,
  logFollow,
  readBlob,
  readBlobsBatch,
  resolveCommit,
  type ChangedFile,
  type FollowedCommit,
} from "../apps/repository.service";
import { EMPTY_TREE } from "../apps/git";
import { publishRealtimeEvent } from "../services/realtime.service";
import { getWorkspaceRepo } from "../services/workspace-repos.service";
import { getNotebookStore } from "./store";
import {
  NOTEBOOK_FILE_EXTENSION,
  isNotebookRepoPath,
  notebookRepoPath,
  parseNotebookFile,
  serializeNotebookFile,
  slugifyNotebookName,
} from "./deepnote-file";
import type { NotebookDoc } from "./types";

const logger = loggers.api("notebook-git");
const MAIN_REF = `refs/heads/${DEFAULT_BRANCH}`;

/** Commit after this much quiet following an edit… */
const CHECKPOINT_DEBOUNCE_MS = 30_000;
/** …but never let a busy editor outrun history by more than this. */
const CHECKPOINT_MAX_WAIT_MS = 5 * 60_000;

async function repoDirIfExists(workspaceId: string): Promise<string | null> {
  // Leftover local git without a GitHub binding is not a repository
  // (issue #956). Checkpoints skip with no_repository instead of writing
  // into Cloud Storage. Bound but not yet cloned: restore the cache first.
  if (!(await getWorkspaceRepo(workspaceId))) return null;
  await ensureLocalRepo(workspaceId);
  return boundRepoDirIfExists(workspaceId);
}

/**
 * The first free `.deepnote` path for the notebook's name. Taken means:
 * another index row's path, a file at main that is not this notebook's
 * (a laptop-made notebook the index does not know yet — its file must not
 * be overwritten by a rename onto its name), or a path `reserved` by the
 * caller's own batch (adoption writes many notebooks in one commit).
 * Callers that are about to MOVE a file must freshen main first: this
 * reads the local tree, and a file this instance has not fetched is
 * invisible to it.
 */
async function uniqueNotebookPath(
  repoDir: string,
  index: INotebookIndex,
  reserved: ReadonlySet<string> = new Set(),
): Promise<string> {
  const base = slugifyNotebookName(index.name);
  const scope = { access: index.access, ownerId: index.ownerId };
  const candidates = [notebookRepoPath(base, scope)];
  for (let i = 2; i < 100; i++) {
    candidates.push(notebookRepoPath(`${base}-${i}`, scope));
  }
  // Past 98 namesakes — "Untitled notebook" is every new notebook's name —
  // a suffix from the notebook's own id is free by construction. Without
  // it the 100th namesake could never be checkpointed (no file, no
  // history) and a rename onto the name failed with a 500.
  const own = index.notebookId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  candidates.push(notebookRepoPath(`${base}-${own.slice(0, 12)}`, scope));
  candidates.push(notebookRepoPath(`${base}-${own}`, scope));
  // One index query and one batched read for every candidate (it was one
  // query and one git process per candidate tried: quadratic in the
  // number of namesakes).
  const claimed = new Set(
    (
      await NotebookIndex.find({
        workspaceId: index.workspaceId,
        path: { $in: candidates },
        notebookId: { $ne: index.notebookId },
      })
        .select("path")
        .lean<Array<{ path?: string }>>()
    ).map(r => r.path),
  );
  const head = await resolveCommit(repoDir, MAIN_REF);
  const atMain = head
    ? await readBlobsBatch(repoDir, head, candidates).catch(
        () => new Map<string, Buffer>(),
      )
    : new Map<string, Buffer>();
  for (const wanted of candidates) {
    if (reserved.has(wanted) || claimed.has(wanted)) continue;
    // A file at main that is not this notebook's (a laptop-made notebook
    // the index does not know yet) must not be overwritten.
    const buf = atMain.get(wanted);
    if (buf) {
      if (buf.includes(0)) continue;
      if (parseNotebookFile(buf.toString("utf8"))?.id !== index.notebookId) {
        continue;
      }
    }
    return wanted;
  }
  throw new Error(`No free path for notebook "${index.name}"`);
}

/**
 * Where the next checkpoint writes the file. The path is derived from the
 * name — but only when the name (or the access scope) CHANGED since the
 * file was last written at its current path. A file renamed from a laptop
 * (`git mv notebooks/a.deepnote notebooks/b.deepnote`, same inner name)
 * keeps its new path; recomputing it from the unchanged name would move
 * the file straight back on the next checkpoint and silently undo the
 * push.
 */
async function checkpointPathFor(
  repoDir: string,
  index: INotebookIndex,
): Promise<string> {
  if (!index.path) return uniqueNotebookPath(repoDir, index);
  const slug = index.path.slice(
    index.path.lastIndexOf("/") + 1,
    -NOTEBOOK_FILE_EXTENSION.length,
  );
  const scoped = notebookRepoPath(slug, {
    access: index.access,
    ownerId: index.ownerId,
  });
  if (scoped !== index.path) return uniqueNotebookPath(repoDir, index); // access flip
  const committed = await readBlob(repoDir, MAIN_REF, index.path).catch(
    () => null,
  );
  const committedName =
    committed && !committed.isBinary
      ? parseNotebookFile(committed.contents)?.name
      : undefined;
  return committedName === index.name
    ? index.path
    : uniqueNotebookPath(repoDir, index);
}

/**
 * Commit the notebook's current store document as its `.deepnote` file,
 * reconciling the path (rename/access moves the file in the same commit).
 * No-op when the serialized source is byte-identical to the last checkpoint.
 */
export function checkpointNotebook(
  workspaceId: string,
  notebookId: string,
  actorUserId?: string,
): ReturnType<typeof checkpointNotebookNow> {
  // One checkpoint at a time per workspace: two renames of one notebook
  // checkpointing at once each moved the file from the same old path to
  // their own new one — the delete of the old path is no CAS — and left
  // TWO files carrying one notebook id. Serialized, the second reads the
  // first's result (and the old-path expectation below holds the line
  // across instances).
  return serializedCheckpoints(workspaceId, () =>
    checkpointNotebookNow(workspaceId, notebookId, actorUserId),
  );
}

const serializedCheckpoints = createSerializer();

async function checkpointNotebookNow(
  workspaceId: string,
  notebookId: string,
  actorUserId?: string,
): Promise<{
  committed: boolean;
  commitOid?: string;
  /**
   * `no_repository`: nothing to commit into. `target_taken`: the move's
   * target path appeared between the name choice and the commit (the
   * compare-and-swap refused it); the next checkpoint picks another name.
   */
  skippedReason?: "no_repository" | "target_taken";
}> {
  const repoDir = await repoDirIfExists(workspaceId);
  if (repoDir == null) {
    logger.warn("Notebook checkpoint not committed — connect a repository", {
      workspaceId,
      notebookId,
    });
    return { committed: false, skippedReason: "no_repository" };
  }
  const [doc, index] = await Promise.all([
    getNotebookStore().get(workspaceId, notebookId),
    NotebookIndex.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      notebookId,
    }),
  ]);
  if (!doc || !index) return { committed: false };

  // The index row's name is authoritative for the tree; keep the doc's copy
  // in the file so the file stands alone.
  const contents = serializeNotebookFile({ ...doc, name: index.name });
  const sha = blobOid(contents);
  let wantedPath = await checkpointPathFor(repoDir, index);
  if (wantedPath !== index.path) {
    // A MOVE chooses its name against main, so main must be the mirror's,
    // not whatever this instance last fetched: a laptop-pushed notebook
    // already sitting at the target name must count as taken. (The
    // compare-and-swap below compares against the LOCAL head; a stale one
    // would let the commit overwrite that file.) Plain checkpoints keep
    // their path and stay fetch-free — the debounce makes them frequent.
    await freshenBeforeMainWrite(workspaceId);
    wantedPath = await checkpointPathFor(repoDir, index);
  }
  if (index.checkpointBlobSha === sha && index.path === wantedPath) {
    return { committed: false };
  }

  const deletes =
    index.path && index.path !== wantedPath ? [index.path] : undefined;
  // Writing to a path this notebook does not hold yet — a move, OR its
  // very first checkpoint — must find that path free at commit time: a
  // file that lands there between the unique-name check and the commit
  // (a laptop push) is not overwritten; the next checkpoint picks the
  // next free name.
  const newPath = wantedPath !== index.path;
  // A move also expects the file it moves FROM to be the one read now: a
  // checkpoint on another instance that moved it meanwhile refuses this
  // one (`target_taken`, retried from the fresh index) instead of leaving
  // a second copy behind.
  const expectBlobs: Record<string, string | null> = {};
  if (newPath) expectBlobs[wantedPath] = null;
  if (deletes?.length && index.path) {
    expectBlobs[index.path] = await blobOidAt(repoDir, MAIN_REF, index.path);
  }
  let result: Awaited<ReturnType<typeof commitBlobsOnBranch>>;
  try {
    result = await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes: { [wantedPath]: contents }, deletes },
      {
        message: deletes?.length
          ? `notebook: move to ${wantedPath}`
          : `notebook: checkpoint "${index.name}"`,
        author: actorUserId ? await authorForUser(actorUserId) : undefined,
        expectBlobs: Object.keys(expectBlobs).length ? expectBlobs : undefined,
      },
    );
  } catch (error) {
    if (error instanceof BlobPreconditionError) {
      logger.warn("Notebook checkpoint refused: target path appeared", {
        workspaceId,
        notebookId,
        path: wantedPath,
      });
      return { committed: false, skippedReason: "target_taken" };
    }
    throw error;
  }
  index.path = wantedPath;
  index.checkpointBlobSha = sha;
  await index.save();
  queueMirrorPush(workspaceId);
  return { committed: true, commitOid: result.commitOid };
}

/**
 * A deleted notebook's index row and its file, as they are NOW: inside the
 * checkpoint queue, so a rename's checkpoint that moves the file cannot
 * interleave — the path is read here, at removal time, never earlier. (The
 * route read it before deleting the store document: a rename landing in
 * between moved the file, the delete removed the old path — nothing — and
 * the moved file stayed on main for good, carrying the deleted notebook's
 * id.) A checkpoint queued after this one finds no index and writes
 * nothing.
 */
export function removeNotebookIndexAndFile(
  workspaceId: string,
  notebookId: string,
  actorUserId?: string,
): Promise<void> {
  return serializedCheckpoints(workspaceId, async () => {
    const index = await NotebookIndex.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      notebookId,
    }).select("path name");
    await NotebookIndex.deleteOne({
      workspaceId: new Types.ObjectId(workspaceId),
      notebookId,
    });
    if (index?.path) {
      await removeNotebookFile(workspaceId, index, actorUserId).catch(error => {
        logger.warn("Deleted notebook's file could not be removed", {
          workspaceId,
          notebookId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });
}

/** Remove the notebook's file when the notebook itself is deleted. */
export async function removeNotebookFile(
  workspaceId: string,
  index: Pick<INotebookIndex, "path" | "name">,
  actorUserId?: string,
): Promise<void> {
  if (!index.path) return;
  const repoDir = await repoDirIfExists(workspaceId);
  if (repoDir == null) {
    logger.warn("Notebook file not deleted from git — connect a repository", {
      workspaceId,
      path: index.path,
    });
    return;
  }
  await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    { deletes: [index.path] },
    {
      message: `notebook: delete "${index.name}"`,
      author: actorUserId ? await authorForUser(actorUserId) : undefined,
    },
  );
  queueMirrorPush(workspaceId);
}

// ---------------------------------------------------------------------------
// Debounced checkpoint scheduling
// ---------------------------------------------------------------------------

interface PendingCheckpoint {
  timer: NodeJS.Timeout;
  firstScheduledAt: number;
  actorUserId?: string;
}

const pending = new Map<string, PendingCheckpoint>();

function keyFor(workspaceId: string, notebookId: string): string {
  return `${workspaceId}:${notebookId}`;
}

/**
 * Schedule a checkpoint after the edit burst goes quiet. Losing a timer
 * (instance recycle) loses no data — the store holds the truth and the next
 * edit reschedules; the checkpoint arrives one burst later.
 */
export function scheduleNotebookCheckpoint(
  workspaceId: string,
  notebookId: string,
  actorUserId?: string,
): void {
  const key = keyFor(workspaceId, notebookId);
  const existing = pending.get(key);
  const firstScheduledAt = existing?.firstScheduledAt ?? Date.now();
  if (existing) clearTimeout(existing.timer);

  const waited = Date.now() - firstScheduledAt;
  const delay = Math.max(
    1_000,
    Math.min(CHECKPOINT_DEBOUNCE_MS, CHECKPOINT_MAX_WAIT_MS - waited),
  );
  const timer = setTimeout(() => {
    pending.delete(key);
    void checkpointNotebook(workspaceId, notebookId, actorUserId).catch(
      error => {
        logger.warn("Notebook checkpoint failed", {
          workspaceId,
          notebookId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, delay);
  timer.unref?.();
  pending.set(key, {
    timer,
    firstScheduledAt,
    actorUserId: actorUserId ?? existing?.actorUserId,
  });
}

/** Flush a pending checkpoint immediately (delete/close paths). */
export async function flushNotebookCheckpoint(
  workspaceId: string,
  notebookId: string,
): Promise<void> {
  const key = keyFor(workspaceId, notebookId);
  const entry = pending.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(key);
  await checkpointNotebook(workspaceId, notebookId, entry.actorUserId).catch(
    () => undefined,
  );
}

// ---------------------------------------------------------------------------
// Push-sync: external .deepnote edits flow into the store
// ---------------------------------------------------------------------------

const syncInFlight = new Map<string, Promise<void>>();

export async function syncNotebooksFromRepo(
  workspaceId: string,
  actorUserId?: string,
): Promise<void> {
  const running = syncInFlight.get(workspaceId);
  if (running) return running;
  const run = syncNotebooksNow(workspaceId, actorUserId).finally(() => {
    syncInFlight.delete(workspaceId);
  });
  syncInFlight.set(workspaceId, run);
  return run;
}

async function syncNotebooksNow(
  workspaceId: string,
  actorUserId?: string,
): Promise<void> {
  const repoDir = await repoDirIfExists(workspaceId);
  if (repoDir == null) return;
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!head) return;
  const paths = (await listTree(repoDir, head))
    .map(e => e.path)
    .filter(isNotebookRepoPath);
  if (paths.length === 0) return;

  // Index rows whose file is gone from the tree: a laptop rename's "from"
  // side. A file at a path no row claims is matched against them below by
  // the notebook id the file carries and re-keyed in place, so `/n/<id>`
  // and the row's shares survive a `git mv` (brief rule 3). Rows nothing
  // claims keep their stale path: their store document is untouched (a
  // push never deletes a notebook).
  const present = new Set(paths);
  const vanished = (
    await NotebookIndex.find({
      workspaceId: new Types.ObjectId(workspaceId),
      path: { $exists: true, $ne: null },
    })
  ).filter(row => row.path && !present.has(row.path));

  const store = getNotebookStore();
  for (const path of paths) {
    try {
      let index = await NotebookIndex.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        path,
      });

      const blob = await readBlob(repoDir, head, path);
      if (blob.isBinary) continue;
      const parsed = parseNotebookFile(blob.contents);

      if (!index) {
        // A `.deepnote` file always carries its notebook id (the schema
        // rejects one without), and that id is the WHOLE answer: the file
        // is the vanished row with that id, or a notebook Mako does not
        // know. Content similarity is never consulted — a different id
        // merely similar to a row whose file vanished long ago must not
        // take over that row and its live store document.
        const candidate = parsed?.id
          ? vanished.find(row => row.notebookId === parsed.id)
          : undefined;
        // Files with no index row and no vanished row to inherit are
        // externally-created notebooks; creating store documents for them
        // is a follow-up (the store API cannot yet create with a
        // caller-chosen id). Skip quietly.
        if (!candidate) continue;
        vanished.splice(vanished.indexOf(candidate), 1);
        candidate.path = path;
        await candidate.save();
        index = candidate;
        logger.info("Notebook file rename detected by id; row re-keyed", {
          workspaceId,
          notebookId: index.notebookId,
          path,
        });
      }

      const sha = blobOid(blob.contents);
      if (index.checkpointBlobSha === sha) continue; // level already

      if (!parsed) {
        logger.warn("Invalid .deepnote file; keeping current notebook", {
          workspaceId,
          path,
        });
        continue;
      }

      const doc = await store.get(workspaceId, index.notebookId);
      if (!doc) continue;
      // Conflict guard: if the live document moved past its last checkpoint,
      // the editor wins — git history keeps the external version, and the
      // next checkpoint records the live state.
      const liveSha = blobOid(
        serializeNotebookFile({ ...doc, name: index.name }),
      );
      if (index.checkpointBlobSha && liveSha !== index.checkpointBlobSha) {
        logger.warn(
          "External notebook edit skipped: live document has newer changes",
          { workspaceId, path },
        );
        continue;
      }

      const updated = await store.update(workspaceId, index.notebookId, {
        name: parsed.name,
        blocks: parsed.blocks,
      });
      if (!updated) continue;
      index.name = parsed.name;
      index.checkpointBlobSha = sha;
      await index.save();
      publishRealtimeEvent(workspaceId, {
        type: "notebook.updated",
        notebookId: index.notebookId,
        version: updated.version,
        updatedBy: actorUserId ?? "git",
        origin: "save",
      });
      logger.info("Notebook synced from repo", { workspaceId, path });
    } catch (error) {
      logger.warn("Notebook sync failed for path", {
        workspaceId,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Adoption (migration path)
// ---------------------------------------------------------------------------

/**
 * Checkpoint every notebook of a repo-holding workspace in ONE commit.
 * Re-runnable: already-checkpointed notebooks are skipped by sha.
 */
export async function adoptWorkspaceNotebooks(workspaceId: string): Promise<{
  notebooks: number;
  written: number;
}> {
  const repoDir = await repoDirIfExists(workspaceId);
  if (repoDir == null) return { notebooks: 0, written: 0 };
  // Names are chosen against main: see it as the mirror has it.
  await freshenBeforeMainWrite(workspaceId);
  const store = getNotebookStore();
  const indexes = await NotebookIndex.find({
    workspaceId: new Types.ObjectId(workspaceId),
  });
  const writes: Record<string, string> = {};
  const stamps: Array<{ index: INotebookIndex; path: string; sha: string }> =
    [];
  // Paths chosen earlier in this batch: two unadopted notebooks with one
  // name must not be written to one file, the second replacing the first.
  const reserved = new Set<string>();
  for (const index of indexes) {
    const doc = await store.get(workspaceId, index.notebookId);
    if (!doc) continue;
    const contents = serializeNotebookFile({
      ...(doc as NotebookDoc),
      name: index.name,
    });
    const sha = blobOid(contents);
    if (index.checkpointBlobSha === sha && index.path) continue;
    const path = await uniqueNotebookPath(repoDir, index, reserved);
    reserved.add(path);
    writes[path] = contents;
    stamps.push({ index, path, sha });
  }
  if (Object.keys(writes).length > 0) {
    await commitBlobsOnBranch(
      repoDir,
      DEFAULT_BRANCH,
      { writes },
      {
        message: `notebook: adopt ${Object.keys(writes).length} notebooks into git (apps.md §24)`,
      },
    );
    for (const { index, path, sha } of stamps) {
      index.path = path;
      index.checkpointBlobSha = sha;
      await index.save();
    }
    queueMirrorPush(workspaceId);
  }
  return { notebooks: indexes.length, written: Object.keys(writes).length };
}

// ---------------------------------------------------------------------------
// History: the SAME shapes the apps/consoles History popover consumes
// (apps.md §24) — one component, three content kinds.
// ---------------------------------------------------------------------------

/**
 * This notebook's own commits, newest first — ACROSS its renames (a rename
 * is a checkpoint that moves the file; `git log --follow` carries the
 * history through it, and through a laptop `git mv`). Each says where the
 * file was in that commit. The walk ends at the file's creation: never the
 * notebook that held its name before (deleted, or renamed away — a reused
 * name), nor a file it was copied from (`parseFollowLog`). Read by PATH
 * alone, a renamed notebook's history started at the rename, and a new
 * notebook at an old name listed — and diffed, and restored — the old
 * one's commits.
 */
export async function notebookHistory(
  index: Pick<INotebookIndex, "workspaceId" | "path">,
  limit = 50,
): Promise<FollowedCommit[]> {
  if (!index.path) return [];
  const repoDir = await boundRepoDirIfExists(index.workspaceId.toString());
  if (repoDir == null) return [];
  if (!(await resolveCommit(repoDir, MAIN_REF))) return [];
  return logFollow(repoDir, MAIN_REF, limit, index.path);
}

/**
 * A commit or path the notebook history routes may not read through this
 * notebook: not one of its own commits, or not its file at that commit.
 */
export class NotThisNotebookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotThisNotebookError";
  }
}

/** This notebook's entry for commit `oid` in its own history, or null. */
async function notebookPathsAt(
  repoDir: string,
  index: Pick<INotebookIndex, "path">,
  oid: string,
): Promise<FollowedCommit | null> {
  if (!index.path) return null;
  const lineage = await logFollow(repoDir, MAIN_REF, 200, index.path);
  return lineage.find(c => c.oid === oid) ?? null;
}

/** A `.deepnote` text that is ANOTHER notebook's (it carries another id). */
function carriesOtherNotebook(
  contents: string | null | undefined,
  notebookId: string,
): boolean {
  if (!contents) return false;
  const id = parseNotebookFile(contents)?.id;
  return Boolean(id) && id !== notebookId;
}

/** What one commit did to this notebook's file (under the name it had then). */
export async function notebookCommitChanges(
  index: Pick<INotebookIndex, "workspaceId" | "path">,
  sha: string,
): Promise<{ sha: string; parent: string | null; files: ChangedFile[] }> {
  const repoDir = await boundRepoDirIfExists(index.workspaceId.toString());
  if (repoDir == null) throw new Error(`No such commit: ${sha}`);
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  const parent = await resolveCommit(repoDir, `${oid}^`);
  const at = await notebookPathsAt(repoDir, index, oid);
  if (!at) return { sha: oid, parent, files: [] };
  const all = await diffNameStatus(repoDir, parent ?? EMPTY_TREE, oid);
  const mine = new Set(
    [at.path, at.previousPath].filter((p): p is string => Boolean(p)),
  );
  return { sha: oid, parent, files: all.filter(f => mine.has(f.path)) };
}

/**
 * This notebook's file before and after one of ITS commits (null = absent
 * on that side). `relPath` must be the name the file had in that commit
 * (or the name it moved from, on the commit that moved it) — never any
 * other repo path: this route used to read ANY file at any commit for
 * anyone who could open one notebook (a member's private console, another
 * member's private notebook). Throws `NotThisNotebookError` otherwise.
 */
export async function notebookFileVersions(
  index: Pick<INotebookIndex, "workspaceId" | "path" | "notebookId">,
  sha: string,
  relPath: string,
): Promise<{ before: string | null; after: string | null; binary: boolean }> {
  const repoDir = await boundRepoDirIfExists(index.workspaceId.toString());
  if (repoDir == null) throw new Error(`No such commit: ${sha}`);
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);
  const parent = await resolveCommit(repoDir, `${oid}^`);
  const at = await notebookPathsAt(repoDir, index, oid);
  let paths: { beforePath: string | null; afterPath: string | null } | null =
    null;
  if (at) {
    const before = at.created ? null : (at.previousPath ?? at.path);
    if (relPath === at.path) paths = { beforePath: before, afterPath: at.path };
    else if (at.previousPath && relPath === at.previousPath) {
      paths = { beforePath: at.previousPath, afterPath: null };
    }
  } else if (
    index.path &&
    relPath === index.path &&
    oid === (await resolveCommit(repoDir, MAIN_REF))
  ) {
    // The head did not touch this notebook: its file as it is now.
    paths = { beforePath: relPath, afterPath: relPath };
  }
  if (!paths) {
    throw new NotThisNotebookError("Path is not this notebook at that commit");
  }
  const read = async (ref: string | null, rel: string | null) => {
    if (!ref || !rel) return null;
    try {
      return await readBlob(repoDir, ref, rel);
    } catch {
      return null;
    }
  };
  const [beforeBlob, afterBlob] = await Promise.all([
    read(parent, paths.beforePath),
    read(oid, paths.afterPath),
  ]);
  const text = (b: Awaited<ReturnType<typeof read>>) =>
    b && !b.isBinary && !carriesOtherNotebook(b.contents, index.notebookId)
      ? b.contents
      : null;
  return {
    before: text(beforeBlob),
    after: text(afterBlob),
    binary: Boolean(beforeBlob?.isBinary || afterBlob?.isBinary),
  };
}

/**
 * Restore the notebook to its content at `sha`: the parsed blocks are
 * written to the STORE (the hot layer stays authoritative for what the
 * editor shows), then checkpointed as a NEW commit — history is
 * append-only, so restoring is never destructive.
 */
export async function restoreNotebookTo(
  workspaceId: string,
  notebookId: string,
  sha: string,
  actorUserId: string,
): Promise<{ commitOid?: string; restoredFrom: string }> {
  const index = await NotebookIndex.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
    notebookId,
  });
  if (!index?.path) {
    throw new Error("This notebook has no file in the repo yet");
  }
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) throw new RepoRequiredError();
  const oid = await resolveCommit(repoDir, sha);
  if (!oid) throw new Error(`No such commit: ${sha}`);

  // Only one of ITS OWN commits, read under the name the file had then
  // (it may have moved since). The fallback this replaced — "the notebook
  // file this commit touched" — restored ANOTHER notebook's file (a
  // member's private one, by the sha of its checkpoint) into this one.
  const then = await notebookPathsAt(repoDir, index, oid);
  if (!then) {
    throw new NotThisNotebookError(
      "That commit is not in this notebook's history",
    );
  }
  const blob = await readBlob(repoDir, oid, then.path).catch(() => null);
  if (!blob || blob.isBinary) {
    throw new Error("That commit has no readable version of this notebook");
  }
  const parsed = parseNotebookFile(blob.contents);
  if (!parsed) throw new Error("That version is not a valid .deepnote file");
  if (parsed.id && parsed.id !== notebookId) {
    throw new NotThisNotebookError(
      "That commit is not in this notebook's history",
    );
  }

  const updated = await getNotebookStore().update(workspaceId, notebookId, {
    name: parsed.name,
    blocks: parsed.blocks,
  });
  if (!updated) throw new Error("Notebook not found");
  if (parsed.name && parsed.name !== index.name) {
    index.name = parsed.name;
    await index.save();
  }
  publishRealtimeEvent(workspaceId, {
    type: "notebook.updated",
    notebookId,
    version: updated.version,
    updatedBy: actorUserId,
    origin: "save",
  });
  const result = await checkpointNotebook(workspaceId, notebookId, actorUserId);
  logger.info("Notebook restored from commit", {
    workspaceId,
    notebookId,
    sha: oid,
  });
  return {
    commitOid: result.committed ? oid : undefined,
    restoredFrom: oid,
  };
}
