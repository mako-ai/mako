/**
 * WRITE-THROUGH (apps.md §16.3). Every saved-console mutation commits to
 * `main` first, then the caller updates the row with the returned `path`
 * and `sourceBlobSha`. Index plumbing, no clone (`commitBlobsOnBranch`).
 */
import { Types } from "mongoose";
import type { ISavedConsole } from "../../database/workspace-schema";
import type { SavedConsoleRecord } from "../../repositories/consoles-charts";
import { loggers } from "../../logging";
import {
  freshenBeforeMainWrite,
  queueMirrorPush,
  resolveMirrorTarget,
} from "../cloud-repo.service";
import { RepoRequiredError, appsRequireConnectedRepo } from "../config";
import { requireWorkspaceRepo } from "../workspace-repo-required";
import { chartSidecarPath } from "../console-files";
import {
  blobOid,
  commitBlobsOnBranch,
  type BlobMutation,
} from "../repository.service";
import { commitBranchFor } from "../branch-policy";
import { authorForUser } from "./authors";
import {
  consolesAdopted,
  fileStateFromRow,
  filesFor,
  repoPathForRow,
  type FolderLean,
  type RowLike,
} from "./files";
import { adoptWorkspaceConsoles } from "./adoption";

const logger = loggers.api("consoles-git");

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
  const repoDir = await requireWorkspaceRepo(input.workspaceId);
  if (
    appsRequireConnectedRepo() &&
    !(await resolveMirrorTarget(input.workspaceId))
  ) {
    throw new RepoRequiredError();
  }
  // Commit onto the mirror's main, not a stale cached tip (consoles pin to
  // the default branch — see branch-policy.ts).
  await freshenBeforeMainWrite(input.workspaceId);
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
  current: ISavedConsole | SavedConsoleRecord | null;
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
    ? typeof (input.current as { toObject?: () => unknown }).toObject ===
      "function"
      ? ((input.current as ISavedConsole).toObject() as Record<string, unknown>)
      : ({ ...input.current } as Record<string, unknown>)
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
