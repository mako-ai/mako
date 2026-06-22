/**
 * React Apps routes — workspace-scoped CRUD for MakoApp documents.
 *
 * Classification: Authenticated + workspace-scoped
 * (`unifiedAuthMiddleware` + workspace verification).
 *
 * An app is a virtual filesystem + npm dependency manifest + data bindings.
 * Heavy logic (preview/runtime) lives client-side; these routes only persist
 * and authorize the definition.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { Readable } from "node:stream";
import { nanoid } from "nanoid";
import {
  MakoApp,
  DatabaseConnection,
  type IMakoApp,
} from "../database/workspace-schema";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { AppDefinitionSchema, normalizeAppFiles } from "@mako/schemas";
import {
  queueAppBindingMaterialization,
  buildAppBindingMaterializationStatus,
  hydrateAppBindingUrls,
  getBindingArtifactInfo,
} from "../services/app-binding-materialization.service";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import {
  canReadResource,
  canWriteResource,
  canManageSharing,
} from "../utils/resource-acl";
import {
  registerCollaboratorRoutes,
  registerSharingSettingsRoutes,
} from "./lib/collaborator-routes";
import { registerPublicShareRoutes } from "./lib/public-share-routes";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";

const logger = loggers.api("apps");

const app = createRouter();

const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
const AppIdParam = WorkspaceParam.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});
const BindingParam = AppIdParam.extend({
  bindingId: z.string().openapi({ param: { name: "bindingId", in: "path" } }),
});
const AppBody = {
  required: false,
  content: {
    "application/json": { schema: z.record(z.string(), z.any()) },
  },
};

interface AppListItem {
  id: string;
  name: string;
  access: "private" | "workspace";
  workspaceRole?: "viewer" | "editor";
  owner_id?: string;
  fileCount: number;
  updatedAt: Date;
  createdAt: Date;
  readOnly?: boolean;
}

function toListItem(
  doc: IMakoApp,
  userId?: string,
  memberRole?: string,
): AppListItem {
  return {
    id: doc._id.toString(),
    name: doc.title,
    access: doc.access,
    workspaceRole: doc.workspaceRole ?? "viewer",
    owner_id: doc.owner_id,
    fileCount: Array.isArray(doc.files) ? doc.files.length : 0,
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
    readOnly: userId ? !canManage(doc, userId, memberRole) : undefined,
  };
}

/** Public-share info safe to return to authenticated clients. */
function serializePublicShare(doc: IMakoApp) {
  if (!doc.publicShare?.enabled || !doc.publicShare.token) return undefined;
  return {
    enabled: true,
    token: doc.publicShare.token,
    hasPassword: !!doc.publicShare.passwordHash,
    createdAt: doc.publicShare.createdAt,
  };
}

