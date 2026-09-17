/**
 * Who may file what where in the app trees (apps.md §29).
 *
 * One rule set for every entry point — the REST routes, the agent tools and
 * the ChatGPT connector — so an actor the routes refuse cannot do the same
 * thing through a tool. The rules:
 *
 *  - The WORKSPACE tree (`apps/…`) is organised by editing members only:
 *    owner, admin, member. Viewers, unknown roles and actors with no role at
 *    all (an API key whose creator left the workspace) read but never move.
 *  - A PERSONAL tree (`users/<id>/apps/…`) is its owner's alone, in both
 *    directions: only the owner files things into it, and only the owner
 *    moves an app out of it. A personal target needs a signed-in user.
 */
import type { AppFolderTarget } from "./worktree.service";
import type { AppRepoLocation } from "./app-paths";

/** Who may reorganise the WORKSPACE tree: any editing member. */
export function canOrganizeWorkspaceTree(role: string | undefined): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

/**
 * Authorize a folder TARGET for the caller: a private target must be the
 * caller's own tree (the owner is filled in when omitted); a workspace
 * target needs an editing role. Returns the refusal, or null when allowed.
 */
export function authorizeFolderTarget(
  target: AppFolderTarget,
  userId: string | undefined,
  role: string | undefined,
): string | null {
  if (target.scope === "private") {
    if (!userId) return "Personal folders need a signed-in user";
    if (target.ownerId && target.ownerId !== userId) {
      return "You can only file things into your own personal folders";
    }
    target.ownerId = userId;
    return null;
  }
  if (!canOrganizeWorkspaceTree(role)) {
    return "Only workspace editors can reorganise the Workspace tree";
  }
  return null;
}

/**
 * Authorize moving an app FROM `source` TO `target`. The target rule above,
 * plus: leaving the workspace tree needs an editing role, and leaving a
 * personal tree is the owner's call alone.
 */
export function authorizeAppMove(
  source: AppRepoLocation | null,
  target: AppFolderTarget,
  userId: string | undefined,
  role: string | undefined,
): string | null {
  const denied = authorizeFolderTarget(target, userId, role);
  if (denied) return denied;
  if (source?.scope === "workspace" && !canOrganizeWorkspaceTree(role)) {
    return "Only workspace editors can reorganise the Workspace tree";
  }
  if (source?.scope === "private" && (!userId || source.ownerId !== userId)) {
    return "Only the owner can move an app out of their personal folder";
  }
  return null;
}
