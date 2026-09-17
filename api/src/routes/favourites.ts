/**
 * Favourites — `/api/workspaces/:workspaceId/favourites`.
 *
 * One person's bookmark tree over the workspace's apps, consoles, notebooks
 * and dashboards. Authenticated + workspace-scoped; a real session user is
 * required, because favourites belong to a person and an API key acting as
 * the workspace has none. Semantics live in `services/favourites.service.ts`;
 * these handlers parse input and map `{ ok, status, error }` onto the API
 * envelope.
 *
 * Handlers return a plain `Response` under `OPEN_RESPONSES`, as
 * `routes/lib/folder-routes.ts` does: a service result carries its status as
 * a union and Hono's typed-response inference wants one literal per return.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { loggers } from "../logging";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import {
  addFavourite,
  createFavouriteFolder,
  deleteFavourite,
  listFavourites,
  removeFavouriteByRef,
  updateFavourite,
  type FavouriteResult,
} from "../services/favourites.service";
import { workspaceService } from "../services/workspace.service";

const logger = loggers.api("favourites");

export const favouriteRoutes = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
const IdParam = WorkspaceParam.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});
const KindRefParam = WorkspaceParam.extend({
  kind: z
    .enum(["app", "console", "notebook", "dashboard"])
    .openapi({ param: { name: "kind", in: "path" } }),
  refId: z.string().openapi({ param: { name: "refId", in: "path" } }),
});

favouriteRoutes.use("*", unifiedAuthMiddleware);

favouriteRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  const user = c.get("user");
  if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
    return c.json(
      { success: false, error: "Invalid workspace ID format" },
      400,
    );
  }
  if (!user) {
    return c.json({ success: false, error: "Authentication required" }, 401);
  }
  if (!(await workspaceService.hasAccess(workspaceId, user.id))) {
    return c.json({ success: false, error: "Access denied to workspace" }, 403);
  }
  await next();
});

function scopeOf(c: AuthenticatedContext) {
  return {
    workspaceId: c.req.param("workspaceId") as string,
    userId: c.get("user")!.id,
  };
}

function reply<T>(
  c: AuthenticatedContext,
  result: FavouriteResult<T>,
  key: string,
): Response {
  if (!result.ok) {
    return c.json({ success: false, error: result.error }, result.status);
  }
  return c.json({ success: true, [key]: result.value }, 200);
}

function handleError(c: AuthenticatedContext, error: unknown): Response {
  logger.error("Favourites route error", { error });
  return c.json(
    {
      success: false,
      error: error instanceof Error ? error.message : "Internal error",
    },
    500,
  );
}

favouriteRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Favourites"],
    summary: "List the caller's favourites (folders and items, all kinds)",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const favourites = await listFavourites(scopeOf(c));
      return c.json({ success: true as const, favourites }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

favouriteRoutes.openapi(
  createRoute({
    method: "post",
    path: "/folders",
    tags: ["Favourites"],
    summary: "Create a favourites folder",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              title: z.string().min(1),
              parentId: z.string().nullable().optional(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const body = c.req.valid("json");
      return reply(
        c,
        await createFavouriteFolder(scopeOf(c), body),
        "favourite",
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

favouriteRoutes.openapi(
  createRoute({
    method: "put",
    path: "/items/{kind}/{refId}",
    tags: ["Favourites"],
    summary: "Star an entity (idempotent), optionally into a folder",
    security: AUTH_SECURITY,
    request: {
      params: KindRefParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({ parentId: z.string().nullable().optional() }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { kind, refId } = c.req.valid("param");
      const body = c.req.valid("json") ?? {};
      return reply(
        c,
        await addFavourite(scopeOf(c), {
          kind,
          refId,
          parentId: body.parentId,
        }),
        "favourite",
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

favouriteRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/items/{kind}/{refId}",
    tags: ["Favourites"],
    summary: "Unstar an entity",
    security: AUTH_SECURITY,
    request: { params: KindRefParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { kind, refId } = c.req.valid("param");
      const result = await removeFavouriteByRef(scopeOf(c), { kind, refId });
      return c.json({ success: true as const, ...result }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

favouriteRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Favourites"],
    summary: "Move, reorder or rename a favourite",
    security: AUTH_SECURITY,
    request: {
      params: IdParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              parentId: z.string().nullable().optional(),
              position: z.number().int().min(0).optional(),
              title: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      return reply(c, await updateFavourite(scopeOf(c), id, body), "favourite");
    } catch (error) {
      return handleError(c, error);
    }
  },
);

favouriteRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Favourites"],
    summary: "Delete a favourite (a folder takes its subtree with it)",
    security: AUTH_SECURITY,
    request: { params: IdParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { id } = c.req.valid("param");
      return reply(c, await deleteFavourite(scopeOf(c), id), "result");
    } catch (error) {
      return handleError(c, error);
    }
  },
);
