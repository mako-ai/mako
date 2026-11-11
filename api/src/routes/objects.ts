/**
 * Rename and name resolution for every object kind (api/src/rename).
 * Mounted at `/api/workspaces/:workspaceId/objects`.
 *
 *   GET  /resolve?kind=&ref=   — what an id, a name or an old name points at
 *                                now (the UI's dead-link fallback)
 *   POST /{kind}/rename        — { ref, title?, slug?, options? }
 *
 * A kind with no rename handler yet answers 501 on both.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { loggers, enrichContextWithWorkspace } from "../logging";
import {
  isSessionAuth,
  unifiedAuthMiddleware,
} from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import { renameObject, resolveObjectRef } from "../rename/registry";
import { RENAME_KINDS, RenameError, type RenameContext } from "../rename/types";

const logger = loggers.api("objects");

export const objectRoutes = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
const KindParam = WorkspaceParam.extend({
  kind: z.enum(RENAME_KINDS).openapi({ param: { name: "kind", in: "path" } }),
});

objectRoutes.use("*", unifiedAuthMiddleware);

objectRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
    return c.json(
      { success: false, error: "Valid workspace ID is required" },
      400,
    );
  }
  const user = c.get("user");
  const workspace = c.get("workspace");
  if (workspace) {
    if (workspace._id.toString() !== workspaceId) {
      return c.json(
        { success: false, error: "API key not authorized for this workspace" },
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

async function contextFor(
  c: AuthenticatedContext,
  workspaceId: string,
): Promise<RenameContext> {
  const user = c.get("user");
  const role = user
    ? (await workspaceService.getMember(workspaceId, user.id))?.role
    : undefined;
  // String(): a legacy API key carries its creator as an ObjectId, and the
  // handlers compare ids as strings.
  return { workspaceId, userId: user ? String(user.id) : undefined, role };
}

function failure(c: AuthenticatedContext, error: unknown, what: string) {
  if (error instanceof RenameError) {
    return c.json({ success: false, error: error.message }, error.status);
  }
  logger.error(`Error ${what}`, { error });
  return c.json(
    {
      success: false,
      error: error instanceof Error ? error.message : `Failed: ${what}`,
    },
    500,
  );
}

objectRoutes.openapi(
  createRoute({
    method: "get",
    path: "/resolve",
    tags: ["Objects"],
    summary: "Resolve an object ref (id, name, or a previous name)",
    description:
      "What a link or name points at now. `via: alias` means the ref is an old name of a renamed object — redirect to `current.url`. 404 when nothing, or more than one object, answers to the ref.",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({
        kind: z.enum(RENAME_KINDS),
        ref: z.string().trim().min(1).max(1000),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { kind, ref } = c.req.valid("query");
      const resolved = await resolveObjectRef(
        await contextFor(c, workspaceId),
        kind,
        ref,
      );
      if (!resolved) {
        return c.json({ success: false, error: "Not found" }, 404);
      }
      return c.json({ success: true, resolved });
    } catch (error) {
      return failure(c, error, "resolving object ref");
    }
  },
);

objectRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{kind}/rename",
    tags: ["Objects"],
    summary: "Rename an object; its id does not change",
    description:
      "Signed-in users only. API keys and MCP clients rename through the `rename_object` tool, where their scopes and grants apply.",
    security: AUTH_SECURITY,
    request: {
      params: KindParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              ref: z.string().min(1).max(1000),
              title: z.string().min(1).max(1000).optional(),
              slug: z.string().min(1).max(500).optional(),
              options: z.record(z.string(), z.unknown()).optional(),
            }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const { workspaceId, kind } = c.req.valid("param");
      const ctx = await contextFor(c, workspaceId);
      if (!isSessionAuth(c) || !ctx.userId) {
        // A key always carries its creator as `user`, so a user id check
        // alone would let an unscoped key through.
        return c.json(
          { success: false, error: "Renaming requires a signed-in user" },
          403,
        );
      }
      const result = await renameObject(ctx, kind, c.req.valid("json"));
      return c.json({ success: true, result });
    } catch (error) {
      return failure(c, error, "renaming object");
    }
  },
);
