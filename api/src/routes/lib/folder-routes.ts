/**
 * Folder CRUD + move routes shared by every foldered resource kind
 * (consoles, notebooks, dashboards). Each kind used to hand-roll the same
 * five handlers — create/rename/delete/move folder plus move-item — with
 * drifting validation, permissions, and error envelopes (dashboards' folder
 * move had no permission check at all; consoles' rename had none either).
 *
 * The registrar owns the route shape: typed request bodies, ObjectId
 * validation, the `{ success, data?, error? }` envelope, and the try/catch.
 * A `FolderBackend` owns the storage semantics; `createModelFolderBackend`
 * covers the plain-Mongoose kinds (notebooks, dashboards) so a kind only
 * supplies its item-move logic, while consoles wrap their git-backed
 * manager.
 *
 * Permission rule, applied uniformly: writing a folder (rename/delete/move)
 * requires `canWriteResource` on it — the owner, an admin, or any member
 * for workspace-access folders. Creating a folder only requires workspace
 * membership (the router middleware's job).
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { Types, type Model } from "mongoose";

import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  jsonBody,
  pathParam,
  type AuthEnv,
} from "../../openapi/core";
import { canWriteResource } from "../../utils/resource-acl";
import {
  collectDescendantFolderIds,
  wouldCreateFolderCycle,
} from "../../utils/folder-tree";
import { loggers } from "../../logging";

const logger = loggers.api("folder-routes");

export type FolderAccessLevel = "private" | "workspace";

/** Who is asking. `role` is the workspace member role set by the router. */
export interface FolderOpContext {
  workspaceId: string;
  userId: string;
  role: string | undefined;
}

/** What a backend op reports; the registrar turns it into the envelope. */
export type FolderOpResult =
  | { ok: true; data?: Record<string, unknown> }
  | { ok: false; status: 400 | 403 | 404; error: string };

export interface FolderBackend {
  createFolder(
    ctx: FolderOpContext,
    input: {
      name: string;
      parentId: string | null;
      access: FolderAccessLevel | undefined;
    },
  ): Promise<FolderOpResult>;
  renameFolder(
    ctx: FolderOpContext,
    input: { folderId: string; name: string },
  ): Promise<FolderOpResult>;
  deleteFolder(
    ctx: FolderOpContext,
    input: { folderId: string },
  ): Promise<FolderOpResult>;
  moveFolder(
    ctx: FolderOpContext,
    input: {
      folderId: string;
      parentId: string | null | undefined;
      access: FolderAccessLevel | undefined;
    },
  ): Promise<FolderOpResult>;
  moveItem(
    ctx: FolderOpContext,
    input: {
      itemId: string;
      folderId: string | null | undefined;
      access: FolderAccessLevel | undefined;
    },
  ): Promise<FolderOpResult>;
}

export interface FolderRoutesConfig {
  /** OpenAPI tag, e.g. "Notebooks". */
  tag: string;
  /** Prefix for OpenAPI schema names, e.g. "Notebook" → CreateNotebookFolderRequest. */
  schemaPrefix: string;
  backend: FolderBackend;
  /** Per-route middleware for routers that don't mount auth at router level. */
  middleware?: readonly MiddlewareHandler[];
  /**
   * "user-required": reject requests with no session user (consoles,
   * dashboards). "allow-system": API-key requests act as "system"
   * (notebooks).
   */
  actor?: "user-required" | "allow-system";
  /** Called after any successful mutation (e.g. publish a tree-updated event). */
  afterChange?: (workspaceId: string) => void;
  /** Map a thrown kind-specific error to a response (consoles' RepoRequiredError). */
  onError?: (c: Context, error: unknown) => Response | undefined;
  /** Status for a successful folder creation (consoles historically 201). */
  createdStatus?: 200 | 201;
}

function isValidObjectId(id: string | null | undefined): boolean {
  return id == null || Types.ObjectId.isValid(id);
}

const ACCESS = z.enum(["private", "workspace"]);

