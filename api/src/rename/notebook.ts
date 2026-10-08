/**
 * Notebook rename — the one service behind the explorer's rename
 * (`PATCH /notebooks/:id` with only a name), the agent's `rename_object`
 * and the REST objects route (brief rule 5).
 *
 * A notebook's identity is its store id (`/n/<id>`), never its name: the
 * `.deepnote` checkpoint path is DERIVED from the name, so a rename is a
 * store/index update plus one checkpoint commit that moves the file
 * (notebook-git.service). No alias is needed — nothing addresses a notebook
 * by name.
 */
import { Types } from "mongoose";
import type { INotebookIndex } from "../database/workspace-schema";
import {
  getNotebookIndex,
  updateNotebookIndex,
} from "../services/notebook-index.service";
import { publishRealtimeEvent } from "../services/realtime.service";
import { NotebookManager } from "../utils/notebook-manager";
import { getNotebookStore } from "../notebooks/store";
import { NotebookVersionConflictError } from "../notebooks/store/types";
import { createSerializer } from "../apps/serialized";
import { checkpointNotebook } from "../notebooks/notebook-git.service";
import type { NotebookDoc } from "../notebooks/types";
import { RenameError } from "./types";

export function isAdminRole(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Can `userId` read/write this notebook? Folder access inherits. A
 * workspace API key (no user) acts as the notebook routes' "system" actor:
 * it reaches workspace-visible notebooks through the workspace role and
 * never a member's private ones — the same bar as `PATCH /notebooks/:id`.
 */
export async function notebookAccessAllowed(
  index: INotebookIndex,
  workspaceId: string,
  userId: string | undefined,
  role: string | undefined,
  mode: "read" | "write",
): Promise<boolean> {
  const actor = userId ?? "system";
  const memberRole = role ?? "member";
  const effective = await NotebookManager.getEffectiveAccessForNotebook(
    index,
    workspaceId,
  );
  return mode === "read"
    ? NotebookManager.canRead(index, actor, memberRole, effective)
    : NotebookManager.canWrite(
        index,
        actor,
        isAdminRole(memberRole),
        memberRole,
        effective,
      );
}

export interface RenameNotebookInput {
  workspaceId: string;
  notebookId: string;
  name: string;
  actorUserId?: string;
  role?: string;
  /** Realtime echo-suppression id of the window that asked. */
  clientId?: string;
}

/**
 * One rename at a time per workspace on this instance: two renames of one
 * notebook interleaving their store write and their index write left the
 * store saying one name and the index (the tree, the file) the other, for
 * good. Across instances the store write is a compare-and-swap on the
 * version just read (the loser answers 409), and the index follows the
 * store after the write (below).
 */
const serializedRenames = createSerializer();

export function renameNotebook(
  input: RenameNotebookInput,
): ReturnType<typeof renameNotebookNow> {
  return serializedRenames(input.workspaceId, () => renameNotebookNow(input));
}

async function renameNotebookNow(input: RenameNotebookInput): Promise<{
  index: INotebookIndex;
  doc: NotebookDoc;
  /** The checkpoint commit that moved the file, when a repo is bound. */
  commit?: string;
  warnings: string[];
}> {
  const name = input.name.trim();
  if (!name) throw new RenameError("A notebook needs a name.");
  if (!Types.ObjectId.isValid(input.workspaceId)) {
    throw new RenameError("Notebook not found", 404);
  }
  const index = await getNotebookIndex(input.workspaceId, input.notebookId);
  if (!index) throw new RenameError("Notebook not found", 404);
  if (
    !(await notebookAccessAllowed(
      index,
      input.workspaceId,
      input.actorUserId,
      input.role,
      "write",
    ))
  ) {
    throw new RenameError("You cannot rename this notebook", 403);
  }

  const store = getNotebookStore();
  const current = await store.get(input.workspaceId, input.notebookId);
  if (!current) throw new RenameError("Notebook not found", 404);
  let doc: NotebookDoc | null;
  try {
    doc = await store.update(
      input.workspaceId,
      input.notebookId,
      { name },
      { expectedVersion: current.version },
    );
  } catch (error) {
    if (error instanceof NotebookVersionConflictError) {
      throw new RenameError(
        "The notebook changed while it was being renamed (another rename or a save). Reload and try again.",
        409,
      );
    }
    throw error;
  }
  if (!doc) throw new RenameError("Notebook not found", 404);

  await updateNotebookIndex(input.workspaceId, input.notebookId, {
    name: doc.name,
    updatedAt: new Date(doc.updatedAt),
  });
  // The index follows the store: a later write of the name (another
  // instance's rename, an editor save) that landed between the two writes
  // above must not be overwritten by this older one.
  const latest = await store.get(input.workspaceId, input.notebookId);
  if (latest && latest.name !== doc.name) {
    await updateNotebookIndex(input.workspaceId, input.notebookId, {
      name: latest.name,
      updatedAt: new Date(latest.updatedAt),
    });
    doc = latest;
  }
  publishRealtimeEvent(input.workspaceId, { type: "notebook.tree.updated" });
  publishRealtimeEvent(input.workspaceId, {
    type: "notebook.updated",
    notebookId: doc.id,
    version: doc.version,
    updatedBy: input.actorUserId ?? "system",
    clientId: input.clientId,
    origin: "save",
  });

  // One commit per rename (brief rule 4): the checkpoint moves the file now
  // rather than after the edit-burst debounce, so the repo never shows a
  // renamed notebook under its old file name.
  const warnings: string[] = [];
  let checkpoint = await checkpointNotebook(
    input.workspaceId,
    input.notebookId,
    input.actorUserId,
  );
  if (checkpoint.skippedReason === "target_taken") {
    // The chosen file name was taken between the choice and the commit (a
    // push landing it); once more, choosing against the fresh tree.
    checkpoint = await checkpointNotebook(
      input.workspaceId,
      input.notebookId,
      input.actorUserId,
    );
  }
  if (checkpoint.skippedReason === "no_repository") {
    warnings.push(
      "No repository is connected: the notebook was renamed, but it has no .deepnote file to move.",
    );
  } else if (checkpoint.skippedReason === "target_taken") {
    warnings.push(
      "The notebook was renamed, but its file could not be moved yet (the target name was just taken); it will move on the next save.",
    );
  }
  // Re-read: the checkpoint just moved `path` on the row. Gone: a delete
  // took the notebook while it was being renamed — it is not renamed.
  const updated = await getNotebookIndex(input.workspaceId, input.notebookId);
  if (!updated) {
    throw new RenameError("This notebook was deleted meanwhile.", 404);
  }
  return { index: updated, doc, commit: checkpoint.commitOid, warnings };
}
