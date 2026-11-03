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
 *  - A PERSONAL tree (`users/<handle>/apps/…`) is its owner's alone, in both
 *    directions: only the owner files things into it, and only the owner
 *    moves an app out of it. A personal target needs a signed-in user.
 *
 * "Owner" is always the workspace's handle mapping's answer for the folder
 * segment (OwnerDirectory), compared by userId. A folder named after
 * someone — or spelled like their id — grants nothing by its name, and a
 * segment the mapping does not know is nobody's tree, so nobody may write it.
 */
import type { AppFolderTarget } from "./worktree.service";
import type { AppRepoLocation } from "./app-paths";
import type { OwnerDirectory } from "./user-handles";
import {
  canReadResource,
  type ShareableResourceLike,
} from "../utils/resource-acl";

/**
 * Whether the caller sees an indexed app at all — the app list's rule, shared
 * with every surface that reports on apps (usage stats, recently viewed) so
 * none of them can leak a private app the list hides. An app with a state row
 * follows its ACL; a folder-only app is workspace content, unless it sits in
 * someone's personal tree, which is theirs alone. No user (an API key) sees
 * everything, as the list does. `folder.ownerId` must be the INDEX row's owner
 * (resolved through the handle mapping), never parsed from the path.
 */
export function canSeeIndexedApp(
  folder: { scope: string; ownerId?: string },
  state: ShareableResourceLike | null | undefined,
  userId: string | undefined,
  role: string | undefined,
): boolean {
  if (!userId) return true;
  if (state) return canReadResource(state, userId, role);
  if (folder.scope === "private") return folder.ownerId === userId;
  return true;
}

/** Who may reorganise the WORKSPACE tree: any editing member. */
export function canOrganizeWorkspaceTree(role: string | undefined): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

/**
 * Authorize a folder TARGET for the caller: a private target must be the
 * caller's own tree (owner and handle are filled in when omitted); a
 * workspace target needs an editing role. Returns the refusal, or null when
 * allowed.
 */
export function authorizeFolderTarget(
  target: AppFolderTarget,
  userId: string | undefined,
  role: string | undefined,
  directory: OwnerDirectory,
): string | null {
  if (target.scope === "private") {
    if (!userId) return "Personal folders need a signed-in user";
    if (
      target.ownerHandle !== undefined &&
      directory.ownerOf(target.ownerHandle) !== userId
    ) {
      return "You can only file things into your own personal folders";
    }
    if (target.ownerId && target.ownerId !== userId) {
      return "You can only file things into your own personal folders";
    }
    const handle = directory.handleOf(userId);
    if (!handle) return "You have no personal folder in this workspace";
    target.ownerId = userId;
    target.ownerHandle = handle;
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
  directory: OwnerDirectory,
): string | null {
  const denied = authorizeFolderTarget(target, userId, role, directory);
  if (denied) return denied;
  if (source?.scope === "workspace" && !canOrganizeWorkspaceTree(role)) {
    return "Only workspace editors can reorganise the Workspace tree";
  }
  if (
    source?.scope === "private" &&
    (!userId || directory.ownerOf(source.ownerHandle) !== userId)
  ) {
    return "Only the owner can move an app out of their personal folder";
  }
  return null;
}
