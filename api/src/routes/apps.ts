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

import { Hono } from "hono";
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

const logger = loggers.api("apps");

const app = new Hono();

interface AppListItem {
  id: string;
  name: string;
  access: "private" | "workspace";
  owner_id?: string;
  fileCount: number;
  updatedAt: Date;
  createdAt: Date;
}

function toListItem(doc: IMakoApp): AppListItem {
  return {
    id: doc._id.toString(),
    name: doc.title,
    access: doc.access,
    owner_id: doc.owner_id,
    fileCount: Array.isArray(doc.files) ? doc.files.length : 0,
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
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
    owner_id: doc.owner_id,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
  return hydrateAppBindingUrls(app);
}

app.use("*", unifiedAuthMiddleware);

app.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
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

function canManage(doc: IMakoApp, userId: string | undefined): boolean {
  if (doc.owner_id && doc.owner_id === userId) return true;
  // Private apps are owner-only, matching dashboards (DashboardManager):
  // workspace admins and API keys (which authenticate with an "admin" member
  // role) must not be able to read or modify another member's private app.
  if (doc.access === "private") return false;
  // Workspace-shared apps are editable by any member, like consoles.
  return doc.access === "workspace";
}

function canRead(doc: IMakoApp, userId: string | undefined): boolean {
  if (doc.access === "workspace") return true;
  return canManage(doc, userId);
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
app.get("/", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const userId = c.get("user")?.id;

    const docs = await MakoApp.find({
      workspaceId: new Types.ObjectId(workspaceId),
      $or: [{ owner_id: userId }, { access: "workspace" }],
    })
      .sort({ updatedAt: -1 })
      .lean<IMakoApp[]>();

    // Mirror dashboards: section is determined by access, not ownership.
    // Workspace-shared apps live under "Workspace" for everyone (owner
    // included) so sharing an app visibly moves it between sections.
    const myApps: AppListItem[] = [];
    const workspaceApps: AppListItem[] = [];
    for (const doc of docs) {
      const item = toListItem(doc);
      if (doc.access === "workspace") workspaceApps.push(item);
      else if (doc.owner_id === userId) myApps.push(item);
    }

    return c.json({ success: true, myApps, workspaceApps });
  } catch (error) {
    logger.error("Error listing apps", { error });
    return c.json({ success: false, error: "Failed to list apps" }, 500);
  }
});

// POST / — create
app.post("/", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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
});

// GET /:id — full app
app.get("/:id", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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
    if (!canRead(doc, userId)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    return c.json({ success: true, app: serializeApp(doc) });
  } catch (error) {
    logger.error("Error fetching app", { error });
    return c.json({ success: false, error: "Failed to fetch app" }, 500);
  }
});

// PUT /:id — update definition
app.put("/:id", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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
    if (!canManage(doc, userId)) {
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
          materialization: b.materialization === "parquet" ? "parquet" : "live",
          cache: prior?.cache,
        };
      }) as IMakoApp["dataBindings"];
    }
    if (body.access === "private" || body.access === "workspace") {
      doc.access = body.access;
    }

    doc.version += 1;
    await doc.save();

    return c.json({ success: true, app: serializeApp(doc) });
  } catch (error) {
    logger.error("Error updating app", { error });
    return c.json({ success: false, error: "Failed to update app" }, 500);
  }
});

// DELETE /:id
app.delete("/:id", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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
    if (!canManage(doc, userId)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    await doc.deleteOne();
    return c.json({ success: true });
  } catch (error) {
    logger.error("Error deleting app", { error });
    return c.json({ success: false, error: "Failed to delete app" }, 500);
  }
});

// POST /:id/bindings/:bindingId/materialize — queue the Parquet build.
// Returns immediately: the build runs in the background (Inngest). Clients
// poll GET .../materialization until the status is ready/error.
app.post(
  "/:id/bindings/:bindingId/materialize",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
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
      if (!canManage(doc, userId)) {
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
app.get(
  "/:id/bindings/:bindingId/materialization",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
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
app.get(
  "/:id/bindings/:bindingId/materialization/artifact",
  async (c: AuthenticatedContext) => {
    try {
      const workspaceId = c.req.param("workspaceId");
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

      return new Response(
        Readable.toWeb(stream as Readable) as ReadableStream,
        {
          headers: {
            "Content-Type": "application/vnd.apache.parquet",
            "X-Row-Count": String(info.rowCount ?? 0),
            "Cache-Control": cacheControl,
          },
        },
      );
    } catch (error) {
      logger.error("Error serving app binding artifact", { error });
      return c.json({ success: false, error: "Failed to serve artifact" }, 500);
    }
  },
);

export const appRoutes = app;
export default app;
