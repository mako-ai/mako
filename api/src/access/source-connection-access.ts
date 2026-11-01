/**
 * Who may configure a source connection (a credential a workspace stores).
 *
 * Configuring means editing it, replacing or revealing its key, disabling or
 * deleting it, and deciding who else configures it. That is a short list of
 * people per connection, its EDITORS, not a workspace role:
 *
 *   - the person who creates a connection is its first editor;
 *   - an editor adds or removes other editors (members or admins they pick);
 *   - an admin who is not on the list cannot configure it — a workspace with
 *     many admins should not hand every one of them every key;
 *   - the workspace owner always can: the way back to a connection whose
 *     editors have all left;
 *   - viewers never can, even when listed (their role caps them);
 *   - everyone in the workspace still sees it and uses it, as its live-reads
 *     and writers settings allow.
 *
 * A connection stored before the list existed has none: its creator is its
 * editor, so nothing needs migrating.
 *
 * An API key acts as the person who created it.
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

/** The user ids that configure `connection`: its list, else its creator. */
export function editorsOf(connection: {
  editors?: unknown;
  createdBy?: unknown;
}): string[] {
  const listed = Array.isArray(connection.editors)
    ? connection.editors.map(String).filter(Boolean)
    : [];
  if (listed.length > 0) return [...new Set(listed)];
  const creator = String(connection.createdBy ?? "");
  return creator ? [creator] : [];
}

/**
 * Whether `userId` with `role` may configure `connection`: edit it, replace
 * or reveal its key, disable or delete it, and change its editors.
 */
export function mayChangeSourceConnection(
  role: WorkspaceRole | null,
  userId: string | undefined,
  connection: { editors?: unknown; createdBy?: unknown },
): boolean {
  if (!userId || !role || role === "viewer") return false;
  if (role === "owner") return true;
  return editorsOf(connection).includes(String(userId));
}

export const VIEWER_REFUSAL =
  "Viewers can see source connections but not create or change them. Ask an admin for the member role.";

export const NOT_AN_EDITOR_REFUSAL =
  "Only this connection's editors can change it. Ask one of them, or the workspace owner, to add you.";

/** The refusal for a caller `mayChangeSourceConnection` turned down. */
export function changeRefusal(role: WorkspaceRole | null): string {
  return role === "viewer" || !role ? VIEWER_REFUSAL : NOT_AN_EDITOR_REFUSAL;
}
