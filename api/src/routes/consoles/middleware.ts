/**
 * Workspace access for every console route: the URL's workspace must be
 * the caller's (a member, or an API key minted for it), and `memberRole` is
 * set for the handlers — for an API key, its OWNER's role, as in the shared
 * workspace middleware: a viewer's key must not become an admin here.
 */
import type { MiddlewareHandler } from "hono";
import { Types } from "mongoose";
import { enrichContextWithWorkspace } from "../../logging";
import type { AuthEnv } from "../../openapi/core";
import { workspaceService } from "../../services/workspace.service";
import { fail } from "../lib/respond";

export const consoleWorkspaceAccess: MiddlewareHandler<AuthEnv> = async (
  c,
  next,
) => {
  const workspaceId = c.req.param("workspaceId") as string;
  if (workspaceId) {
    // Validate ObjectId format early to return 400 instead of 500
    if (!Types.ObjectId.isValid(workspaceId)) {
      return fail(c, 400, "Invalid workspace ID format");
    }

    const user = c.get("user");
    const workspace = c.get("workspace");

    if (workspace) {
      // For API key auth, verify the URL workspace matches the API key's workspace
      if (workspace._id.toString() !== workspaceId) {
        return fail(c, 403, "API key not authorized for this workspace");
      }
      const owner = user
        ? await workspaceService.getMember(workspaceId, user.id)
        : null;
      if (!owner) {
        return fail(c, 403, "API key owner no longer has access to workspace");
      }
      c.set("memberRole", owner.role);
    } else if (user) {
      // For session auth, verify user has access to this workspace
      const member = await workspaceService.getMember(workspaceId, user.id);
      if (!member) {
        return fail(c, 403, "Access denied to workspace");
      }
      c.set("memberRole", member.role);
    } else {
      // Neither API key nor session auth succeeded - reject request
      return fail(c, 401, "Unauthorized");
    }

    // Only enrich logging context after authorization succeeds
    enrichContextWithWorkspace(workspaceId);
  }
  await next();
};
