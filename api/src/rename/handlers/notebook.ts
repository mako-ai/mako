/**
 * Notebook rename handler (see ../types.ts for the contract).
 *
 * Notebooks are addressed by their store id (`/n/<id>`); the `.deepnote`
 * path is derived from the name by `notebook-git.service`, so `title` is
 * the only thing to rename and the file follows in one commit. No alias is
 * needed, and `slug` is refused rather than silently ignored.
 */
import { Types } from "mongoose";
import {
  NotebookIndex,
  type INotebookIndex,
} from "../../database/workspace-schema";
import { notebookAccessAllowed, renameNotebook } from "../notebook";
import {
  RenameError,
  type RenameContext,
  type RenameHandler,
  type RenameLocation,
  type ResolvedRef,
} from "../types";

function locationOf(index: INotebookIndex): RenameLocation {
  return {
    title: index.name,
    slug: index.path,
    path: index.path,
    url: `/n/${index.notebookId}`,
  };
}

/** By id, by `.deepnote` path, or by a name exactly ONE readable notebook has. */
async function findIndex(
  ctx: RenameContext,
  ref: string,
): Promise<INotebookIndex | null> {
  if (!Types.ObjectId.isValid(ctx.workspaceId)) return null;
  const workspaceId = new Types.ObjectId(ctx.workspaceId);
  const readable = (index: INotebookIndex) =>
    notebookAccessAllowed(index, ctx.workspaceId, ctx.userId, ctx.role, "read");
  const byId = await NotebookIndex.findOne({ workspaceId, notebookId: ref });
  if (byId) return (await readable(byId)) ? byId : null;
  const hits: INotebookIndex[] = [];
  for (const index of await NotebookIndex.find({
    workspaceId,
    $or: [{ path: ref }, { name: ref }],
  })) {
    if (await readable(index)) hits.push(index);
  }
  const byPath = hits.filter(i => i.path === ref);
  if (byPath.length === 1) return byPath[0];
  return hits.length === 1 ? hits[0] : null;
}

export const notebookRenameHandler: RenameHandler = {
  kind: "notebook",
  describe:
    "notebook: `title` = new name (the .deepnote file is renamed after it in the same commit); no `slug`. Links use `/n/<id>` and never break.",

  async resolve(ctx, ref): Promise<ResolvedRef | null> {
    const index = await findIndex(ctx, ref);
    if (!index) return null;
    return {
      kind: "notebook",
      id: index.notebookId,
      via: "current",
      current: locationOf(index),
    };
  },

  async rename(ctx, request) {
    if (request.slug !== undefined) {
      throw new RenameError(
        "A notebook's file is named after its title; give `title`, not `slug`.",
      );
    }
    if (request.title === undefined) {
      throw new RenameError("Give a new title.");
    }
    const index = await findIndex(ctx, request.ref);
    if (!index) throw new RenameError("Notebook not found", 404);
    const before = locationOf(index);
    const renamed = await renameNotebook({
      workspaceId: ctx.workspaceId,
      notebookId: index.notebookId,
      name: request.title,
      actorUserId: ctx.userId,
      role: ctx.role,
    });
    return {
      kind: "notebook",
      id: index.notebookId,
      before,
      after: locationOf(renamed.index),
      aliasesAdded: [],
      commit: renamed.commit,
      warnings: renamed.warnings,
    };
  },
};
