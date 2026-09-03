/**
 * Skills admin routes (issue #365).
 *
 * Mounted at `/api/workspaces/:workspaceId/skills`. All routes require
 * authentication via unifiedAuthMiddleware and workspace access via the
 * same pattern as custom-prompt.ts.
 *
 * Agent-side skill CRUD lives in agent-lib/tools/skill-tools.ts — these
 * routes are for the workspace admin UI: list, get, update, delete, and
 * toggle-suppress.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import {
  deleteSkillById,
  getSkillForAdmin,
  listSkillsForAdmin,
  saveSkill,
  toggleSkillSuppressed,
} from "../services/skills.service";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import { RepoRequiredError } from "../apps/config";

const logger = loggers.api("skills");

export const skillsRoutes = createRouter();

function repoRequired(c: AuthenticatedContext, error: RepoRequiredError) {
  return c.json(
    { success: false, code: error.code, error: error.message },
    error.status as 412,
  );
}

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
const SkillIdParam = WorkspaceParam.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

skillsRoutes.use("*", unifiedAuthMiddleware);

// Workspace access check — mirrors custom-prompt.ts
skillsRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    await next();
    return;
  }
  const user = c.get("user");
  const workspace = c.get("workspace");

  if (workspace) {
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
    const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
    if (!hasAccess) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }
  } else {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  enrichContextWithWorkspace(workspaceId);
  await next();
});

skillsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Skills"],
    summary: "List skills",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }
      const skills = await listSkillsForAdmin(workspaceId);
      return c.json({ success: true, skills });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json({ success: true, skills: [] }, 200);
      }
      logger.error("Error listing skills", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to list skills",
        },
        500,
      );
    }
  },
);

skillsRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Skills"],
    summary: "Get a skill",
    security: AUTH_SECURITY,
    request: { params: SkillIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }
      const skill = await getSkillForAdmin(workspaceId, id);
      if (!skill) {
        return c.json({ success: false, error: "Skill not found" }, 404);
      }
      return c.json({
        success: true,
        skill: {
          id: skill.id,
          name: skill.name,
          loadWhen: skill.loadWhen,
          body: skill.body,
          entities: skill.entities ?? [],
          suppressed: !!skill.suppressed,
          useCount: skill.useCount ?? 0,
          lastUsedAt: skill.lastUsedAt ?? null,
          createdBy: skill.createdBy,
          createdAt: skill.createdAt,
          updatedAt: skill.updatedAt,
          previousBody: skill.previousBody ?? null,
          previousUpdatedAt: skill.previousUpdatedAt ?? null,
          definitionInvalid: skill.definitionInvalid ?? null,
        },
      });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json({ success: false, error: "Skill not found" }, 404);
      }
      logger.error("Error getting skill", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get skill",
        },
        500,
      );
    }
  },
);

skillsRoutes.openapi(
  createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Skills"],
    summary: "Update a skill",
    security: AUTH_SECURITY,
    request: {
      params: SkillIdParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({
              loadWhen: z.string().optional(),
              body: z.string().optional(),
              entities: z.array(z.string()).optional(),
            }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }
      const existing = await getSkillForAdmin(workspaceId, id);
      if (!existing) {
        return c.json({ success: false, error: "Skill not found" }, 404);
      }
      const body = (await c.req.json()) as {
        loadWhen?: unknown;
        body?: unknown;
        entities?: unknown;
      };
      const user = c.get("user");
      const actorId = user?.id ?? existing.createdBy ?? "git";

      const nextLoadWhen =
        typeof body.loadWhen === "string" ? body.loadWhen : existing.loadWhen;
      const nextBody =
        typeof body.body === "string" ? body.body : existing.body;
      const nextEntities = Array.isArray(body.entities)
        ? body.entities.filter((e): e is string => typeof e === "string")
        : undefined;

      const result = await saveSkill(
        workspaceId,
        {
          name: existing.name,
          loadWhen: nextLoadWhen,
          body: nextBody,
          entities: nextEntities,
        },
        actorId,
      );
      if (!result.success) {
        return c.json({ success: false, error: result.error }, 400);
      }
      return c.json({ success: true, skill: result.skill });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error updating skill", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to update skill",
        },
        500,
      );
    }
  },
);

skillsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/suppress",
    tags: ["Skills"],
    summary: "Toggle skill suppression",
    security: AUTH_SECURITY,
    request: {
      params: SkillIdParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({ suppressed: z.boolean().optional() }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }
      const body = (await c.req.json().catch(() => ({}))) as {
        suppressed?: unknown;
      };
      const suppressed =
        typeof body.suppressed === "boolean" ? body.suppressed : true;
      const ok = await toggleSkillSuppressed(
        workspaceId,
        id,
        suppressed,
        c.get("user")?.id,
      );
      if (!ok) {
        return c.json({ success: false, error: "Skill not found" }, 404);
      }
      return c.json({ success: true, suppressed });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error toggling skill suppressed", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to update suppressed flag",
        },
        500,
      );
    }
  },
);

skillsRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Skills"],
    summary: "Delete a skill",
    security: AUTH_SECURITY,
    request: { params: SkillIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const id = c.req.param("id");
      if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
        return c.json(
          { success: false, error: "Valid workspace ID is required" },
          400,
        );
      }
      const ok = await deleteSkillById(workspaceId, id, c.get("user")?.id);
      if (!ok) {
        return c.json({ success: false, error: "Skill not found" }, 404);
      }
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error deleting skill", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to delete skill",
        },
        500,
      );
    }
  },
);
