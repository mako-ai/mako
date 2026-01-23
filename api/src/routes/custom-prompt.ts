import { Hono } from "hono";
import { Types } from "mongoose";
import { Workspace } from "../database/workspace-schema";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";

const logger = loggers.workspace();

export const customPromptRoutes = new Hono();

// Apply unified auth middleware to all custom prompt routes
customPromptRoutes.use("*", unifiedAuthMiddleware);

// Middleware to verify workspace access and enrich logging context
customPromptRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) {
    // Verify user has access to this workspace (for session auth)
    const user = c.get("user");
    if (user) {
      const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
      if (!hasAccess) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }
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

// GET /api/workspaces/:workspaceId/custom-prompt - Get the current custom prompt content
customPromptRoutes.get("/", async c => {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const workspaceId = c.req.param("workspaceId") as string;

    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      return c.json(
        {
          success: false,
          error: "Valid workspace ID is required",
        },
        400,
      );
    }

    const workspace = await Workspace.findById(workspaceId);

    if (!workspace) {
      return c.json(
        {
          success: false,
          error: "Workspace not found",
        },
        404,
      );
    }

    // Return the custom prompt from workspace settings, or default if not set
    const content = workspace.settings.customPrompt || DEFAULT_CUSTOM_PROMPT;

    return c.json({
      success: true,
      content: content,
    });
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
});

// PUT /api/workspaces/:workspaceId/custom-prompt - Update the custom prompt content
customPromptRoutes.put("/", async c => {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const workspaceId = c.req.param("workspaceId") as string;
    const body = await c.req.json();

    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      return c.json(
        {
          success: false,
          error: "Valid workspace ID is required",
        },
        400,
      );
    }

    if (!body.content && body.content !== "") {
      return c.json(
        {
          success: false,
          error: "Content is required",
        },
        400,
      );
    }

    const workspace = await Workspace.findByIdAndUpdate(
      workspaceId,
      {
        "settings.customPrompt": body.content,
        updatedAt: new Date(),
      },
      { new: true },
    );

    if (!workspace) {
      return c.json(
        {
          success: false,
          error: "Workspace not found",
        },
        404,
      );
    }

    return c.json({
      success: true,
      message: "Custom prompt updated successfully",
    });
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
});

// POST /api/workspaces/:workspaceId/custom-prompt/reset - Reset custom prompt to default
customPromptRoutes.post("/reset", async c => {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const workspaceId = c.req.param("workspaceId") as string;

    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      return c.json(
        {
          success: false,
          error: "Valid workspace ID is required",
        },
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
      return c.json(
        {
          success: false,
          error: "Workspace not found",
        },
        404,
      );
    }

    return c.json({
      success: true,
      message: "Custom prompt reset to default",
      content: DEFAULT_CUSTOM_PROMPT,
    });
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
});
