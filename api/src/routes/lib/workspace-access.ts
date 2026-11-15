/**
 * "May this caller act in the workspace named by the URL?" — the check
 * almost every workspace-scoped router used to paste as its own middleware
 * (chats, chat-images, custom-prompt, skills, mcp-servers, source
 * connections, billing, usage, workspace repo, webhooks test, agent chat):
 *
 *   - an API key must belong to that workspace;
 *   - a session user must be a member of it;
 *   - neither → 401.
 *
 * Only after the check passes is the logging context enriched with the
 * workspace (so a denied request never carries it).
 */
import type { Context, MiddlewareHandler } from "hono";
import { Types } from "mongoose";

import { enrichContextWithWorkspace } from "../../logging";
import type { AuthEnv } from "../../openapi/core";
import { workspaceService } from "../../services/workspace.service";
import { fail } from "./respond";

export interface WorkspaceAccessDenial {
  status: 401 | 403;
  error: string;
}

/** The authenticated principal, as unifiedAuthMiddleware leaves it. */
export interface WorkspacePrincipal {
  user?: { id: string } | null;
  workspace?: { _id: { toString(): string } } | null;
}

/** Why `principal` may not act in `workspaceId`, or null when it may. */
export async function workspaceAccessDenial(
  principal: WorkspacePrincipal,
  workspaceId: string,
  deniedMessage = "Access denied to workspace",
): Promise<WorkspaceAccessDenial | null> {
  const { user, workspace } = principal;
  if (workspace) {
    return workspace._id.toString() === workspaceId
      ? null
      : { status: 403, error: "API key not authorized for this workspace" };
  }
  if (user) {
    const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
    return hasAccess ? null : { status: 403, error: deniedMessage };
  }
  return { status: 401, error: "Unauthorized" };
}

/** The principal on a request context. */
export function principalOf(c: Context<AuthEnv>): WorkspacePrincipal {
  return { user: c.get("user"), workspace: c.get("workspace") };
}

/**
 * The check against `workspaceId`, answered as a response: the failure to
 * return, or null (logging context enriched) to carry on.
 */
export async function checkWorkspaceAccess(
  c: Context<AuthEnv>,
  workspaceId: string,
  deniedMessage?: string,
): Promise<Response | null> {
  const denial = await workspaceAccessDenial(
    principalOf(c),
    workspaceId,
    deniedMessage,
  );
  if (denial) return fail(c, denial.status, denial.error);
  enrichContextWithWorkspace(workspaceId);
  return null;
}

export interface WorkspaceAccessOptions {
  /**
   * A request with no `:workspaceId` param: "skip" lets it through (routers
   * that also serve non-workspace paths), "reject" answers 400.
   */
  whenMissing?: "skip" | "reject";
  /** The 403 message for a session user who is not a member. */
  deniedMessage?: string;
  /** Answer 400 for a workspaceId that is not an ObjectId. */
  validateId?: boolean;
}

/** `router.use("*", requireWorkspaceAccess())` after unifiedAuthMiddleware. */
export function requireWorkspaceAccess(
  options: WorkspaceAccessOptions = {},
): MiddlewareHandler<AuthEnv> {
  const { whenMissing = "skip", deniedMessage, validateId = false } = options;
  return async (c, next) => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      if (whenMissing === "reject") return fail(c, 400, "Missing workspaceId");
      await next();
      return;
    }
    // Validate the ObjectId format early to answer 400 instead of 500.
    if (validateId && !Types.ObjectId.isValid(workspaceId)) {
      return fail(c, 400, "Invalid workspace ID format");
    }
    const refused = await checkWorkspaceAccess(c, workspaceId, deniedMessage);
    if (refused) return refused;
    await next();
  };
}
