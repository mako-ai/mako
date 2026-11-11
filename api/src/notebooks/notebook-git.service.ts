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
 * A file MOVED by a push (`git mv` on a laptop) is recognised by the
 * notebook id the file carries — never by how similar it looks — and its
 * index row follows it; the next checkpoint keeps that path for as long as
 * the name is unchanged. The notebook's id, shares and `/n/<id>` links are
 * untouched by a rename from any side.
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
import { createSerializer } from "../apps/serialized";
import { RepoRequiredError } from "../apps/config";
import { boundRepoDirIfExists } from "../apps/workspace-repo-required";
import {
  NotEntityPathError,
  followedCommitChanges,
  followedFileVersions,
  followedHistory,
  followedPathAt,
  type CommitChanges,
  type FileVersions,
  type FollowedFile,
} from "../apps/entity-git-history";
import {
  BlobPreconditionError,
  DEFAULT_BRANCH,
  blobOid,
  blobOidAt,
  commitBlobsOnBranch,
  listTree,
  readBlob,
  readBlobsBatch,
  resolveCommit,
  type FollowedCommit,
} from "../apps/repository.service";
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

import { ownerDirectoryFor } from "../apps/user-handles.service";

const logger = loggers.api("notebook-git");
const MAIN_REF = `refs/heads/${DEFAULT_BRANCH}`;

/**
 * One checkpoint, or one removal, at a time per workspace. Two renames of
 * one notebook checkpointing at once each moved the file from the same old
 * path to their own new one and left two files carrying one notebook id;
 * a delete that read the path before a rename's checkpoint moved the file
 * removed nothing and left the moved file on main. Queued, each reads what
 * the one before it wrote.
 */
const serializedCheckpoints = createSerializer();

/**
 * Test seam: runs inside the queue, after a checkpoint has chosen its path
 * and before it commits. Never set outside tests.
 */
export const notebookCheckpointHooks: { beforeCommit?: () => Promise<void> } =
  {};

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
 * The first free `.deepnote` path for the notebook's name. Taken means
 * another index row's path, or a file at main that is not this notebook's
 * (one made on a laptop that the index does not know yet must not be
 * overwritten by a rename onto its name). Past the numbered names, a
 * suffix from the notebook's own id is free by construction.
 */
async function uniqueNotebookPath(
  repoDir: string,
  index: INotebookIndex,
): Promise<string> {
  const base = slugifyNotebookName(index.name);
  const ownerHandle =
    index.access === "private"
      ? (
          await ownerDirectoryFor(index.workspaceId.toString(), index.ownerId)
        ).handleOf(index.ownerId)
      : undefined;
  const at = (slug: string) =>
    notebookRepoPath(slug, { access: index.access, ownerHandle });
  const own = index.notebookId.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const candidates = [
    at(base),
    ...Array.from({ length: 98 }, (_, i) => at(`${base}-${i + 2}`)),
    at(`${base}-${own}`),
  ];
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
    if (claimed.has(wanted)) continue;
    const buf = atMain.get(wanted);
    if (
      buf &&
      (buf.includes(0) ||
        parseNotebookFile(buf.toString("utf8"))?.id !== index.notebookId)
    ) {
      continue;
    }
    return wanted;
  }
  throw new Error(`No free path for notebook "${index.name}"`);
}

/**
 * Where the next checkpoint writes the file. The path is derived from the
 * name — but only when the name, or who can see the notebook, changed
 * since the file was last written where it is. A file renamed on a laptop
 * (`git mv`, same name inside) keeps its new path: deriving it again from
 * the unchanged name would move the file straight back on the next
 * checkpoint.
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
  const ownerHandle =
    index.access === "private"
      ? (
          await ownerDirectoryFor(index.workspaceId.toString(), index.ownerId)
        ).handleOf(index.ownerId)
      : undefined;
  const inPlace = notebookRepoPath(slug, { access: index.access, ownerHandle });
  if (inPlace !== index.path) return uniqueNotebookPath(repoDir, index);
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

export interface CheckpointResult {
  committed: boolean;
  commitOid?: string;
  /**
   * `no_repository`: nothing to commit into. `target_taken`: the path the
   * file was moving to appeared (or the file it was moving from changed)
   * between the choice and the commit; the next checkpoint chooses again.
   */
  skippedReason?: "no_repository" | "target_taken";
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
): Promise<CheckpointResult> {
  return serializedCheckpoints(workspaceId, () =>
    checkpointNotebookNow(workspaceId, notebookId, actorUserId),
  );
}

async function checkpointNotebookNow(
  workspaceId: string,
  notebookId: string,
  actorUserId?: string,
): Promise<CheckpointResult> {
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
  // No index row: the notebook was deleted — nothing is written for it.
  if (!doc || !index) return { committed: false };

  // The index row's name is authoritative for the tree; keep the doc's copy
  // in the file so the file stands alone.
  const contents = serializeNotebookFile({ ...doc, name: index.name });
  const sha = blobOid(contents);
  let wantedPath = await checkpointPathFor(repoDir, index);
  if (wantedPath !== index.path) {
    // A move chooses its name against main, so main must be the mirror's:
    // a notebook pushed from a laptop onto the target name counts as
    // taken. Plain checkpoints keep their path and stay fetch-free.
    await freshenBeforeMainWrite(workspaceId);
    wantedPath = await checkpointPathFor(repoDir, index);
  }
  if (index.checkpointBlobSha === sha && index.path === wantedPath) {
    return { committed: false };
  }

  const moving = wantedPath !== index.path;
  const deletes = moving && index.path ? [index.path] : undefined;
  // A path this notebook does not hold yet must be free when the commit
  // lands, and the file it moves from must be the one read now.
  const expectBlobs: Record<string, string | null> = {};
  if (moving) {
    // Absent, or this notebook's own file there already — as just read.
    expectBlobs[wantedPath] = await blobOidAt(repoDir, MAIN_REF, wantedPath);
  }
  if (deletes && index.path) {
    expectBlobs[index.path] = await blobOidAt(repoDir, MAIN_REF, index.path);
  }
  await notebookCheckpointHooks.beforeCommit?.();
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
        expectBlobs: moving ? expectBlobs : undefined,
      },
    );
  } catch (error) {
    if (!(error instanceof BlobPreconditionError)) throw error;
    logger.warn("Notebook checkpoint refused: its target path was taken", {
      workspaceId,
      notebookId,
      path: wantedPath,
    });
    return { committed: false, skippedReason: "target_taken" };
  }
  index.path = wantedPath;
  index.checkpointBlobSha = sha;
  await index.save();
  queueMirrorPush(workspaceId);
  return { committed: true, commitOid: result.commitOid };
}

