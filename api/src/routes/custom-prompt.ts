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
import { prepareAgentTurnGuidance } from "../services/agent-turn-preparation.service";
import { RepoRequiredError } from "../apps/config";
import {
  commitWorkspacePrompt,
  readWorkspacePromptFile,
  readWorkspaceSelfDirectiveFile,
} from "../apps/workspace-prompt";

const logger = loggers.workspace();

export const customPromptRoutes = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});

const TurnGuidanceBody = z.object({
  userText: z.string().min(1).max(100_000),
  includeDbtRules: z.boolean().default(false),
  dbtProjectId: z.string().optional(),
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
        z.object({
          success: z.literal(true),
          content: z.string(),
          /** Agent-learned workspace rules (also used by Local ACP append). */
          selfDirective: z.string().optional(),
        }),
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
      // The prompt lives in the workspace repo (PROMPT.md, apps.md §21);
      // the Mongo field is the pre-migration fallback for repo-less
      // workspaces.
      const content =
        (await readWorkspacePromptFile(workspaceId)) ?? DEFAULT_CUSTOM_PROMPT;
      const selfDirective =
        (await readWorkspaceSelfDirectiveFile(workspaceId)) ?? "";

      return c.json(
        {
          success: true as const,
          content,
          ...(selfDirective.trim() ? { selfDirective } : {}),
        },
        200,
      );
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
    method: "post",
    path: "/turn-guidance",
    tags: ["Custom Prompt"],
    summary: "Prepare budgeted agent guidance for one turn",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        required: true,
        content: { "application/json": { schema: TurnGuidanceBody } },
      },
    },
    responses: {
      200: jsonContent(
        z.object({
          success: z.literal(true),
          skillsBlock: z.string(),
          dbtRulesBlock: z.string(),
        }),
        "Prepared turn guidance.",
      ),
      400: errorJson("Invalid request"),
      403: errorJson("Access denied"),
      500: errorJson("Failed to prepare guidance"),
    },
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const user = c.get("user");
      const input = c.req.valid("json");
      const guidance = await prepareAgentTurnGuidance({
        workspaceId,
        userId: user ? String(user.id) : undefined,
        userText: input.userText,
        includeDbtRules: input.includeDbtRules,
        dbtProjectId: input.dbtProjectId,
      });
      return c.json({ success: true as const, ...guidance }, 200);
    } catch (error) {
      logger.error("Error preparing turn guidance", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to prepare guidance",
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
      412: jsonContent(
        z.object({
          success: z.literal(false),
          error: z.string(),
          code: z.string(),
        }),
        "Connect a GitHub repository first (the prompt lives in the workspace repo).",
      ),
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

      const workspace = await Workspace.findById(workspaceId).select("_id");
      if (!workspace) {
        return c.json({ success: false, error: "Workspace not found" }, 404);
      }

      // A save is a commit of PROMPT.md on the workspace repo's default
      // branch. The legacy Mongo field is cleared so it can never shadow
      // the file for readers still falling back to it.
      await commitWorkspacePrompt(workspaceId, content, c.get("user")?.id);
      await Workspace.updateOne(
        { _id: workspace._id },
        { $unset: { "settings.customPrompt": "" } },
      );

      return c.json(
        {
          success: true as const,
          message: "Custom prompt updated successfully",
        },
        200,
      );
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json(
          {
            success: false as const,
            error: error.message,
            code: error.code as string,
          },
          412,
        );
      }
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
      412: jsonContent(
        z.object({
          success: z.literal(false),
          error: z.string(),
          code: z.string(),
        }),
        "Connect a GitHub repository first (the prompt lives in the workspace repo).",
      ),
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

      const workspace = await Workspace.findById(workspaceId).select("_id");
      if (!workspace) {
        return c.json({ success: false, error: "Workspace not found" }, 404);
      }

      await commitWorkspacePrompt(
        workspaceId,
        DEFAULT_CUSTOM_PROMPT,
        c.get("user")?.id,
      );
      await Workspace.updateOne(
        { _id: workspace._id },
        { $unset: { "settings.customPrompt": "" } },
      );

      return c.json(
        {
          success: true as const,
          message: "Custom prompt reset to default",
          content: DEFAULT_CUSTOM_PROMPT,
        },
        200,
      );
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json(
          {
            success: false as const,
            error: error.message,
            code: error.code as string,
          },
          412,
        );
      }
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
