/**
 * Who may configure a source connection (a credential a workspace stores).
 *
 * Configuring means editing it, replacing or revealing its key, disabling or
 * deleting it, and deciding who else configures it. That is a short list of
 * people per connection, its MANAGERS, not a workspace role:
 *
 *   - the person who creates a connection is its first manager (stored on the
 *     connection when it is created);
 *   - a manager adds or removes other managers (members or admins they pick);
 *   - while a connection has managers, an admin who is not one cannot
 *     configure it — a workspace with many admins should not hand every one
 *     of them every key;
 *   - a connection with NO manager who can act today (created by `system`
 *     before creators were recorded, or whose managers all left) is managed
 *     by the workspace owner, until the owner adds someone;
 *   - the workspace owner always can;
 *   - viewers never can, even when listed (their role caps them);
 *   - everyone in the workspace still sees it and uses it, as its live-reads
 *     and writers settings allow.
 *
 * A connection stored before the list existed has none: its creator is its
 * manager, so nothing needs migrating.
 *
 * An API key acts as the person who created it.
 */
import { workspaceService } from "../services/workspace.service";

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export function mayCreateSourceConnection(role: WorkspaceRole | null): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

/** The workspace's roles and its owners, looked up once per request. */
export interface People {
  /** A user's workspace role, or null for no member. */
  roleOf: (userId: string) => Promise<WorkspaceRole | null>;
  owners: () => Promise<string[]>;
}

export function peopleOf(workspaceId: string): People {
  const roles = new Map<string, Promise<WorkspaceRole | null>>();
  let owners: Promise<string[]> | undefined;
  return {
    roleOf: userId => {
      let role = roles.get(userId);
      if (!role) {
        role = workspaceService
          .getMember(workspaceId, userId)
          .then(m => (m?.role as WorkspaceRole | undefined) ?? null);
        roles.set(userId, role);
      }
      return role;
    },
    owners: () => (owners ??= workspaceService.getOwnerIds(workspaceId)),
  };
}

/** The user ids recorded as configuring `connection`: its list, else its creator. */
export function managersOf(connection: {
  managers?: unknown;
  createdBy?: unknown;
}): string[] {
  const listed = Array.isArray(connection.managers)
    ? connection.managers.map(String).filter(Boolean)
    : [];
  if (listed.length > 0) return [...new Set(listed)];
  const creator = String(connection.createdBy ?? "");
  return creator ? [creator] : [];
}

/**
 * The managers who can act today: the recorded members and admins of the
 * workspace (leaving out `system`, people who left, and viewers), else the
 * workspace owner.
 */
export async function actingManagers(
  connection: { managers?: unknown; createdBy?: unknown },
  people: People,
): Promise<string[]> {
  const listed = managersOf(connection);
  const roles = await Promise.all(listed.map(id => people.roleOf(id)));
  const acting = listed.filter((_, i) => mayCreateSourceConnection(roles[i]));
  return acting.length > 0 ? acting : people.owners();
}

/** Who is asking, and how to look up everyone else. */
export interface Caller extends People {
  role: WorkspaceRole | null;
  userId?: string;
}

/**
 * Whether the caller may configure `connection`: edit it, replace or reveal
 * its key, disable or delete it, and change its managers. Pass its
 * {@link actingManagers} when already looked up.
 */
export async function mayChangeSourceConnection(
  caller: Caller,
  connection: { managers?: unknown; createdBy?: unknown },
  managers?: string[],
): Promise<boolean> {
  const { role, userId } = caller;
  if (!userId || !role || role === "viewer") return false;
  if (role === "owner") return true;
  return (managers ?? (await actingManagers(connection, caller))).includes(
    userId,
  );
}

export const VIEWER_REFUSAL =
  "Viewers can see source connections but not create or change them. Ask an admin for the member role.";

/** The refusal for a caller `mayChangeSourceConnection` turned down. */
export function changeRefusal(role: WorkspaceRole | null): string {
  return role === "viewer" || !role
    ? VIEWER_REFUSAL
    : "Only this connection's managers can change it. Ask one of them, or the workspace owner, to add you.";
}