/**
 * Delete a notebook's index row and its file, where the file is NOW: in
 * the checkpoint queue, so a rename's checkpoint that moves the file
 * cannot run in between — the path is read here, at removal time. (Read
 * before the delete began, a rename landing in between moved the file; the
 * delete then removed the old path — nothing — and the moved file stayed
 * on main carrying the deleted notebook's id.) A checkpoint queued after
 * this finds no row and writes nothing.
 */
export function removeNotebookIndexAndFile(
  workspaceId: string,
  notebookId: string,
  actorUserId?: string,
): Promise<void> {
  return serializedCheckpoints(workspaceId, async () => {
    const filter = {
      workspaceId: new Types.ObjectId(workspaceId),
      notebookId,
    };
    const index = await NotebookIndex.findOne(filter).select("path name");
    await NotebookIndex.deleteOne(filter);
    if (!index?.path) return;
    await removeNotebookFile(workspaceId, index, actorUserId).catch(error => {
      logger.warn("A deleted notebook's file could not be removed", {
        workspaceId,
        notebookId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
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

  // Index rows whose file is gone from the tree: the "from" side of a
  // rename made on a laptop. A file at a path no row holds is matched to
  // them below by the notebook id it carries, and the row follows it.
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
        // The id in the file is the whole answer: it is the vanished row
        // with that id, or a notebook Mako does not know. Similar content
        // under another id never takes over a row and its live document.
        const moved = parsed?.id
          ? vanished.find(row => row.notebookId === parsed.id)
          : undefined;
        // Files with no index row are externally-created notebooks; creating
        // store documents for them is a follow-up (the store API cannot yet
        // create with a caller-chosen id). Skip quietly.
        if (!moved) continue;
        vanished.splice(vanished.indexOf(moved), 1);
        moved.path = path;
        await moved.save();
        index = moved;
        publishRealtimeEvent(workspaceId, { type: "notebook.tree.updated" });
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
  const store = getNotebookStore();
  const indexes = await NotebookIndex.find({
    workspaceId: new Types.ObjectId(workspaceId),
  });
  const writes: Record<string, string> = {};
  const stamps: Array<{ index: INotebookIndex; path: string; sha: string }> =
    [];
  for (const index of indexes) {
    const doc = await store.get(workspaceId, index.notebookId);
    if (!doc) continue;
    const contents = serializeNotebookFile({
      ...(doc as NotebookDoc),
      name: index.name,
    });
    const sha = blobOid(contents);
    if (index.checkpointBlobSha === sha && index.path) continue;
    const path = await uniqueNotebookPath(repoDir, index);
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
// (apps.md §24) — reads shared via entity-git-history.
// ---------------------------------------------------------------------------

type HistoryIndex = Pick<INotebookIndex, "workspaceId" | "path">;

/** A notebook as one file followed across its renames. */
function notebookFile(index: HistoryIndex): FollowedFile {
  return { workspaceId: index.workspaceId.toString(), path: index.path };
}

/**
 * This notebook's own commits, newest first, across its renames (a rename
 * is a checkpoint that moves the file, or a `git mv` on a laptop). Each
 * says where the file was. The walk ends at the file's creation: never the
 * notebook that held its name before.
 */
export async function notebookHistory(
  index: HistoryIndex,
  limit = 50,
): Promise<FollowedCommit[]> {
  return followedHistory(notebookFile(index), limit);
}

/** What one commit did to this notebook's file (under the name it had then). */
export async function notebookCommitChanges(
  index: HistoryIndex,
  sha: string,
): Promise<CommitChanges> {
  return followedCommitChanges(notebookFile(index), sha);
}

/**
 * The notebook's file before and after one of ITS commits. Any other path
 * or commit throws {@link NotEntityPathError}: the repo also holds other
 * members' private files, and this route must not read them.
 */
export async function notebookFileVersions(
  index: HistoryIndex,
  sha: string,
  relPath?: string,
): Promise<FileVersions> {
  return followedFileVersions(notebookFile(index), sha, relPath);
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

  // One of ITS OWN commits, read under the name the file had then.
  const at = await followedPathAt(notebookFile(index), oid);
  if (!at) throw new NotEntityPathError(index.path);
  const blob = await readBlob(repoDir, oid, at).catch(() => null);
  if (!blob || blob.isBinary) {
    throw new Error("That commit has no readable version of this notebook");
  }
  const parsed = parseNotebookFile(blob.contents);
  if (!parsed) throw new Error("That version is not a valid .deepnote file");
  if (parsed.id && parsed.id !== notebookId) {
    throw new NotEntityPathError(at);
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
