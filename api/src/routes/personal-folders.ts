/**
 * Personal folders — `/api/workspaces/:workspaceId/personal-folders`.
 *
 * Authenticated + workspace-scoped. A personal folder is one user's private
 * grouping of entities in an explorer (the Apps panel first): you make a
 * folder and put the apps you care about in it, and nobody else ever sees it.
 *
 * Storage semantics — including the fact that this layer cannot touch the
 * entities it groups — live in `services/personal-folders.service.ts`. These
 * handlers only parse input, resolve the actor, and map the service's
 * `{ ok, status, error }` outcome onto the API envelope.
 *
 * Handlers return a plain `Response` under `OPEN_RESPONSES`, the same shape
 * `routes/lib/folder-routes.ts` uses: a service result carries its status as a
 * union (`400 | 404 | 409`), and Hono's typed-response inference demands a
 * single literal per return, so the strict form cannot express "whichever
 * status the service chose".
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";

import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { loggers } from "../logging";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  jsonBody,
  pathParam,
  queryParam,
} from "../openapi/core";
import {
  createPersonalFolder,
  deletePersonalFolder,
  listPersonalFolders,
  renamePersonalFolder,
  setStarred,
  updatePersonalFolderItems,
  DEFAULT_PERSONAL_FOLDER_KIND,
  type PersonalFolderResult,
} from "../services/personal-folders.service";
import { workspaceService } from "../services/workspace.service";

const logger = loggers.api("personal-folders");

export const personalFolderRoutes = createRouter();

const wsParams = z.object({ workspaceId: pathParam("workspaceId") });
const wsIdParams = z.object({
  workspaceId: pathParam("workspaceId"),
  id: pathParam("id"),
});

const routeBase = {
  tags: ["Personal Folders"],
  security: AUTH_SECURITY,
  responses: { ...OPEN_RESPONSES },
};

personalFolderRoutes.use("*", unifiedAuthMiddleware);

personalFolderRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  const user = c.get("user");

  if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
    return c.json(
      { success: false, error: "Invalid workspace ID format" },
      400,
    );
  }

  // A personal folder belongs to a *person*, so an API key acting as the
  // workspace has no folders to read or write — require a real session user
  // rather than inventing a "system" actor whose folders everyone would share.
  if (!user) {
    return c.json({ success: false, error: "Authentication required" }, 401);
  }

  if (!(await workspaceService.hasAccess(workspaceId, user.id))) {
    return c.json({ success: false, error: "Access denied to workspace" }, 403);
  }

  await next();
});

/** The (workspace, user) pair every service call is scoped to. */
function scopeOf(c: AuthenticatedContext) {
  return {
    workspaceId: c.req.param("workspaceId") ?? "",
    userId: String(c.get("user")?.id ?? ""),
  };
}

/**
 * Runs one service op and turns its outcome into the API envelope, with the
 * single try/catch every handler would otherwise repeat. `key` names the
 * payload field so each route keeps its natural response shape.
 */
async function run<T>(
  c: AuthenticatedContext,
  key: "folder" | "id" | "folders",
  op: () => Promise<PersonalFolderResult<T>>,
  failureMessage: string,
): Promise<Response> {
  try {
    const result = await op();
    if (!result.ok) {
      return c.json({ success: false, error: result.error }, result.status);
    }
    return c.json({ success: true, [key]: result.value }, 200);
  } catch (error) {
    logger.error(failureMessage, { error, path: c.req.path });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : failureMessage,
      },
      500,
    );
  }
}

personalFolderRoutes.openapi(
  createRoute({
    method: "get",
    path: "/",
    summary: "List my personal folders",
    description:
      "Lists the calling user's personal folders for an explorer kind. Private to the caller — it never returns another member's folders.",
    ...routeBase,
    request: {
      params: wsParams,
      query: z.object({ kind: queryParam("kind") }),
    },
  }),
  async c =>
    run(
      c,
      "folders",
      async () => ({
        ok: true,
        value: await listPersonalFolders(
          scopeOf(c),
          c.req.query("kind") || DEFAULT_PERSONAL_FOLDER_KIND,
        ),
      }),
      "Failed to list personal folders",
    ),
);

personalFolderRoutes.openapi(
  createRoute({
    method: "post",
    path: "/",
    summary: "Create a personal folder",
    ...routeBase,
    request: {
      params: wsParams,
      body: jsonBody(
        z
          .object({ name: z.string(), kind: z.string().optional() })
          .openapi("CreatePersonalFolderRequest"),
      ),
    },
  }),
  async c => {
    const body = c.req.valid("json");
    return run(
      c,
      "folder",
      () =>
        createPersonalFolder(scopeOf(c), { name: body.name, kind: body.kind }),
      "Failed to create personal folder",
    );
  },
);

personalFolderRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    summary: "Rename a personal folder",
    ...routeBase,
    request: {
      params: wsIdParams,
      body: jsonBody(
        z.object({ name: z.string() }).openapi("RenamePersonalFolderRequest"),
      ),
    },
  }),
  async c => {
    const { id } = c.req.valid("param");
    const { name } = c.req.valid("json");
    return run(
      c,
      "folder",
      () => renamePersonalFolder(scopeOf(c), { folderId: id, name }),
      "Failed to rename personal folder",
    );
  },
);

personalFolderRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    summary: "Delete a personal folder",
    description:
      "Removes the grouping only. The entities it listed are untouched.",
    ...routeBase,
    request: { params: wsIdParams },
  }),
  async c => {
    const { id } = c.req.valid("param");
    return run(
      c,
      "id",
      () => deletePersonalFolder(scopeOf(c), id),
      "Failed to delete personal folder",
    );
  },
);

personalFolderRoutes.openapi(
  createRoute({
    method: "patch",
    path: "/{id}/items",
    summary: "Add or remove items in a personal folder",
    description:
      "Membership is a set, so repeating an add is harmless. Items are entity keys — an app's slug. A key sent in both `add` and `remove` is removed.",
    ...routeBase,
    request: {
      params: wsIdParams,
      body: jsonBody(
        z
          .object({
            add: z.array(z.string()).optional(),
            remove: z.array(z.string()).optional(),
          })
          .openapi("UpdatePersonalFolderItemsRequest"),
      ),
    },
  }),
  async c => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    return run(
      c,
      "folder",
      () =>
        updatePersonalFolderItems(scopeOf(c), {
          folderId: id,
          add: body.add,
          remove: body.remove,
        }),
      "Failed to update personal folder",
    );
  },
);

personalFolderRoutes.openapi(
  createRoute({
    method: "post",
    path: "/star",
    summary: "Star or unstar an item",
    description:
      "Toggles an entity key in the caller's Starred list for an explorer kind, creating the list on first use. A star is a shortcut: the entity stays where it is and is also pinned on top. Idempotent.",
    ...routeBase,
    request: {
      params: wsParams,
      body: jsonBody(
        z
          .object({
            key: z.string(),
            starred: z.boolean(),
            kind: z.string().optional(),
          })
          .openapi("SetStarredRequest"),
      ),
    },
  }),
  async c => {
    const body = c.req.valid("json");
    return run(
      c,
      "folder",
      () =>
        setStarred(scopeOf(c), {
          kind: body.kind,
          key: body.key,
          starred: body.starred,
        }),
      "Failed to update starred items",
    );
  },
);
