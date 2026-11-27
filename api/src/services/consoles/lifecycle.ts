/**
 * Rename and delete as the routes run them: the caller's permission check,
 * the mutation (crud.ts), and the realtime poke other tabs and users react
 * to. A refusal is `{ ok: false, status, error }`.
 */
import { Types } from "mongoose";
import { consolesChartsRepo } from "../../repositories/consoles-charts";
import { publishRealtimeEvent } from "../realtime.service";
import { canWriteConsole } from "./access";
import { renameConsole, softDeleteConsole } from "./crud";

export type LifecycleResult =
  { ok: true } | { ok: false; status: 400 | 403 | 404; error: string };

function findInWorkspace(workspaceId: string, consoleId: string) {
  return consolesChartsRepo.findConsoleById(workspaceId, consoleId);
}

/** PATCH /{id}/rename. `name` may carry a folder path ("a/b/name"). */
export async function renameConsoleAs(input: {
  workspaceId: string;
  consoleId: string;
  name: unknown;
  userId: string;
  memberRole: string | undefined;
}): Promise<LifecycleResult> {
  const { workspaceId, consoleId, userId } = input;
  const validId = Types.ObjectId.isValid(consoleId);
  if (validId) {
    const existing = await findInWorkspace(workspaceId, consoleId);
    if (existing && !canWriteConsole(existing, userId, input.memberRole)) {
      return {
        ok: false,
        status: 403,
        error: "Cannot rename a read-only console",
      };
    }
  }

  if (!input.name || typeof input.name !== "string") {
    return {
      ok: false,
      status: 400,
      error: "Name is required and must be a string",
    };
  }

  const success = await renameConsole(
    consoleId,
    input.name,
    workspaceId,
    userId,
  );
  if (!success) return { ok: false, status: 404, error: "Console not found" };

  // Bump the draft revision so revision-sync catches the rename, then
  // poke subscribers (other tabs/users update the tab title live).
  if (validId) {
    const renamed = await consolesChartsRepo.bumpConsoleDraftRevision(
      workspaceId,
      consoleId,
    );
    if (renamed) {
      publishRealtimeEvent(workspaceId, {
        type: "console.updated",
        consoleId,
        draftRevision: renamed.draftRevision ?? 1,
        name: renamed.name,
        updatedBy: userId,
        origin: "save",
      });
    }
  }
  return { ok: true };
}

/** DELETE /{id}: soft delete, by the console's owner or a workspace admin. */
export async function deleteConsoleAs(input: {
  workspaceId: string;
  consoleId: string;
  userId: string;
  memberRole: string | undefined;
}): Promise<LifecycleResult> {
  const { workspaceId, consoleId, userId } = input;
  if (Types.ObjectId.isValid(consoleId)) {
    const existing = await findInWorkspace(workspaceId, consoleId);
    const ownerId = existing && (existing.owner_id || existing.createdBy);
    const isAdmin =
      input.memberRole === "owner" || input.memberRole === "admin";
    if (existing && ownerId !== userId && !isAdmin) {
      return {
        ok: false,
        status: 403,
        error: "Only the console owner or a workspace admin can delete it",
      };
    }
  }

  const success = await softDeleteConsole(consoleId, workspaceId, userId);
  if (!success) return { ok: false, status: 404, error: "Console not found" };

  publishRealtimeEvent(workspaceId, {
    type: "console.deleted",
    consoleId,
  });
  return { ok: true };
}
