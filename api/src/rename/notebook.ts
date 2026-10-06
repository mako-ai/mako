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

export async function renameNotebook(input: RenameNotebookInput): Promise<{
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

  const doc = await getNotebookStore().update(
    input.workspaceId,
    input.notebookId,
    { name },
  );
  if (!doc) throw new RenameError("Notebook not found", 404);

  await updateNotebookIndex(input.workspaceId, input.notebookId, {
    name: doc.name,
    updatedAt: new Date(doc.updatedAt),
  });
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
  const checkpoint = await checkpointNotebook(
    input.workspaceId,
    input.notebookId,
    input.actorUserId,
  );
  if (checkpoint.skippedReason === "no_repository") {
    warnings.push(
      "No repository is connected: the notebook was renamed, but it has no .deepnote file to move.",
    );
  }
  // Re-read: the checkpoint just moved `path` on the row.
  const updated =
    (await getNotebookIndex(input.workspaceId, input.notebookId)) ?? index;
  return { index: updated, doc, commit: checkpoint.commitOid, warnings };
}
