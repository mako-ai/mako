/**
 * Who may read or write a console: its own access level (legacy `isPrivate`
 * rows included), explicit collaborators, the shared resource ACL, and
 * access inherited from workspace-shared folders up its chain.
 */
import type {
  ConsoleAccessLevel,
  ISavedConsole,
} from "../../database/workspace-schema";
import { canReadResource, canWriteResource } from "../../utils/resource-acl";
import { FolderChainCache, folderAccess } from "../../utils/folder-chain";

/** Options for the folder-inheritance checks. */
export interface InheritanceOptions {
  /** Scope for folder lookups when the console row has no workspaceId. */
  workspaceId?: string;
  /** A shared, possibly prefetched cache (batch callers). */
  folders?: FolderChainCache;
}

/**
 * A console's or folder's own access level. Backward compatible: rows
 * without an `access` field derive it from the legacy `isPrivate` boolean.
 */
export function legacyAccess(row: {
  access?: ConsoleAccessLevel | null;
  isPrivate?: boolean;
}): ConsoleAccessLevel {
  return row.access || (row.isPrivate ? "private" : "workspace");
}

/** The effective access level for a console (before folder inheritance). */
export function resolveConsoleAccess(
  console: ISavedConsole,
): ConsoleAccessLevel {
  return legacyAccess(console);
}

/**
 * Whether `userId` is an explicit collaborator (viewer or editor).
 */
export function isConsoleCollaborator(
  console: ISavedConsole,
  userId: string,
): boolean {
  return (console.sharedWith || []).some(s => s.userId === userId);
}

/**
 * Check whether `userId` can read the given console.
 */
export function canReadConsole(
  console: ISavedConsole,
  userId: string,
  memberRole?: string,
): boolean {
  return canReadResource(console, userId, memberRole, {
    effectiveAccess: resolveConsoleAccess(console),
  });
}

/**
 * Check whether `userId` can write (modify) the given console. `memberRole`
 * is the caller's workspace role: admins can write any workspace-level
 * console.
 */
export function canWriteConsole(
  console: ISavedConsole,
  userId: string,
  memberRole?: string,
): boolean {
  return canWriteResource(console, userId, memberRole, {
    effectiveAccess: resolveConsoleAccess(console),
  });
}

/**
 * The folder cache for an inheritance check: the caller's (shared across
 * many consoles, see prefetch) or a fresh one scoped to the console's
 * workspace. Null when no workspace is known — the walk is then skipped
 * (fail closed) rather than looked up unscoped.
 */
function folderCacheFor(
  console: ISavedConsole,
  options?: InheritanceOptions,
): FolderChainCache | null {
  if (options?.folders) return options.folders;
  const workspaceId = options?.workspaceId ?? console.workspaceId;
  return workspaceId ? FolderChainCache.forWorkspace(workspaceId) : null;
}

/** Whether any folder up the console's chain grants workspace access. */
async function inheritsWorkspaceAccess(
  console: ISavedConsole,
  options?: InheritanceOptions,
): Promise<boolean> {
  const folderId = console.folderId?.toString();
  if (!folderId) return false;
  const folders = folderCacheFor(console, options);
  if (!folders) return false;
  const chain = await folders.chainOf(folderId);
  return chain.some(folder => folderAccess(folder) === "workspace");
}

/**
 * Check if a user can read a console, considering inherited folder access.
 * Walks up the folder chain (workspace-scoped, cycle-safe) to find the
 * effective access level. Pass `options.folders` (prefetched for a batch
 * of consoles) to avoid a query per level per console.
 */
export async function canReadConsoleWithInheritance(
  console: ISavedConsole,
  userId: string,
  options?: InheritanceOptions,
): Promise<boolean> {
  const ownerId = (console.owner_id || console.createdBy)?.toString();
  if (ownerId === userId) return true;
  if (isConsoleCollaborator(console, userId)) return true;

  const ownAccess = resolveConsoleAccess(console);
  if (ownAccess === "workspace") return true;

  return inheritsWorkspaceAccess(console, options);
}

/**
 * Resolve the access level a user sees after folder inheritance.
 */
export async function resolveConsoleAccessWithInheritance(
  console: ISavedConsole,
  options?: InheritanceOptions,
): Promise<ConsoleAccessLevel> {
  const ownAccess = resolveConsoleAccess(console);
  if (ownAccess === "workspace") return "workspace";
  return (await inheritsWorkspaceAccess(console, options))
    ? "workspace"
    : "private";
}