function serializeApp(doc: IMakoApp) {
  const app = {
    _id: doc._id.toString(),
    workspaceId: doc.workspaceId.toString(),
    title: doc.title,
    description: doc.description,
    template: doc.template,
    runtime: doc.runtime,
    entrypoint: doc.entrypoint,
    files: (doc.files ?? []).map(f => ({ path: f.path, contents: f.contents })),
    dependencies: doc.dependencies ?? {},
    dataBindings: (doc.dataBindings ?? []).map(b => ({
      id: b.id,
      name: b.name,
      connectionId: b.connectionId,
      language: b.language,
      code: b.code,
      databaseId: b.databaseId,
      databaseName: b.databaseName,
      materialization: b.materialization ?? "live",
      cache: b.cache
        ? {
            parquetArtifactKey: b.cache.parquetArtifactKey,
            definitionHash: b.cache.definitionHash,
            artifactRevision: b.cache.artifactRevision,
            parquetBuildStatus: b.cache.parquetBuildStatus,
            parquetLastError: b.cache.parquetLastError,
            rowCount: b.cache.rowCount,
            byteSize: b.cache.byteSize,
            lastRefreshedAt: b.cache.lastRefreshedAt,
            parquetBuiltAt: b.cache.parquetBuiltAt,
            history: (b.cache.history ?? []).map(run => ({
              at: run.at,
              status: run.status,
              rowCount: run.rowCount,
              byteSize: run.byteSize,
              durationMs: run.durationMs,
              error: run.error,
            })),
          }
        : undefined,
    })) as Array<Record<string, any>>,
    version: doc.version,
    access: doc.access,
    workspaceRole: doc.workspaceRole ?? "viewer",
    sharedWith: (doc.sharedWith ?? []).map(s => ({
      userId: s.userId,
      role: s.role,
      addedAt: s.addedAt,
      addedBy: s.addedBy,
    })),
    publicShare: serializePublicShare(doc),
    owner_id: doc.owner_id,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
  return hydrateAppBindingUrls(app);
}

app.use("*", unifiedAuthMiddleware);

app.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId") as string;
  if (workspaceId) {
    if (!Types.ObjectId.isValid(workspaceId)) {
      return c.json(
        { success: false, error: "Invalid workspace ID format" },
        400,
      );
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
      c.set("memberRole", "admin");
    } else if (user) {
      const member = await workspaceService.getMember(workspaceId, user.id);
      if (!member) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }
      c.set("memberRole", member.role);
    } else {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    enrichContextWithWorkspace(workspaceId);
  }
  await next();
});

// Unified ACL (utils/resource-acl): owner > sharedWith entry > workspace
// scope with `workspaceRole`. Private apps stay invisible to admins/API keys
// unless explicitly shared — preserving the pre-existing privacy guarantee.
function canManage(
  doc: IMakoApp,
  userId: string | undefined,
  memberRole?: string,
): boolean {
  return canWriteResource(doc, userId, memberRole);
}

function canRead(
  doc: IMakoApp,
  userId: string | undefined,
  memberRole?: string,
): boolean {
  return canReadResource(doc, userId, memberRole);
}

// Validate that every data binding references a connection in this workspace.
async function validateDataBindings(
  workspaceId: string,
  dataBindings: Array<{ connectionId?: string }> | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!dataBindings || dataBindings.length === 0) return { ok: true };
  const connectionIds = [
    ...new Set(dataBindings.map(b => b.connectionId).filter(Boolean)),
  ] as string[];
  for (const id of connectionIds) {
    if (!Types.ObjectId.isValid(id)) {
      return {
        ok: false,
        error: `Invalid connectionId in data binding: ${id}`,
      };
    }
  }
  if (connectionIds.length > 0) {
    const valid = await DatabaseConnection.countDocuments({
      _id: { $in: connectionIds.map(id => new Types.ObjectId(id)) },
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (valid !== connectionIds.length) {
      return {
        ok: false,
        error: "One or more data binding connections are invalid",
      };
    }
  }
  return { ok: true };
}

// GET / — list apps split into mine vs workspace-shared
app.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Apps"],
    summary: "List apps",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const userId = c.get("user")?.id;
      const memberRole = c.get("memberRole");

      const docs = await MakoApp.find({
        workspaceId: new Types.ObjectId(workspaceId),
        $or: [
          { owner_id: userId },
          { access: "workspace" },
          { "sharedWith.userId": userId },
        ],
      })
        .sort({ updatedAt: -1 })
        .lean<IMakoApp[]>();

      // Mirror dashboards: section is determined by access, not ownership.
      // Workspace-shared apps live under "Workspace" for everyone (owner
      // included) so sharing an app visibly moves it between sections.
      const myApps: AppListItem[] = [];
      const workspaceApps: AppListItem[] = [];
      for (const doc of docs) {
        const item = toListItem(doc, userId, memberRole);
        if (doc.access === "workspace") workspaceApps.push(item);
        else if (doc.owner_id === userId) myApps.push(item);
        // Privately-shared collaborator apps: show under Workspace section.
        else workspaceApps.push(item);
      }

      return c.json({ success: true, myApps, workspaceApps });
    } catch (error) {
      logger.error("Error listing apps", { error });
      return c.json({ success: false, error: "Failed to list apps" }, 500);
    }
  },
);

