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
import { loggers } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import {
  deleteSkillById,
  getSkillForAdmin,
  listSkillsForAdmin,
  saveSkill,
  setSkillPinned,
  toggleSkillSuppressed,
} from "../services/skills.service";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import { RepoRequiredError } from "../apps/config";
import { fail, failFromThrown } from "./lib/respond";
import { requireWorkspaceAccess } from "./lib/workspace-access";

const logger = loggers.api("skills");

export const skillsRoutes = createRouter();

function repoRequired(c: AuthenticatedContext, error: RepoRequiredError) {
  return fail(c, error.status as 412, error.message, { code: error.code });
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
skillsRoutes.use("*", requireWorkspaceAccess());

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
        return fail(c, 400, "Valid workspace ID is required");
      }
      const skills = await listSkillsForAdmin(workspaceId);
      return c.json({ success: true, skills });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json({ success: true, skills: [] }, 200);
      }
      logger.error("Error listing skills", { error });
      return failFromThrown(c, error, "Failed to list skills");
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
        return fail(c, 400, "Valid workspace ID is required");
      }
      const skill = await getSkillForAdmin(workspaceId, id);
      if (!skill) {
        return fail(c, 404, "Skill not found");
      }
      return c.json({ success: true, skill });
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return fail(c, 404, "Skill not found");
      }
      logger.error("Error getting skill", { error });
      return failFromThrown(c, error, "Failed to get skill");
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
              pinned: z.boolean().optional(),
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
        return fail(c, 400, "Valid workspace ID is required");
      }
      const existing = await getSkillForAdmin(workspaceId, id);
      if (!existing) {
        return fail(c, 404, "Skill not found");
      }
      const body = (await c.req.json()) as {
        loadWhen?: unknown;
        body?: unknown;
        entities?: unknown;
        pinned?: unknown;
      };
      const user = c.get("user");
      const actorId = user?.id ?? "git";

      const nextLoadWhen =
        typeof body.loadWhen === "string" ? body.loadWhen : existing.loadWhen;
      const nextBody =
        typeof body.body === "string" ? body.body : existing.body;
      const nextEntities = Array.isArray(body.entities)
        ? body.entities.filter((e): e is string => typeof e === "string")
        : undefined;

      const nextPinned =
        typeof body.pinned === "boolean" ? body.pinned : undefined;
      const result = await saveSkill(
        workspaceId,
        {
          name: existing.name,
          loadWhen: nextLoadWhen,
          body: nextBody,
          entities: nextEntities,
          pinned: nextPinned,
        },
        actorId,
      );
      if (!result.success) {
        return fail(c, 400, result.error);
      }
      return c.json({ success: true, skill: result.skill });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error updating skill", { error });
      return failFromThrown(c, error, "Failed to update skill");
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
        return fail(c, 400, "Valid workspace ID is required");
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
        return fail(c, 404, "Skill not found");
      }
      return c.json({ success: true, suppressed });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error toggling skill suppressed", { error });
      return failFromThrown(c, error, "Failed to update suppressed flag");
    }
  },
);

skillsRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/pin",
    tags: ["Skills"],
    summary: "Pin or unpin a skill (full body in every prompt)",
    security: AUTH_SECURITY,
    request: {
      params: SkillIdParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({ pinned: z.boolean().optional() }),
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
        return fail(c, 400, "Valid workspace ID is required");
      }
      const body = (await c.req.json().catch(() => ({}))) as {
        pinned?: unknown;
      };
      const pinned = typeof body.pinned === "boolean" ? body.pinned : true;
      const ok = await setSkillPinned(
        workspaceId,
        id,
        pinned,
        c.get("user")?.id,
      );
      if (!ok) {
        return fail(c, 404, "Skill not found");
      }
      return c.json({ success: true, pinned });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error toggling skill pinned", { error });
      return failFromThrown(c, error, "Failed to update pinned flag");
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
        return fail(c, 400, "Valid workspace ID is required");
      }
      const ok = await deleteSkillById(workspaceId, id, c.get("user")?.id);
      if (!ok) {
        return fail(c, 404, "Skill not found");
      }
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof RepoRequiredError) return repoRequired(c, error);
      logger.error("Error deleting skill", { error });
      return failFromThrown(c, error, "Failed to delete skill");
    }
  },
);
