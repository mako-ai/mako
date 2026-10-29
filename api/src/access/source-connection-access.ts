/**
 * Who may configure a source connection (a credential a workspace stores).
 *
 *   - viewer: reads only (list, open, test, see entities);
 *   - member: creates connections, and edits, disables or deletes the ones
 *     they created (`createdBy`);
 *   - owner and admin: edit, disable or delete any, and replace any key.
 *
 * Revealing a stored key stays owner/admin only (routes/source-connections.ts).
 * An API key acts with the role of the person who created it.
 */
import { workspaceService } from "../services/workspace.service";

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

/** The caller's role in the workspace, or null for no member. */
export async function roleIn(
  workspaceId: string,
  userId: string | undefined,
): Promise<WorkspaceRole | null> {
  if (!userId) return null;
  const member = await workspaceService.getMember(workspaceId, userId);
  return (member?.role as WorkspaceRole | undefined) ?? null;
}

export function mayCreateSourceConnection(role: WorkspaceRole | null): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

/** Whether `userId` with `role` may edit, disable or delete `connection`. */
export function mayChangeSourceConnection(
  role: WorkspaceRole | null,
  userId: string | undefined,
  connection: { createdBy?: unknown },
): boolean {
  if (role === "owner" || role === "admin") return true;
  if (role !== "member" || !userId) return false;
  return String(connection.createdBy ?? "") === String(userId);
}

export const VIEWER_REFUSAL =
  "Viewers can see source connections but not create or change them. Ask an admin for the member role.";

export const NOT_YOURS_REFUSAL =
  "Members can change only the source connections they created. Ask the workspace owner or an admin.";
