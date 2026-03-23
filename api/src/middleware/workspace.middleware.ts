import { Context, Next } from "hono";
import { ValidatedSession, ValidatedUser } from "../auth/session";
import { workspaceService } from "../services/workspace.service";
import { Types } from "mongoose";
import { loggers, enrichContextWithWorkspace } from "../logging";

const logger = loggers.workspace();

function getRequestedWorkspaceId(c: Context): string | undefined {
  return (
    c.req.param("workspaceId") ||
    c.req.param("id") ||
    c.req.header("x-workspace-id") ||
    c.get("session")?.activeWorkspaceId
  );
}

export interface AuthenticatedContext extends Context {
  get(key: "user"): ValidatedUser | undefined;
  get(key: "session"): ValidatedSession | undefined;
  get(key: "workspace"): any;
  get(key: "memberRole"): string | undefined;
  // Keys set by unifiedAuthMiddleware
  get(key: "authType"): "session" | "apiKey" | undefined;
  get(key: "workspaceId"): string | undefined;
  get(key: "apiKey"): any;
  set(key: "user", value: ValidatedUser): void;
  set(key: "session", value: ValidatedSession): void;
  set(key: "workspace", value: any): void;
  set(key: "memberRole", value: string): void;
  set(key: "authType", value: "session" | "apiKey"): void;
  set(key: "workspaceId", value: string): void;
  set(key: "apiKey", value: any): void;
}

/**
 * Require workspace to be set for the request
 */
export async function requireWorkspace(c: Context, next: Next) {
  try {
    const user = c.get("user");
    const session = c.get("session");
    const authenticatedWorkspace = c.get("workspace");
    const workspaceId = getRequestedWorkspaceId(c);

    if (authenticatedWorkspace) {
      const resolvedWorkspaceId =
        workspaceId || authenticatedWorkspace._id.toString();

      if (!Types.ObjectId.isValid(resolvedWorkspaceId)) {
        return c.json({ error: "Invalid workspace ID format" }, 400);
      }

      if (authenticatedWorkspace._id.toString() !== resolvedWorkspaceId) {
        return c.json(
          { error: "API key not authorized for this workspace" },
          403,
        );
      }

      if (user) {
        const member = await workspaceService.getMember(
          resolvedWorkspaceId,
          user.id,
        );
        if (!member) {
          return c.json(
            { error: "API key owner no longer has access to workspace" },
            403,
          );
        }
        c.set("memberRole", member.role);
      }

      enrichContextWithWorkspace(resolvedWorkspaceId);
      await next();
      return;
    }

    if (!user || !session) {
      return c.json({ error: "Unauthorized" }, 401);
    }

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
    const authenticatedWorkspace = c.get("workspace");
    const workspaceId = getRequestedWorkspaceId(c);

    if (authenticatedWorkspace) {
      const resolvedWorkspaceId =
        workspaceId || authenticatedWorkspace._id.toString();

      if (
        !workspaceId ||
        authenticatedWorkspace._id.toString() === resolvedWorkspaceId
      ) {
        if (user) {
          const member = await workspaceService.getMember(
            resolvedWorkspaceId,
            user.id,
          );
          if (member) {
            c.set("memberRole", member.role);
          }
        }
        enrichContextWithWorkspace(resolvedWorkspaceId);
      }
      return await next();
    }

    if (!user || !session) {
      return await next();
    }

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