export function registerFolderRoutes(
  router: OpenAPIHono<AuthEnv>,
  config: FolderRoutesConfig,
): void {
  const { tag, schemaPrefix, backend, middleware, afterChange, onError } =
    config;

  const wsParams = z.object({ workspaceId: pathParam("workspaceId") });
  const wsIdParams = z.object({
    workspaceId: pathParam("workspaceId"),
    id: pathParam("id"),
  });

  const routeBase = {
    tags: [tag],
    security: AUTH_SECURITY,
    ...(middleware ? { middleware: [...middleware] } : {}),
    responses: { ...OPEN_RESPONSES },
  };

  /**
   * Shared handler shell: resolve the actor, run the op, apply the envelope.
   * `body` is read defensively (schemas document the contract; handlers must
   * not 500 on a missing body).
   */
  const run = async (
    c: Context,
    op: (ctx: FolderOpContext) => Promise<FolderOpResult>,
    successStatus: 200 | 201 = 200,
  ): Promise<Response> => {
    const workspaceId = c.req.param("workspaceId") ?? "";
    const user = c.get("user") as { id?: unknown } | undefined;
    if (!user && config.actor !== "allow-system") {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    const ctx: FolderOpContext = {
      workspaceId,
      userId: String(user?.id ?? "system"),
      role: c.get("memberRole") as string | undefined,
    };
    try {
      const result = await op(ctx);
      if (!result.ok) {
        return c.json({ success: false, error: result.error }, result.status);
      }
      afterChange?.(workspaceId);
      return c.json(
        { success: true, ...(result.data ? { data: result.data } : {}) },
        successStatus,
      );
    } catch (error) {
      const mapped = onError?.(c, error);
      if (mapped) return mapped;
      logger.error(`Folder route error (${tag})`, {
        path: c.req.path,
        error,
      });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  };

  const readBody = async (c: Context): Promise<Record<string, unknown>> =>
    ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  // POST /folders — create
  router.openapi(
    createRoute({
      method: "post",
      path: "/folders",
      summary: "POST /folders",
      ...routeBase,
      request: {
        params: wsParams,
        body: jsonBody(
          z
            .object({
              name: z.string(),
              parentId: z.string().nullable().optional(),
              access: ACCESS.optional(),
            })
            .openapi(`Create${schemaPrefix}FolderRequest`),
          true,
        ),
      },
    }),
    async c => {
      const body = await readBody(c);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const parentId = typeof body.parentId === "string" ? body.parentId : null;
      const access = body.access as FolderAccessLevel | undefined;
      return run(
        c,
        async ctx => {
          if (!name) {
            return {
              ok: false,
              status: 400,
              error: "Folder name is required",
            };
          }
          if (!isValidObjectId(parentId)) {
            return { ok: false, status: 400, error: "Invalid parentId" };
          }
          return backend.createFolder(ctx, { name, parentId, access });
        },
        config.createdStatus ?? 200,
      );
    },
  );

  // PATCH /folders/{id}/rename
  router.openapi(
    createRoute({
      method: "patch",
      path: "/folders/{id}/rename",
      summary: "PATCH /folders/{id}/rename",
      ...routeBase,
      request: {
        params: wsIdParams,
        body: jsonBody(
          z
            .object({ name: z.string() })
            .openapi(`Rename${schemaPrefix}FolderRequest`),
          true,
        ),
      },
    }),
    async c => {
      const folderId = c.req.param("id") ?? "";
      const body = await readBody(c);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      return run(c, async ctx => {
        if (!name) {
          return { ok: false, status: 400, error: "Folder name is required" };
        }
        if (!Types.ObjectId.isValid(folderId)) {
          return { ok: false, status: 404, error: "Folder not found" };
        }
        return backend.renameFolder(ctx, { folderId, name });
      });
    },
  );

  // DELETE /folders/{id}
  router.openapi(
    createRoute({
      method: "delete",
      path: "/folders/{id}",
      summary: "DELETE /folders/{id}",
      ...routeBase,
      request: { params: wsIdParams },
    }),
    async c => {
      const folderId = c.req.param("id") ?? "";
      return run(c, async ctx => {
        if (!Types.ObjectId.isValid(folderId)) {
          return { ok: false, status: 404, error: "Folder not found" };
        }
        return backend.deleteFolder(ctx, { folderId });
      });
    },
  );

  // PATCH /folders/{id}/move
  router.openapi(
    createRoute({
      method: "patch",
      path: "/folders/{id}/move",
      summary: "PATCH /folders/{id}/move",
      ...routeBase,
      request: {
        params: wsIdParams,
        body: jsonBody(
          z
            .object({
              parentId: z.string().nullable().optional(),
              access: ACCESS.optional(),
            })
            .openapi(`Move${schemaPrefix}FolderRequest`),
          true,
        ),
      },
    }),
    async c => {
      const folderId = c.req.param("id") ?? "";
      const body = await readBody(c);
      const parentId = body.parentId as string | null | undefined;
      const access = body.access as FolderAccessLevel | undefined;
      return run(c, async ctx => {
        if (!Types.ObjectId.isValid(folderId)) {
          return { ok: false, status: 404, error: "Folder not found" };
        }
        if (typeof parentId === "string" && !Types.ObjectId.isValid(parentId)) {
          return { ok: false, status: 400, error: "Invalid parentId" };
        }
        return backend.moveFolder(ctx, { folderId, parentId, access });
      });
    },
  );

  // PATCH /{id}/move — move the resource itself into a folder / change access
  router.openapi(
    createRoute({
      method: "patch",
      path: "/{id}/move",
      summary: "PATCH /{id}/move",
      ...routeBase,
      request: {
        params: wsIdParams,
        body: jsonBody(
          z
            .object({
              folderId: z.string().nullable().optional(),
              access: ACCESS.optional(),
            })
            .openapi(`Move${schemaPrefix}Request`),
          true,
        ),
      },
    }),
    async c => {
      const itemId = c.req.param("id") ?? "";
      const body = await readBody(c);
      const folderId = body.folderId as string | null | undefined;
      const access = body.access as FolderAccessLevel | undefined;
      return run(c, async ctx => {
        if (typeof folderId === "string" && !Types.ObjectId.isValid(folderId)) {
          return { ok: false, status: 400, error: "Invalid folderId" };
        }
        return backend.moveItem(ctx, { itemId, folderId, access });
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Model-backed backend (notebooks, dashboards)
// ---------------------------------------------------------------------------

interface FolderDocLike {
  _id: Types.ObjectId;
  name: string;
  parentId?: Types.ObjectId | null;
  ownerId?: string;
  access?: FolderAccessLevel;
  save(): Promise<unknown>;
}

function canWriteFolderDoc(
  folder: FolderDocLike,
  ctx: FolderOpContext,
): boolean {
  return canWriteResource(
    { owner_id: folder.ownerId, access: folder.access || "private" },
    ctx.userId,
    ctx.role,
    { effectiveAccess: folder.access || "private" },
  );
}

/**
 * FolderBackend over a plain Mongoose folder model. The kind supplies only
 * its item model (to unlink items when folders are deleted) and its
 * item-move logic, which is where the kinds genuinely differ.
 */
export function createModelFolderBackend(opts: {
  // Mongoose models are invariant in their document generics; the backend
  // only touches the FolderDocLike surface.
  folderModel: Model<any>;
  itemModel: Model<any>;
  moveItem: FolderBackend["moveItem"];
}): FolderBackend {
  const { folderModel, itemModel } = opts;

  const findFolder = async (
    ctx: FolderOpContext,
    folderId: string,
  ): Promise<FolderDocLike | null> =>
    (await folderModel.findOne({
      _id: new Types.ObjectId(folderId),
      workspaceId: new Types.ObjectId(ctx.workspaceId),
    })) as FolderDocLike | null;

  return {
    async createFolder(ctx, { name, parentId, access }) {
      const folder = (await folderModel.create({
        workspaceId: new Types.ObjectId(ctx.workspaceId),
        name,
        parentId: parentId ? new Types.ObjectId(parentId) : undefined,
        ownerId: ctx.userId,
        access: access ?? "private",
      })) as FolderDocLike;
      return {
        ok: true,
        data: {
          id: folder._id.toString(),
          name: folder.name,
          parentId: folder.parentId?.toString() || null,
          access: folder.access,
          ownerId: folder.ownerId,
        },
      };
    },

    async renameFolder(ctx, { folderId, name }) {
      const folder = await findFolder(ctx, folderId);
      if (!folder) {
        return { ok: false, status: 404, error: "Folder not found" };
      }
      if (!canWriteFolderDoc(folder, ctx)) {
        return { ok: false, status: 403, error: "Access denied" };
      }
      folder.name = name;
      await folder.save();
      return {
        ok: true,
        data: { id: folder._id.toString(), name: folder.name },
      };
    },

    async deleteFolder(ctx, { folderId }) {
      const folder = await findFolder(ctx, folderId);
      if (!folder) {
        return { ok: false, status: 404, error: "Folder not found" };
      }
      if (!canWriteFolderDoc(folder, ctx)) {
        return { ok: false, status: 403, error: "Access denied" };
      }
      const wsId = new Types.ObjectId(ctx.workspaceId);
      const allFolderIds = [
        new Types.ObjectId(folderId),
        ...(await collectDescendantFolderIds(folderModel, wsId, folder._id)),
      ];
      // Items in deleted folders fall back to the root, they are not deleted.
      await itemModel.updateMany(
        { workspaceId: wsId, folderId: { $in: allFolderIds } },
        { $unset: { folderId: "" } },
      );
      await folderModel.deleteMany({ _id: { $in: allFolderIds } });
      return { ok: true };
    },

    async moveFolder(ctx, { folderId, parentId, access }) {
      const folder = await findFolder(ctx, folderId);
      if (!folder) {
        return { ok: false, status: 404, error: "Folder not found" };
      }
      if (!canWriteFolderDoc(folder, ctx)) {
        return { ok: false, status: 403, error: "Access denied" };
      }
      if (
        parentId &&
        (await wouldCreateFolderCycle(
          folderModel,
          folderId,
          parentId,
          ctx.workspaceId,
        ))
      ) {
        return {
          ok: false,
          status: 400,
          error: "Cannot move a folder into itself",
        };
      }
      if (parentId !== undefined) {
        folder.parentId = parentId ? new Types.ObjectId(parentId) : undefined;
      }
      if (access) folder.access = access;
      await folder.save();
      return { ok: true };
    },

    moveItem: opts.moveItem,
  };
}
