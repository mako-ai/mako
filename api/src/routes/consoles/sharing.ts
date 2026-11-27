/**
 * Sharing (collaborators + general access) through the shared registrars
 * in `lib/collaborator-routes.ts`, backed by `consolesChartsRepo` so
 * `collaborator-routes.ts` stays untouched.
 */
import { Types } from "mongoose";
import type { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { createRouter } from "../../openapi/core";
import {
  consolesChartsRepo,
  type UpdateConsolePatch,
} from "../../repositories/consoles-charts";
import { ConsoleNotFoundError } from "../../services/consoles/crud";
import {
  registerCollaboratorRoutes,
  registerSharingSettingsRoutes,
  type ShareableDocument,
} from "../lib/collaborator-routes";

export const consoleSharingRoutes = createRouter();

type SharingField = "access" | "isPrivate" | "workspaceRole" | "sharedWith";

async function loadConsoleById(
  c: AuthenticatedContext,
): Promise<ShareableDocument | null> {
  const workspaceId = c.req.param("workspaceId");
  const id = c.req.param("id");
  if (!workspaceId || !id || !Types.ObjectId.isValid(id)) return null;
  const record = await consolesChartsRepo.findConsoleById(workspaceId, id);
  if (!record) return null;

  const dirty = new Set<SharingField>();
  let access = record.access;
  let isPrivate = record.isPrivate;
  let workspaceRole = record.workspaceRole;
  let sharedWith = record.sharedWith.map(s => ({ ...s }));
  let snapshotSharedWithJson = JSON.stringify(sharedWith);

  const adapter = {
    owner_id: record.owner_id,
    createdBy: record.createdBy,
    get access() {
      return access;
    },
    set access(value: typeof access) {
      access = value;
      dirty.add("access");
    },
    get isPrivate() {
      return isPrivate;
    },
    set isPrivate(value: boolean) {
      isPrivate = value;
      dirty.add("isPrivate");
    },
    get workspaceRole() {
      return workspaceRole;
    },
    set workspaceRole(value: typeof workspaceRole) {
      workspaceRole = value;
      dirty.add("workspaceRole");
    },
    get sharedWith() {
      return sharedWith;
    },
    set sharedWith(value: typeof sharedWith) {
      sharedWith = value;
      dirty.add("sharedWith");
    },
    markModified(path: string) {
      if (
        path === "access" ||
        path === "isPrivate" ||
        path === "workspaceRole" ||
        path === "sharedWith"
      ) {
        dirty.add(path);
      }
    },
    async save() {
      const patch: UpdateConsolePatch = {};
      if (dirty.has("access")) {
        patch.access = access;
        patch.isPrivate = access === "private";
      } else if (dirty.has("isPrivate")) {
        patch.isPrivate = isPrivate;
      }
      if (dirty.has("workspaceRole")) {
        patch.workspaceRole = workspaceRole;
      }
      if (
        dirty.has("sharedWith") ||
        JSON.stringify(sharedWith) !== snapshotSharedWithJson
      ) {
        patch.sharedWith = sharedWith;
      }
      if (Object.keys(patch).length > 0) {
        patch.updatedAt = new Date();
      }

      const updated = await consolesChartsRepo.updateConsole(
        workspaceId,
        record.id,
        patch,
      );
      if (!updated) {
        throw new ConsoleNotFoundError(record.id);
      }

      access = updated.access;
      isPrivate = updated.isPrivate;
      workspaceRole = updated.workspaceRole;
      sharedWith = updated.sharedWith.map(s => ({ ...s }));
      snapshotSharedWithJson = JSON.stringify(sharedWith);
      dirty.clear();
      return adapter;
    },
  };
  return adapter as unknown as ShareableDocument;
}

registerCollaboratorRoutes(consoleSharingRoutes, {
  resourceName: "Console",
  load: loadConsoleById,
});
registerSharingSettingsRoutes(consoleSharingRoutes, {
  resourceName: "Console",
  load: loadConsoleById,
});
