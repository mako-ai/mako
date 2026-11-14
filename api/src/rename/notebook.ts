/**
 * Notebook rename — the one service behind the explorer's rename
 * (`PATCH /notebooks/:id` with only a name), `rename_object` and the REST
 * objects route.
 *
 * A notebook's identity is its store id (`/n/<id>`), never its name: the
 * `.deepnote` path is derived from the name, so a rename is a store and
 * index update plus one checkpoint commit that moves the file
 * (notebook-git.service). Nothing addresses a notebook by name, so no
 * alias is kept.
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
import { cleanRenameTitle } from "./title-rules";
import { RenameError } from "./types";

/** The longest notebook name a rename writes. */
export const NOTEBOOK_NAME_MAX_LENGTH = 200;

const isAdmin = (role: string | undefined) =>
  role === "owner" || role === "admin";

/**
 * Can this caller read or write the notebook? Folder access inherits. A
 * workspace API key (no user) is the notebook routes' "system" actor: it
 * reaches workspace-visible notebooks, never a member's private ones — the
 * bar `PATCH /notebooks/:id` sets.
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
        isAdmin(memberRole),
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

export interface RenamedNotebook {
  index: INotebookIndex;
  doc: NotebookDoc;
  /** The checkpoint commit that moved the file, when a repo is bound. */
  commit?: string;
  warnings: string[];
}

/**
 * One rename at a time per workspace on this instance: two renames of one
 * notebook interleaving their store write and their index write left the
 * store saying one name and the index (the tree, the file) the other.
 * Across instances the store write is a compare-and-swap on the version
 * just read — the loser answers 409 — and the index follows the store.
 */
const serializedRenames = createSerializer();

export function renameNotebook(
  input: RenameNotebookInput,
): Promise<RenamedNotebook> {
  return serializedRenames(input.workspaceId, () => renameNotebookNow(input));
}

/** Test seam: after the store version is read, before the name is written. */
export const notebookRenameHooks: { afterRead?: () => Promise<void> } = {};

async function renameNotebookNow(
  input: RenameNotebookInput,
): Promise<RenamedNotebook> {
  const name = cleanRenameTitle(input.name, NOTEBOOK_NAME_MAX_LENGTH);
  if (!Types.ObjectId.isValid(input.workspaceId)) {
    throw new RenameError("Notebook not found", 404);
  }
  const { workspaceId: ws, notebookId: id } = input;
  const index = await getNotebookIndex(ws, id);
  if (!index) throw new RenameError("Notebook not found", 404);
  if (
    !(await notebookAccessAllowed(
      index,
      ws,
      input.actorUserId,
      input.role,
      "write",
    ))
  ) {
    throw new RenameError("You cannot rename this notebook", 403);
  }

  const store = getNotebookStore();
  const current = await store.get(ws, id);
  if (!current) throw new RenameError("Notebook not found", 404);
  await notebookRenameHooks.afterRead?.();
  let doc: NotebookDoc | null;
  try {
    doc = await store.update(
      ws,
      id,
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

  await updateNotebookIndex(ws, id, {
    name: doc.name,
    updatedAt: new Date(doc.updatedAt),
  });
  // The index follows the store: a later write of the name that landed
  // between the two writes above is not overwritten by this older one.
  const latest = await store.get(ws, id);
  if (latest && latest.name !== doc.name) {
    await updateNotebookIndex(ws, id, {
      name: latest.name,
      updatedAt: new Date(latest.updatedAt),
    });
    doc = latest;
  }
  publishRealtimeEvent(ws, { type: "notebook.tree.updated" });
  publishRealtimeEvent(ws, {
    type: "notebook.updated",
    notebookId: doc.id,
    version: doc.version,
    updatedBy: input.actorUserId ?? "system",
    clientId: input.clientId,
    origin: "save",
  });

  // One commit per rename: the file moves now, not after the edit-burst
  // debounce, so the repo never shows a renamed notebook under its old
  // file name. A target taken between the choice and the commit is chosen
  // again once, against the fresh tree.
  const warnings: string[] = [];
  let checkpoint = await checkpointNotebook(ws, id, input.actorUserId);
  if (checkpoint.skippedReason === "target_taken") {
    checkpoint = await checkpointNotebook(ws, id, input.actorUserId);
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
  // Gone: a delete took the notebook while it was being renamed.
  const updated = await getNotebookIndex(ws, id);
  if (!updated) {
    throw new RenameError("This notebook was deleted meanwhile.", 404);
  }
  return { index: updated, doc, commit: checkpoint.commitOid, warnings };
}
