import { Context, Next } from "hono";
import { ValidatedSession, ValidatedUser } from "../auth/session";
import { workspaceService } from "../services/workspace.service";
import { Types } from "mongoose";
import { loggers, enrichContextWithWorkspace } from "../logging";

const logger = loggers.workspace();

export interface AuthenticatedContext extends Context {
  get(key: "user"): ValidatedUser | undefined;
  get(key: "session"): ValidatedSession | undefined;
  get(key: "workspace"): any;
  get(key: "memberRole"): string | undefined;
  set(key: "user", value: ValidatedUser): void;
  set(key: "session", value: ValidatedSession): void;
  set(key: "workspace", value: any): void;
  set(key: "memberRole", value: string): void;
}

/**
 * Require workspace to be set for the request
 */
export async function requireWorkspace(c: Context, next: Next) {
  try {
    const user = c.get("user");
    const session = c.get("session");

    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Get workspace ID from header or session
    const workspaceId =
      c.req.header("x-workspace-id") || session.activeWorkspaceId;

    if (!workspaceId) {
      // If no workspace is selected, get the first workspace for the user
      const workspaces = await workspaceService.getWorkspacesForUser(user.id);

      if (workspaces.length === 0) {
        return c.json(
          {
            error: "No workspace found. Please create a workspace first.",
          },
          400,
        );
      }

      // Use the first workspace
      c.set("workspace", workspaces[0].workspace);
      c.set("memberRole", workspaces[0].role);

      // Enrich logging context with workspace ID
      enrichContextWithWorkspace(workspaces[0].workspace._id.toString());

      // Update session with this workspace
      await workspaceService.switchWorkspace(
        user.id,
        workspaces[0].workspace._id.toString(),
      );
    } else {
      // Validate ObjectId format
      if (!Types.ObjectId.isValid(workspaceId)) {
        return c.json({ error: "Invalid workspace ID format" }, 400);
      }

      // Verify user has access to workspace
      const member = await workspaceService.getMember(workspaceId, user.id);

      if (!member) {
        return c.json({ error: "Access denied to workspace" }, 403);
      }

      const workspace = await workspaceService.getWorkspaceById(workspaceId);
      if (!workspace) {
        return c.json({ error: "Workspace not found" }, 404);
      }

      c.set("workspace", workspace);
      c.set("memberRole", member.role);

      // Enrich logging context with workspace ID
      enrichContextWithWorkspace(workspace._id.toString());
    }

    await next();
  } catch (error) {
    logger.error("Workspace middleware error", { error });
    return c.json(
      {
        error: "Failed to validate workspace access",
      },
      500,
    );
  }
}

/**
 * Require specific workspace roles
 */
export function requireWorkspaceRole(roles: string[]) {
  return async (c: Context, next: Next) => {
    try {
      const memberRole = c.get("memberRole");

      if (!memberRole) {
        return c.json(
          {
            error: "Workspace role not determined",
          },
          403,
        );
      }

      if (!roles.includes(memberRole)) {
        return c.json(
          {
            error: "Insufficient permissions in workspace",
          },
          403,
        );
      }

      await next();
    } catch (error) {
      logger.error("Workspace role middleware error", { error });
      return c.json(
        {
          error: "Failed to validate workspace role",
        },
        500,
      );
    }
  };
}

/**
 * Optional workspace - doesn't fail if no workspace is set
 */
export async function optionalWorkspace(c: Context, next: Next) {
  try {
    const user = c.get("user");
    const session = c.get("session");

    if (!user || !session) {
      return await next();
    }

    const workspaceId =
      c.req.header("x-workspace-id") || session.activeWorkspaceId;

    if (workspaceId && Types.ObjectId.isValid(workspaceId)) {
      const member = await workspaceService.getMember(workspaceId, user.id);

      if (member) {
        const workspace = await workspaceService.getWorkspaceById(workspaceId);
        if (workspace) {
          c.set("workspace", workspace);
          c.set("memberRole", member.role);

          // Enrich logging context with workspace ID
          enrichContextWithWorkspace(workspace._id.toString());
        }
      }
    }

    await next();
  } catch (error) {
    logger.error("Optional workspace middleware error", { error });
    // Don't fail the request, just continue without workspace
    await next();
  }
}
