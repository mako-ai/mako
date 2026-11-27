/**
 * Sharing (collaborators + general access) through the shared registrars
 * in `lib/collaborator-routes.ts`, backed by `consolesChartsRepo` so
 * `collaborator-routes.ts` stays untouched.
 */
import { Types } from "mongoose";
import type { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { createRouter } from "../../openapi/core";
import { consolesChartsRepo } from "../../repositories/consoles-charts";
import {
  registerCollaboratorRoutes,
  registerSharingSettingsRoutes,
  type ShareableDocument,
} from "../lib/collaborator-routes";

export const consoleSharingRoutes = createRouter();

async function loadConsoleById(
  c: AuthenticatedContext,
): Promise<ShareableDocument | null> {
  const workspaceId = c.req.param("workspaceId");
  const id = c.req.param("id");
  if (!workspaceId || !id || !Types.ObjectId.isValid(id)) return null;
  const record = await consolesChartsRepo.findConsoleById(workspaceId, id);
  if (!record) return null;

  const adapter = {
    owner_id: record.owner_id,
    createdBy: record.createdBy,
    access: record.access,
    isPrivate: record.isPrivate,
    workspaceRole: record.workspaceRole,
    sharedWith: record.sharedWith.map(s => ({ ...s })),
    markModified(_path: string) {
      // No-op: full `sharedWith` array is persisted by `save()`.
    },
    async save() {
      const updated = await consolesChartsRepo.updateConsole(
        workspaceId,
        record.id,
        {
          access: adapter.access,
          isPrivate: adapter.access === "private",
          workspaceRole: adapter.workspaceRole,
          sharedWith: adapter.sharedWith,
          updatedAt: new Date(),
        },
      );
      if (updated) {
        adapter.access = updated.access;
        adapter.isPrivate = updated.isPrivate;
        adapter.workspaceRole = updated.workspaceRole;
        adapter.sharedWith = updated.sharedWith.map(s => ({ ...s }));
      }
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
