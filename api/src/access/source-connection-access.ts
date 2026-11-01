/**
 * Who may configure a source connection (a credential a workspace stores).
 *
 * Configuring means editing it, replacing or revealing its key, disabling or
 * deleting it, and deciding who else configures it. That is a short list of
 * people per connection, its EDITORS, not a workspace role:
 *
 *   - the person who creates a connection is its first editor (stored on the
 *     connection when it is created);
 *   - an editor adds or removes other editors (members or admins they pick);
 *   - while a connection has editors, an admin who is not one cannot
 *     configure it — a workspace with many admins should not hand every one
 *     of them every key;
 *   - a connection with NO editor who can act today (created by `system`
 *     before creators were recorded, or whose editors all left) is
 *     configured by every admin, as before, until someone adds an editor;
 *   - the workspace owner always can;
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

/** Looks up a workspace role, once per user id per request. */
export type RoleOf = (userId: string) => Promise<WorkspaceRole | null>;

export function roleLookup(workspaceId: string): RoleOf {
  const seen = new Map<string, Promise<WorkspaceRole | null>>();
  return userId => {
    let role = seen.get(userId);
    if (!role) {
      role = roleIn(workspaceId, userId);
      seen.set(userId, role);
    }
    return role;
  };
}

/** The user ids recorded as configuring `connection`: its list, else its creator. */
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
 * The recorded editors who can act today: members and admins of the
 * workspace. Leaves out `system`, people who left, and viewers.
 */
export async function actingEditors(
  connection: { editors?: unknown; createdBy?: unknown },
  roleOf: RoleOf,
): Promise<string[]> {
  const listed = editorsOf(connection);
  const roles = await Promise.all(listed.map(id => roleOf(id)));
  return listed.filter((_, i) => mayCreateSourceConnection(roles[i]));
}

/** Who is asking, and how to look up anyone else's role. */
export interface Caller {
  role: WorkspaceRole | null;
  userId?: string;
  roleOf: RoleOf;
}

/**
 * Whether the caller may configure `connection`: edit it, replace or reveal
 * its key, disable or delete it, and change its editors.
 */
export async function mayChangeSourceConnection(
  caller: Caller,
  connection: { editors?: unknown; createdBy?: unknown },
): Promise<boolean> {
  const { role, userId } = caller;
  if (!userId || !role || role === "viewer") return false;
  if (role === "owner") return true;
  const editors = await actingEditors(connection, caller.roleOf);
  // No one can act on it yet: every admin may, until an editor is added.
  if (editors.length === 0) return role === "admin";
  return editors.includes(String(userId));
}

export const VIEWER_REFUSAL =
  "Viewers can see source connections but not create or change them. Ask an admin for the member role.";

export const NOT_AN_EDITOR_REFUSAL =
  "Only this connection's editors can change it. Ask one of them, or the workspace owner, to add you.";

/** The refusal for a caller `mayChangeSourceConnection` turned down. */
export function changeRefusal(role: WorkspaceRole | null): string {
  return role === "viewer" || !role ? VIEWER_REFUSAL : NOT_AN_EDITOR_REFUSAL;
}
