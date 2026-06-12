/**
 * Unified Google Workspace-style ACL resolution for shareable resources
 * (dashboards, consoles, apps).
 *
 * Resolution order (first match wins):
 *   1. Owner (`owner_id`, falling back to `createdBy`)      → "owner"
 *   2. Explicit `sharedWith` entry                          → its role
 *   3. Workspace scope (`access === "workspace"`):
 *      - workspace admins/owners                            → "editor"
 *      - members with the `viewer` workspace member role    → "viewer"
 *      - everyone else                                      → `workspaceRole`
 *   4. Otherwise                                            → null (no access)
 *
 * Note: admins do NOT get access to private resources they don't own and
 * aren't shared on — this preserves the pre-existing privacy guarantee.
 */

export type ResourceShareRole = "viewer" | "editor";
export type EffectiveResourceRole = "owner" | "editor" | "viewer" | null;

export type WorkspaceMemberRole = "owner" | "admin" | "member" | "viewer";

export interface ShareableResourceLike {
  owner_id?: string | null;
  createdBy?: string | null;
  access?: "private" | "workspace" | null;
  workspaceRole?: ResourceShareRole | null;
  sharedWith?: Array<{ userId: string; role?: ResourceShareRole }> | null;
}

export function getResourceOwnerId(
  resource: ShareableResourceLike,
): string | undefined {
  return (resource.owner_id || resource.createdBy)?.toString() || undefined;
}

export function resolveResourceRole(
  resource: ShareableResourceLike,
  userId: string | undefined,
  memberRole?: string,
  options?: {
    /**
     * Override for the resource's visibility scope, used by callers that
     * resolve folder-inherited access (a private console inside a workspace
     * folder is effectively workspace-visible).
     */
    effectiveAccess?: "private" | "workspace";
  },
): EffectiveResourceRole {
  const ownerId = getResourceOwnerId(resource);
  if (userId && ownerId && ownerId === userId) return "owner";

  if (userId) {
    const entry = (resource.sharedWith || []).find(s => s.userId === userId);
    if (entry) return entry.role === "viewer" ? "viewer" : "editor";
  }

  const access = options?.effectiveAccess ?? resource.access ?? "private";
  if (access !== "workspace") return null;

  if (memberRole === "owner" || memberRole === "admin") return "editor";
  if (memberRole === "viewer") return "viewer";
  return resource.workspaceRole === "editor" ? "editor" : "viewer";
}

export function canReadResource(
  resource: ShareableResourceLike,
  userId: string | undefined,
  memberRole?: string,
  options?: { effectiveAccess?: "private" | "workspace" },
): boolean {
  return resolveResourceRole(resource, userId, memberRole, options) !== null;
}

export function canWriteResource(
  resource: ShareableResourceLike,
  userId: string | undefined,
  memberRole?: string,
  options?: { effectiveAccess?: "private" | "workspace" },
): boolean {
  const role = resolveResourceRole(resource, userId, memberRole, options);
  return role === "owner" || role === "editor";
}

/**
 * Whether the user can manage sharing (collaborators, general access, public
 * links) for the resource: the owner, or a workspace admin/owner for
 * non-private resources (admins must not discover private resources).
 */
export function canManageSharing(
  resource: ShareableResourceLike,
  userId: string | undefined,
  memberRole?: string,
): boolean {
  const role = resolveResourceRole(resource, userId, memberRole);
  if (role === "owner") return true;
  const isAdmin = memberRole === "owner" || memberRole === "admin";
  // Admin can manage anything they can at least see (workspace-visible or
  // explicitly shared with them).
  return isAdmin && role !== null;
}
