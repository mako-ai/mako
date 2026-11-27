/**
 * Console folders and moves through the shared folder registrar
 * (`lib/folder-routes.ts`): the routes, validation and envelope are the
 * registrar's; this backend supplies the git-backed console semantics.
 */
import { Types } from "mongoose";
import { RepoRequiredError } from "../../apps/config";
import { consolesChartsRepo } from "../../repositories/consoles-charts";
import { createRouter } from "../../openapi/core";
import {
  canWriteConsole,
  consoleFolderWriteRefusal,
  createConsoleFolder,
  deleteConsoleFolder,
  moveConsole,
  moveConsoleFolder,
  renameConsoleFolder,
} from "../../services/consoles";
import { registerFolderRoutes, type FolderBackend } from "../lib/folder-routes";
import { repoRequired } from "./shared";

export const consoleFolderRoutes = createRouter();

const notFound = (error: string) =>
  ({ ok: false, status: 404, error }) as const;

const consoleFolderBackend: FolderBackend = {
  createFolder: async (ctx, { name, parentId, access }) => {
    const folder = await createConsoleFolder(
      name,
      ctx.workspaceId,
      ctx.userId,
      parentId ?? undefined,
      access ?? "private",
    );
    return {
      ok: true,
      data: {
        id: folder._id.toString(),
        name: folder.name,
        parentId: folder.parentId?.toString(),
        isPrivate: folder.isPrivate,
      },
    };
  },

  renameFolder: async (ctx, { folderId, name }) => {
    const denied = await consoleFolderWriteRefusal(ctx, folderId);
    if (denied) return denied;
    const success = await renameConsoleFolder(
      folderId,
      name,
      ctx.workspaceId,
      ctx.userId,
    );
    return success ? { ok: true } : notFound("Folder not found");
  },

  deleteFolder: async (ctx, { folderId }) => {
    const denied = await consoleFolderWriteRefusal(ctx, folderId);
    if (denied) return denied;
    const success = await deleteConsoleFolder(
      folderId,
      ctx.workspaceId,
      ctx.userId,
    );
    return success ? { ok: true } : notFound("Folder not found");
  },

  moveFolder: async (ctx, { folderId, parentId, access }) => {
    const denied = await consoleFolderWriteRefusal(ctx, folderId);
    if (denied) return denied;
    if (
      parentId &&
      (await consolesChartsRepo.wouldCreateConsoleFolderCycle(
        ctx.workspaceId,
        folderId,
        parentId,
      ))
    ) {
      return {
        ok: false,
        status: 400,
        error: "Cannot move a folder into itself",
      };
    }
    const success = await moveConsoleFolder(
      folderId,
      ctx.workspaceId,
      parentId ?? null,
      access,
      ctx.userId,
    );
    return success ? { ok: true } : notFound("Folder not found");
  },

  moveItem: async (ctx, { itemId, folderId, access }) => {
    if (Types.ObjectId.isValid(itemId)) {
      const existing = await consolesChartsRepo.findConsoleById(
        ctx.workspaceId,
        itemId,
      );
      if (existing && !canWriteConsole(existing, ctx.userId, ctx.role)) {
        return {
          ok: false,
          status: 403,
          error: "Cannot move a read-only console",
        };
      }
    }
    const success = await moveConsole(
      itemId,
      ctx.workspaceId,
      folderId ?? null,
      access,
      ctx.userId,
    );
    return success ? { ok: true } : notFound("Console not found");
  },
};

registerFolderRoutes(consoleFolderRoutes, {
  tag: "Consoles",
  schemaPrefix: "Console",
  backend: consoleFolderBackend,
  createdStatus: 201,
  onError: (c, error) =>
    error instanceof RepoRequiredError ? repoRequired(c, error) : undefined,
});