// POST / — create
app.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Apps"],
    summary: "Create an app",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam, body: AppBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const userId = c.get("user")?.id ?? "system";
      const body = await c.req.json();

      const parsed = AppDefinitionSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            success: false,
            error: parsed.error.issues[0]?.message ?? "Invalid app",
          },
          400,
        );
      }
      const def = parsed.data;

      const bindingCheck = await validateDataBindings(
        workspaceId,
        def.dataBindings,
      );
      if (!bindingCheck.ok) {
        return c.json({ success: false, error: bindingCheck.error }, 400);
      }

      const created = await MakoApp.create({
        workspaceId: new Types.ObjectId(workspaceId),
        title: def.title,
        description: def.description,
        template: def.template,
        runtime: def.runtime,
        entrypoint: def.entrypoint,
        files: normalizeAppFiles(def.files),
        dependencies: def.dependencies,
        dataBindings: def.dataBindings,
        access: "private",
        owner_id: userId,
        createdBy: userId,
        version: 1,
      });

      return c.json({ success: true, app: serializeApp(created) }, 201);
    } catch (error) {
      logger.error("Error creating app", { error });
      return c.json({ success: false, error: "Failed to create app" }, 500);
    }
  },
);

// GET /:id — full app
app.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Apps"],
    summary: "Get an app",
    security: AUTH_SECURITY,
    request: { params: AppIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const userId = c.get("user")?.id;

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid app ID" }, 400);
      }

      const doc = await MakoApp.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!doc) return c.json({ success: false, error: "App not found" }, 404);
      const memberRole = c.get("memberRole");
      if (!canRead(doc, userId, memberRole)) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      return c.json({
        success: true,
        app: serializeApp(doc),
        readOnly: !canManage(doc, userId, memberRole),
      });
    } catch (error) {
      logger.error("Error fetching app", { error });
      return c.json({ success: false, error: "Failed to fetch app" }, 500);
    }
  },
);

// PUT /:id — update definition
app.openapi(
  createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Apps"],
    summary: "Update an app",
    security: AUTH_SECURITY,
    request: { params: AppIdParam, body: AppBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const userId = c.get("user")?.id;

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid app ID" }, 400);
      }

      const doc = await MakoApp.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!doc) return c.json({ success: false, error: "App not found" }, 404);
      const memberRole = c.get("memberRole");
      if (!canManage(doc, userId, memberRole)) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      const body = (await c.req.json()) as Record<string, unknown>;

      if (typeof body.title === "string" && body.title.trim()) {
        doc.title = body.title.trim();
      }
      if (typeof body.description === "string") {
        doc.description = body.description;
      }
      if (typeof body.template === "string") {
        doc.template = body.template;
      }
      if (body.runtime === "cdn" || body.runtime === "webcontainer") {
        doc.runtime = body.runtime;
      }
      if (typeof body.entrypoint === "string") {
        doc.entrypoint = body.entrypoint;
      }
      if (Array.isArray(body.files)) {
        doc.files = normalizeAppFiles(
          body.files as { path: string; contents: string }[],
        );
      }
      if (body.dependencies && typeof body.dependencies === "object") {
        doc.dependencies = body.dependencies as Record<string, string>;
      }
      if (Array.isArray(body.dataBindings)) {
        const bindings = body.dataBindings as Array<Record<string, any>>;
        const bindingCheck = await validateDataBindings(workspaceId, bindings);
        if (!bindingCheck.ok) {
          return c.json({ success: false, error: bindingCheck.error }, 400);
        }
        // Cache is server-owned: preserve the existing materialized cache by id;
        // never trust client-provided cache. Take only the query definition.
        const existingById = new Map(doc.dataBindings.map(b => [b.id, b]));
        doc.dataBindings = bindings.map(b => {
          const id = b.id || nanoid(10);
          const prior = existingById.get(id);
          return {
            id,
            name: b.name,
            connectionId: b.connectionId,
            language: b.language || "sql",
            code: b.code ?? "",
            databaseId: b.databaseId,
            databaseName: b.databaseName,
            materialization:
              b.materialization === "parquet" ? "parquet" : "live",
            cache: prior?.cache,
          };
        }) as IMakoApp["dataBindings"];
      }
      const wantsAccessChange =
        (body.access === "private" || body.access === "workspace") &&
        body.access !== doc.access;
      const wantsWorkspaceRoleChange =
        (body.workspaceRole === "viewer" || body.workspaceRole === "editor") &&
        body.workspaceRole !== (doc.workspaceRole ?? "viewer");
      if (wantsAccessChange || wantsWorkspaceRoleChange) {
        if (!canManageSharing(doc, userId, memberRole)) {
          return c.json(
            {
              success: false,
              error: "Only the owner or an admin can change sharing settings",
            },
            403,
          );
        }
        if (wantsAccessChange) {
          doc.access = body.access as "private" | "workspace";
        }
        if (wantsWorkspaceRoleChange) {
          doc.workspaceRole = body.workspaceRole as "viewer" | "editor";
        }
      }

      doc.version += 1;
      await doc.save();

      return c.json({ success: true, app: serializeApp(doc) });
    } catch (error) {
      logger.error("Error updating app", { error });
      return c.json({ success: false, error: "Failed to update app" }, 500);
    }
  },
);

