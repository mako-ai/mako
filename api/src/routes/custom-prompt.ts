import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { Workspace } from "../database/workspace-schema";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import {
  AUTH_SECURITY,
  createRouter,
  errorJson,
  jsonContent,
} from "../openapi/core";

const logger = loggers.workspace();

export const customPromptRoutes = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});

// Apply unified auth middleware to all custom prompt routes
customPromptRoutes.use("*", unifiedAuthMiddleware);

// Middleware to verify workspace access and enrich logging context
customPromptRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) {
    const user = c.get("user");
    const workspace = c.get("workspace");

    if (workspace) {
      // For API key auth, verify the URL workspace matches the API key's workspace
      if (workspace._id.toString() !== workspaceId) {
        return c.json(
          {
            success: false,
            error: "API key not authorized for this workspace",
          },
          403,
        );
      }
    } else if (user) {
      // For session auth, verify user has access to this workspace
      const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
      if (!hasAccess) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }
    } else {
      // Neither API key nor session auth succeeded - reject request
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    // Only enrich logging context after authorization succeeds
    enrichContextWithWorkspace(workspaceId);
  }
  await next();
});

// Default content for the custom prompt
const DEFAULT_CUSTOM_PROMPT = `# Custom Prompt Configuration

This is your custom prompt that will be combined with the system prompt to provide additional context about your data and business relationships.

## Business Context
Add information about your business domain, terminology, and key concepts here.

## Data Relationships
Describe important relationships between your collections and how they connect.

## Common Queries
Document frequently requested queries or analysis patterns.

## Custom Instructions
Add any specific instructions for how the AI should interpret your data or respond to certain types of questions.

---

*This prompt is combined with the system prompt to provide context-aware responses. You can edit this through the Settings page.*`;

customPromptRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Custom Prompt"],
    summary: "Get the workspace custom prompt",
    description:
      "Returns the workspace's custom agent prompt, falling back to the default template when unset.",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: {
      200: jsonContent(
        z.object({ success: z.literal(true), content: z.string() }),
        "Custom prompt content.",
      ),
      400: errorJson("Invalid workspace ID"),
      404: errorJson("Workspace not found"),
      500: errorJson("Failed to read custom prompt"),
    },
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");

      if (!Types.ObjectId.isValid(workspaceId)) {
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }

      const workspace = await Workspace.findById(workspaceId);

      if (!workspace) {
        return c.json({ success: false, error: "Workspace not found" }, 404);
      }

      // Return the custom prompt from workspace settings, or default if not set
      const content = workspace.settings.customPrompt || DEFAULT_CUSTOM_PROMPT;

      return c.json({ success: true as const, content }, 200);
    } catch (error) {
      logger.error("Error reading custom prompt", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to read custom prompt",
        },
        500,
      );
    }
  },
);

customPromptRoutes.openapi(
  createRoute({
    method: "put",
    path: "/",
    tags: ["Custom Prompt"],
    summary: "Update the workspace custom prompt",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              content: z
                .string()
                .openapi({ description: "Custom prompt markdown content" }),
            }),
          },
        },
      },
    },
    responses: {
      200: jsonContent(
        z.object({ success: z.literal(true), message: z.string() }),
        "Custom prompt updated.",
      ),
      400: errorJson("Invalid request"),
      404: errorJson("Workspace not found"),
      500: errorJson("Failed to update custom prompt"),
    },
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { content } = c.req.valid("json");

      if (!Types.ObjectId.isValid(workspaceId)) {
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }

      const workspace = await Workspace.findByIdAndUpdate(
        workspaceId,
        {
          "settings.customPrompt": content,
          updatedAt: new Date(),
        },
        { new: true },
      );

      if (!workspace) {
        return c.json({ success: false, error: "Workspace not found" }, 404);
      }

      return c.json(
        {
          success: true as const,
          message: "Custom prompt updated successfully",
        },
        200,
      );
    } catch (error) {
      logger.error("Error updating custom prompt", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to update custom prompt",
        },
        500,
      );
    }
  },
);

customPromptRoutes.openapi(
  createRoute({
    method: "post",
    path: "/reset",
    tags: ["Custom Prompt"],
    summary: "Reset the workspace custom prompt",
    description: "Resets the workspace custom prompt to the default template.",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: {
      200: jsonContent(
        z.object({
          success: z.literal(true),
          message: z.string(),
          content: z.string(),
        }),
        "Custom prompt reset.",
      ),
      400: errorJson("Invalid workspace ID"),
      404: errorJson("Workspace not found"),
      500: errorJson("Failed to reset custom prompt"),
    },
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");

      if (!Types.ObjectId.isValid(workspaceId)) {
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }

      const workspace = await Workspace.findByIdAndUpdate(
        workspaceId,
        {
          "settings.customPrompt": DEFAULT_CUSTOM_PROMPT,
          updatedAt: new Date(),
        },
        { new: true },
      );

      if (!workspace) {
        return c.json({ success: false, error: "Workspace not found" }, 404);
      }

      return c.json(
        {
          success: true as const,
          message: "Custom prompt reset to default",
          content: DEFAULT_CUSTOM_PROMPT,
        },
        200,
      );
    } catch (error) {
      logger.error("Error resetting custom prompt", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to reset custom prompt",
        },
        500,
      );
    }
  },
);
