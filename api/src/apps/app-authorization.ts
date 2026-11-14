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
import { APP_LINK_EDITORS_ONLY, APP_LINK_OWNER_ONLY } from "@mako/schemas";
import type { AppFolderTarget } from "./worktree.service";
import type { AppRepoLocation } from "./app-paths";
import type { OwnerDirectory } from "./user-handles";
import {
  canReadResource,
  canWriteResource,
  resolveResourceRole,
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
 *
 * With the `app` given (its state row, or its synthesized shape), one more:
 * filing it INTO a personal tree makes it that person's private app — the
 * index re-owns it — so only its owner or a workspace owner/admin may. An
 * editor it is merely shared with could otherwise take it over, and any
 * member could hide a workspace app from everyone else.
 */
export function authorizeAppMove(
  source: AppRepoLocation | null,
  target: AppFolderTarget,
  userId: string | undefined,
  role: string | undefined,
  directory: OwnerDirectory,
  app?: ShareableResourceLike,
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
  if (app && target.scope === "private" && source?.scope !== "private") {
    return canTakePrivate(app, userId, role);
  }
  return null;
}

/**
 * May the caller file `app` into their personal tree, making it their
 * private app? Its owner, or a workspace owner/admin. Returns the refusal,
 * or null.
 */
export function canTakePrivate(
  app: ShareableResourceLike,
  userId: string | undefined,
  role: string | undefined,
): string | null {
  if (role === "owner" || role === "admin") return null;
  if (userId && resolveResourceRole(app, userId, role) === "owner") return null;
  return "Only the app's owner or a workspace admin can move it into a personal folder: it would become private to you";
}

/** What the caller may rename on an app. */
export type AppRenameRights =
  | { kind: "full" }
  /** The name only: the link is the folder's owner's (or an editor's). */
  | { kind: "title"; linkReason: string }
  /** `hidden`: the caller cannot even see the app (answer "not found"). */
  | { kind: "none"; reason: string; hidden: boolean };

/**
 * Who may rename what. The NAME (mako.json `title`) is an edit of the app:
 * anyone who may write it. The LINK is the folder's name, so changing it is
 * a move within its own folder and follows {@link authorizeAppMove}: an
 * editing role in the workspace tree, the owner in a personal tree. A
 * credential with no person behind it is gated by no per-user ACL, as in
 * every app tool. One rule for the dialog, the route and `rename_object`.
 */
export function appRenameRights(
  app: ShareableResourceLike,
  source: AppRepoLocation,
  userId: string | undefined,
  role: string | undefined,
  directory: OwnerDirectory,
): AppRenameRights {
  if (userId && !canWriteResource(app, userId, role)) {
    const hidden = !canReadResource(app, userId, role);
    return {
      kind: "none",
      hidden,
      reason:
        "You have read-only access to this app. Ask its owner or an editor to rename it.",
    };
  }
  const denied = authorizeAppMove(
    source,
    {
      scope: source.scope,
      ownerHandle: source.ownerHandle,
      folderSegments: [...source.folderSegments],
    },
    userId,
    role,
    directory,
  );
  if (!denied) return { kind: "full" };
  return {
    kind: "title",
    linkReason:
      source.scope === "private" ? APP_LINK_OWNER_ONLY : APP_LINK_EDITORS_ONLY,
  };
}