// DELETE /:id
app.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Apps"],
    summary: "Delete an app",
    security: AUTH_SECURITY,
    request: { params: AppIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const userId = c.get("user")?.id;

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid app ID" }, 400);
      }

      const doc = await MakoApp.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!doc) return c.json({ success: false, error: "App not found" }, 404);
      if (!canManage(doc, userId, c.get("memberRole"))) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      await doc.deleteOne();
      return c.json({ success: true });
    } catch (error) {
      logger.error("Error deleting app", { error });
      return c.json({ success: false, error: "Failed to delete app" }, 500);
    }
  },
);

// POST /:id/bindings/:bindingId/materialize — queue the Parquet build.
// Returns immediately: the build runs in the background (Inngest). Clients
// poll GET .../materialization until the status is ready/error.
app.openapi(
  createRoute({
    method: "post",
    path: "/{id}/bindings/{bindingId}/materialize",
    tags: ["Apps"],
    summary: "Materialize an app data binding",
    security: AUTH_SECURITY,
    request: { params: BindingParam, body: AppBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const bindingId = c.req.param("bindingId");
      const userId = c.get("user")?.id;

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid app ID" }, 400);
      }

      const doc = await MakoApp.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!doc) return c.json({ success: false, error: "App not found" }, 404);
      if (!canManage(doc, userId, c.get("memberRole"))) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      const body = (await c.req.json().catch(() => ({}))) as {
        force?: boolean;
      };
      const result = await queueAppBindingMaterialization({
        workspaceId,
        appId: id,
        bindingId,
        force: body.force === true,
      });

      // On a cache hit nothing was queued — return the refreshed app so the
      // client immediately gets the hydrated parquetUrl.
      let app: ReturnType<typeof serializeApp> | undefined;
      if (result.status === "ready") {
        const refreshed = await MakoApp.findById(doc._id);
        app = refreshed ? serializeApp(refreshed) : undefined;
      }

      return c.json({
        success: result.status !== "error",
        queued: result.queued,
        alreadyRunning: result.alreadyRunning === true,
        status: result,
        app,
      });
    } catch (error) {
      logger.error("Error queueing app binding materialization", { error });
      return c.json(
        { success: false, error: "Failed to materialize binding" },
        500,
      );
    }
  },
);

