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
 */
import { Types } from "mongoose";
import {
  NotebookIndex,
  type INotebookIndex,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { authorForUser } from "../apps/workspace-consoles.service";
import { ensureLocalRepo, queueMirrorPush } from "../apps/cloud-repo.service";
import {
  DEFAULT_BRANCH,
  blobOid,
  commitBlobsOnBranch,
  listTree,
  readBlob,
  repoDirFor,
  repoExists,
  resolveCommit,
} from "../apps/repository.service";
import { publishRealtimeEvent } from "../services/realtime.service";
import { getNotebookStore } from "./store";
import {
  isNotebookRepoPath,
  notebookRepoPath,
  parseNotebookFile,
  serializeNotebookFile,
  slugifyNotebookName,
} from "./deepnote-file";
import type { NotebookDoc } from "./types";

const logger = loggers.api("notebook-git");

/** Commit after this much quiet following an edit… */
const CHECKPOINT_DEBOUNCE_MS = 30_000;
/** …but never let a busy editor outrun history by more than this. */
const CHECKPOINT_MAX_WAIT_MS = 5 * 60_000;

async function repoDirIfExists(workspaceId: string): Promise<string | null> {
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  return (await repoExists(repoDir)) ? repoDir : null;
}

async function uniqueNotebookPath(
  workspaceId: string,
  index: INotebookIndex,
): Promise<string> {
  const base = slugifyNotebookName(index.name);
  let slug = base;
  for (let i = 2; i < 100; i++) {
    const wanted = notebookRepoPath(slug, {
      access: index.access,
      ownerId: index.ownerId,
    });
    const clash = await NotebookIndex.findOne({
      workspaceId: index.workspaceId,
      path: wanted,
      notebookId: { $ne: index.notebookId },
    }).select("_id");
    if (!clash) return wanted;
    slug = `${base}-${i}`;
  }
  throw new Error(`No free path for notebook "${index.name}"`);
}

/**
 * Commit the notebook's current store document as its `.deepnote` file,
 * reconciling the path (rename/access moves the file in the same commit).
 * No-op when the serialized source is byte-identical to the last checkpoint.
 */
export async function checkpointNotebook(
  workspaceId: string,
  notebookId: string,
  actorUserId?: string,
): Promise<{ committed: boolean }> {
  const repoDir = await repoDirIfExists(workspaceId);
  if (!repoDir) return { committed: false };
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
  const wantedPath = await uniqueNotebookPath(workspaceId, index);
  if (index.checkpointBlobSha === sha && index.path === wantedPath) {
    return { committed: false };
  }

  const deletes =
    index.path && index.path !== wantedPath ? [index.path] : undefined;
  await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    { writes: { [wantedPath]: contents }, deletes },
    {
      message: deletes?.length
        ? `notebook: move to ${wantedPath}`
        : `notebook: checkpoint "${index.name}"`,
      author: actorUserId ? await authorForUser(actorUserId) : undefined,
    },
  );
  index.path = wantedPath;
  index.checkpointBlobSha = sha;
  await index.save();
  queueMirrorPush(workspaceId);
  return { committed: true };
}

/** Remove the notebook's file when the notebook itself is deleted. */
export async function removeNotebookFile(
  workspaceId: string,
  index: Pick<INotebookIndex, "path" | "name">,
  actorUserId?: string,
): Promise<void> {
  if (!index.path) return;
  const repoDir = await repoDirIfExists(workspaceId);
  if (!repoDir) return;
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
  if (!repoDir) return;
  const head = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!head) return;
  const paths = (await listTree(repoDir, head))
    .map(e => e.path)
    .filter(isNotebookRepoPath);
  if (paths.length === 0) return;

  const store = getNotebookStore();
  for (const path of paths) {
    try {
      const index = await NotebookIndex.findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        path,
      });
      // Files with no index row are externally-created notebooks; creating
      // store documents for them is a follow-up (the store API cannot yet
      // create with a caller-chosen id). Skip quietly.
      if (!index) continue;

      const blob = await readBlob(repoDir, head, path);
      if (blob.isBinary) continue;
      const sha = blobOid(blob.contents);
      if (index.checkpointBlobSha === sha) continue; // level already

      const parsed = parseNotebookFile(blob.contents);
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
  if (!repoDir) return { notebooks: 0, written: 0 };
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
    const path = await uniqueNotebookPath(workspaceId, index);
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