// GET /:id/bindings/:bindingId/materialization — build status (for polling)
app.openapi(
  createRoute({
    method: "get",
    path: "/{id}/bindings/{bindingId}/materialization",
    tags: ["Apps"],
    summary: "Get app binding materialization status",
    security: AUTH_SECURITY,
    request: { params: BindingParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const bindingId = c.req.param("bindingId");
      const userId = c.get("user")?.id;

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid app ID" }, 400);
      }

      const doc = await MakoApp.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!doc) return c.json({ success: false, error: "App not found" }, 404);
      if (!canRead(doc, userId)) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      const status = buildAppBindingMaterializationStatus(doc, bindingId);
      if (!status) {
        return c.json({ success: false, error: "Binding not found" }, 404);
      }

      return c.json({ success: true, data: status });
    } catch (error) {
      logger.error("Error getting app binding materialization status", {
        error,
      });
      return c.json(
        { success: false, error: "Failed to get materialization status" },
        500,
      );
    }
  },
);

// GET /:id/bindings/:bindingId/materialization/artifact — stream the Parquet
app.openapi(
  createRoute({
    method: "get",
    path: "/{id}/bindings/{bindingId}/materialization/artifact",
    tags: ["Apps"],
    summary: "Stream an app binding artifact",
    security: AUTH_SECURITY,
    request: {
      params: BindingParam,
      query: z.object({ rev: z.string().optional() }),
    },
    responses: {
      ...OPEN_RESPONSES,
      200: {
        description: "Parquet artifact bytes.",
        content: {
          "application/vnd.apache.parquet": {
            schema: z.string().openapi({ format: "binary" }),
          },
        },
      },
    },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const bindingId = c.req.param("bindingId");
      const userId = c.get("user")?.id;

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid app ID" }, 400);
      }

      const doc = await MakoApp.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!doc) return c.json({ success: false, error: "App not found" }, 404);
      if (!canRead(doc, userId, c.get("memberRole"))) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      const info = getBindingArtifactInfo(doc, bindingId);
      if (!info) {
        return c.json({ success: false, error: "Artifact not found" }, 404);
      }

      const store = getDashboardArtifactStore();
      const stream = await store.openReadStream(info.artifactKey);
      if (!stream) {
        return c.json({ success: false, error: "Artifact not found" }, 404);
      }

      const rev = c.req.query("rev");
      const cacheControl =
        rev && info.revision && rev === info.revision
          ? "private, max-age=86400, immutable"
          : "private, no-store";

      return c.body(Readable.toWeb(stream as Readable) as ReadableStream, 200, {
        "Content-Type": "application/vnd.apache.parquet",
        "X-Row-Count": String(info.rowCount ?? 0),
        "Cache-Control": cacheControl,
      });
    } catch (error) {
      logger.error("Error serving app binding artifact", { error });
      return c.json({ success: false, error: "Failed to serve artifact" }, 500);
    }
  },
);

// ── Sharing (collaborators, general access, public link) ──

const loadAppById = async (c: AuthenticatedContext) => {
  const workspaceId = c.req.param("workspaceId") as string;
  const id = c.req.param("id");
  if (!Types.ObjectId.isValid(id)) return null;
  return MakoApp.findOne({
    _id: new Types.ObjectId(id),
    workspaceId: new Types.ObjectId(workspaceId),
  });
};

// These shared helpers register additional (collaborator/sharing/public-share)
// routes on the same instance. They accept a plain Hono; OpenAPIHono is
// runtime-compatible, so we cast for the type boundary. These routes remain
// functional but are not part of the generated OpenAPI document.
registerCollaboratorRoutes(app, {
  resourceName: "App",
  load: loadAppById,
});
registerSharingSettingsRoutes(app, {
  resourceName: "App",
  load: loadAppById,
});
registerPublicShareRoutes(app, {
  resourceName: "App",
  load: loadAppById,
  getTitle: doc => (doc as unknown as IMakoApp).title,
});

export const appRoutes = app;
export default app;
