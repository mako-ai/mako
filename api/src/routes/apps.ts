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
  DbtProject,
  EntityVersion,
  type IMakoApp,
} from "../database/workspace-schema";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { AppDefinitionSchema, normalizeAppFiles } from "@mako/schemas";
import {
  queueAppBindingMaterialization,
  queueAppBindingMaterializationForEnvironment,
  buildAppBindingMaterializationStatus,
  buildAppBindingDefinitionHash,
  hydrateAppBindingUrls,
  getBindingArtifactInfo,
} from "../services/app-binding-materialization.service";
import {
  validateDashboardMaterializationSchedule,
  isDashboardMaterializationEnabled,
} from "../services/dashboard-materialization-schedule.service";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import {
  buildAppSnapshot,
  applyAppSnapshot,
  appHasUnpublishedChanges,
  type AppSnapshot,
} from "../services/app-version.service";
import { persistMutatedAppDraft } from "../services/persist-app-draft";
import {
  createVersion,
  listVersions,
  getVersion,
  getUserDisplayName,
} from "../services/entity-version.service";
import { generateAppVersionComment } from "../services/version-comment.service";
import { getEntityChatPrompts } from "../services/entity-version-context.service";
import { publishRealtimeEvent } from "../services/realtime.service";
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
      dbtProjectId: b.dbtProjectId,
      connectionId: b.connectionId,
      language: b.language,
      code: b.code,
      databaseId: b.databaseId,
      databaseName: b.databaseName,
      materialization: b.materialization ?? "live",
      materializationSchedule: b.materializationSchedule,
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
            // Per-environment preview artifacts. `parquetUrl` for each is
            // filled in by hydrateAppBindingUrls below; history is dropped
            // here (the status route serves it) to keep app payloads small.
            environments: b.cache.environments
              ? Object.fromEntries(
                  Object.entries(b.cache.environments).map(([env, a]) => [
                    env,
                    {
                      status: a?.status,
                      statusAt: a?.statusAt,
                      artifactKey: a?.artifactKey,
                      definitionHash: a?.definitionHash,
                      artifactRevision: a?.artifactRevision,
                      error: a?.error,
                      rowCount: a?.rowCount,
                      byteSize: a?.byteSize,
                      builtAt: a?.builtAt,
                      sourceSchema: a?.sourceSchema,
                    },
                  ]),
                )
              : undefined,
          }
        : undefined,
    })) as Array<Record<string, any>>,
    version: doc.version,
    publishedVersion: doc.publishedVersion,
    publishedAt: doc.publishedAt,
    hasUnpublishedChanges: appHasUnpublishedChanges(doc),
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

// Validate that every data binding references a connection (and, when linked,
// a dbt project) in this workspace.
async function validateDataBindings(
  workspaceId: string,
  dataBindings:
    | Array<{ connectionId?: string; dbtProjectId?: string }>
    | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!dataBindings || dataBindings.length === 0) return { ok: true };
  const dbtProjectIds = [
    ...new Set(dataBindings.map(b => b.dbtProjectId).filter(Boolean)),
  ] as string[];
  for (const id of dbtProjectIds) {
    if (!Types.ObjectId.isValid(id)) {
      return {
        ok: false,
        error: `Invalid dbtProjectId in data binding: ${id}`,
      };
    }
  }
  if (dbtProjectIds.length > 0) {
    const validProjects = await DbtProject.countDocuments({
      _id: { $in: dbtProjectIds.map(id => new Types.ObjectId(id)) },
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (validProjects !== dbtProjectIds.length) {
      return {
        ok: false,
        error: "One or more data binding dbt projects are invalid",
      };
    }
  }
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
      // Validate each binding's materialization schedule cron (parity with the
      // dashboard create path), normalizing live bindings to a disabled schedule.
      try {
        for (const binding of def.dataBindings) {
          if (!binding.materializationSchedule) continue;
          binding.materializationSchedule =
            validateDashboardMaterializationSchedule(
              binding.materialization === "parquet"
                ? binding.materializationSchedule
                : { ...binding.materializationSchedule, enabled: false },
            );
        }
      } catch (error) {
        return c.json(
          {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Invalid materialization schedule",
          },
          400,
        );
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

      // Seed an initial published version (v1) so every app has version history
      // from creation — mirroring consoles/dashboards. Without this, an app only
      // gets versions after an explicit "Publish version", so freshly-created
      // apps showed an empty history.
      const displayName = await getUserDisplayName(userId ?? "system");
      const initialSnapshot = buildAppSnapshot(created);
      const initialVersion = await createVersion({
        entityType: "app",
        entityId: created._id,
        workspaceId: new Types.ObjectId(workspaceId),
        snapshot: initialSnapshot as unknown as Record<string, unknown>,
        savedBy: userId ?? "system",
        savedByName: displayName,
        comment: "App created",
      });
      created.published = initialSnapshot as unknown as Record<string, unknown>;
      created.markModified("published");
      created.publishedVersion = initialVersion.version;
      created.publishedAt = new Date();
      await created.save();

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

      let doc = await MakoApp.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!doc) return c.json({ success: false, error: "App not found" }, 404);
      const memberRole = c.get("memberRole");
      if (!canManage(doc, userId, memberRole)) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      const body = (await c.req.json()) as Record<string, unknown>;
      const expectedVersion =
        typeof body.expectedVersion === "number" &&
        Number.isInteger(body.expectedVersion) &&
        body.expectedVersion >= 1
          ? body.expectedVersion
          : doc.version;
      if (expectedVersion !== doc.version) {
        return c.json(
          {
            success: false,
            error:
              "App changed since it was loaded. Reload it before saving again.",
            code: "version_conflict",
            expectedVersion,
            actualVersion: doc.version,
          },
          409,
        );
      }

      // Snapshot of bindings before the update, keyed by id — used after save
      // to detect which scheduled parquet bindings changed definition so we
      // can proactively rebuild them (parity with dashboard auto-refresh).
      let priorBindingsById: Map<
        string,
        IMakoApp["dataBindings"][number]
      > | null = null;

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
        priorBindingsById = existingById;
        try {
          doc.dataBindings = bindings.map(b => {
            const id = b.id || nanoid(10);
            const prior = existingById.get(id);
            const materialization =
              b.materialization === "parquet" ? "parquet" : "live";
            // Validate + persist the per-binding schedule (mirrors how
            // dashboards validate `materializationSchedule` on save). Only
            // parquet bindings can be scheduled, so a live binding keeps any
            // prior schedule but is forced disabled.
            const rawSchedule =
              b.materializationSchedule ?? prior?.materializationSchedule;
            const materializationSchedule = rawSchedule
              ? validateDashboardMaterializationSchedule(
                  materialization === "parquet"
                    ? rawSchedule
                    : { ...rawSchedule, enabled: false },
                )
              : undefined;
            return {
              id,
              name: b.name,
              dbtProjectId: b.dbtProjectId,
              connectionId: b.connectionId,
              language: b.language || "sql",
              code: b.code ?? "",
              databaseId: b.databaseId,
              databaseName: b.databaseName,
              materialization,
              materializationSchedule,
              cache: prior?.cache,
            };
          }) as IMakoApp["dataBindings"];
        } catch (error) {
          return c.json(
            {
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Invalid materialization schedule",
            },
            400,
          );
        }
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

      const updated = await persistMutatedAppDraft(doc, expectedVersion);
      if (!updated) {
        return c.json(
          {
            success: false,
            error:
              "App changed while this save was being applied. Reload it before saving again.",
            code: "version_conflict",
            expectedVersion,
          },
          409,
        );
      }
      doc = updated;

      // Mechanism parity with dashboards: when a scheduled parquet binding's
      // query definition changes, proactively rebuild its artifact so the
      // materialized data stays in sync without a manual materialize. Gated on
      // the binding's own schedule being enabled (apps schedule per-binding).
      if (priorBindingsById) {
        for (const binding of doc.dataBindings) {
          if (binding.materialization !== "parquet") continue;
          if (
            !isDashboardMaterializationEnabled(binding.materializationSchedule)
          ) {
            continue;
          }
          const prior = priorBindingsById.get(binding.id);
          const changed =
            !prior ||
            buildAppBindingDefinitionHash(prior) !==
              buildAppBindingDefinitionHash(binding);
          if (changed) {
            void queueAppBindingMaterialization({
              workspaceId,
              appId: id,
              bindingId: binding.id,
              force: true,
            }).catch(() => undefined);
          }
        }
      }

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
// Optional environment parameter for dbt preview artifacts (default: prod).
app.openapi(
  createRoute({
    method: "post",
    path: "/{id}/bindings/{bindingId}/materialize",
    tags: ["Apps"],
    summary: "Materialize an app data binding",
    security: AUTH_SECURITY,
    request: {
      params: BindingParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              force: z.boolean().optional(),
              environment: z
                .string()
                .optional()
                .describe(
                  "dbt environment name (e.g. 'dev'). Builds a preview-scoped artifact for that environment; omit for the prod artifact.",
                ),
            }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id") as string;
      const bindingId = c.req.param("bindingId") as string;
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
        environment?: string;
      };

      // An environment build only means something for a dbt-linked binding —
      // the environment is what `{{ dbt_schema }}` resolves against. Without a
      // link there is nothing to vary, so reject rather than writing an
      // artifact under an arbitrary caller-supplied environment name.
      if (body.environment) {
        const binding = doc.dataBindings.find(b => b.id === bindingId);
        if (!binding) {
          return c.json({ success: false, error: "Binding not found" }, 404);
        }
        if (!binding.dbtProjectId) {
          return c.json(
            {
              success: false,
              error:
                "This data source is not linked to a dbt project, so it has no per-environment data to build.",
            },
            400,
          );
        }
        const project = await DbtProject.findOne({
          _id: new Types.ObjectId(binding.dbtProjectId),
          workspaceId: new Types.ObjectId(workspaceId),
        }).select("environments");
        if (
          !project?.environments?.some(env => env.name === body.environment)
        ) {
          return c.json(
            {
              success: false,
              error: `Environment "${body.environment}" not found in dbt project`,
            },
            400,
          );
        }
      }

      const result = body.environment
        ? await queueAppBindingMaterializationForEnvironment({
            workspaceId,
            appId: id,
            bindingId,
            environment: body.environment,
            force: body.force === true,
          })
        : await queueAppBindingMaterialization({
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
      query: z.object({
        rev: z.string().optional(),
        env: z
          .string()
          .optional()
          .describe(
            "dbt environment name (e.g. 'dev', 'prod'). Defaults to prod.",
          ),
      }),
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
      const environment = c.req.query("env");

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

      // Environment artifacts are an editor-only preview: they hold non-prod
      // (dev/staging) data, so only callers who can edit the app may read
      // them. Viewers — including everyone on a published or shared view —
      // fall through to the prod artifact, never this one. Gating on edit
      // rights (not on whether the app has ever been published) keeps dev
      // preview working for editors of a published app.
      if (environment && !canManage(doc, userId, c.get("memberRole"))) {
        return c.json(
          {
            success: false,
            error: "Environment previews are only available to app editors",
          },
          403,
        );
      }

      const info = getBindingArtifactInfo(doc, bindingId, environment);
      if (!info) {
        return c.json({ success: false, error: "Artifact not found" }, 404);
      }

      const store = getDashboardArtifactStore();
      const stream = await store.openReadStream(info.artifactKey);
      if (!stream) {
        // The binding cache says "ready" but the artifact bytes are gone
        // (bucket cleanup, prod restore onto a machine without the files).
        // Self-heal: queue a background rebuild — the atomic claim inside
        // queueAppBindingMaterialization dedupes the concurrent 404s a page
        // load produces — and return a clean 404 for this read. Open tabs
        // pick the fresh artifact up via the post-build app.updated poke.
        if (environment) {
          void queueAppBindingMaterializationForEnvironment({
            workspaceId,
            appId: id,
            bindingId,
            environment,
          }).catch(() => undefined);
        } else {
          void queueAppBindingMaterialization({
            workspaceId,
            appId: id,
            bindingId,
          }).catch(() => undefined);
        }
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

// ── Version history (explicit checkpoints) ──
//
// Apps autosave on every edit, so versions are explicit checkpoints rather
// than per-save snapshots: POST creates one, restore reverts to one (and
// records a fresh checkpoint with `restoredFrom`). Snapshots freeze the
// editable definition (files + deps + binding queries); the server-owned
// materialization cache is preserved by binding id on restore.

// GET /{id}/versions — list checkpoints (newest first)
app.openapi(
  createRoute({
    method: "get",
    path: "/{id}/versions",
    tags: ["Apps"],
    summary: "List app versions",
    security: AUTH_SECURITY,
    request: {
      params: AppIdParam,
      query: z.object({
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
    },
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
      if (!canRead(doc, userId, c.get("memberRole"))) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      const limit = Math.min(
        parseInt(c.req.query("limit") ?? "50", 10) || 50,
        100,
      );
      const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;
      const result = await listVersions(new Types.ObjectId(id), "app", {
        limit,
        offset,
        workspaceId: new Types.ObjectId(workspaceId),
      });
      return c.json({ success: true, ...result });
    } catch (error) {
      logger.error("Error listing app versions", { error });
      return c.json({ success: false, error: "Failed to list versions" }, 500);
    }
  },
);

// POST /{id}/versions — create a checkpoint of the current app state
app.openapi(
  createRoute({
    method: "post",
    path: "/{id}/versions",
    tags: ["Apps"],
    summary: "Save an app version checkpoint",
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
      if (!canManage(doc, userId, c.get("memberRole"))) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      const body = (await c.req.json().catch(() => ({}))) as {
        comment?: string;
      };
      const displayName = await getUserDisplayName(userId ?? "system");
      const snapshot = buildAppSnapshot(doc);
      const created = await createVersion({
        entityType: "app",
        entityId: doc._id,
        workspaceId: new Types.ObjectId(workspaceId),
        snapshot: snapshot as unknown as Record<string, unknown>,
        savedBy: userId ?? "system",
        savedByName: displayName,
        comment: (body.comment ?? "").slice(0, 500),
      });

      // Saving a version publishes it: the snapshot becomes the definition that
      // public/shared viewers render. The working draft (top-level fields) is
      // unchanged; it simply now matches `published`.
      doc.published = snapshot as unknown as Record<string, unknown>;
      doc.markModified("published"); // Mixed type: assignment isn't auto-tracked
      doc.publishedVersion = created.version;
      doc.publishedAt = new Date();
      await doc.save();

      return c.json({
        success: true,
        version: created.version,
        publishedVersion: created.version,
        createdAt: created.createdAt,
      });
    } catch (error) {
      logger.error("Error saving app version", { error });
      return c.json({ success: false, error: "Failed to save version" }, 500);
    }
  },
);

// POST /{id}/version-comment — AI-suggested commit message for the pending
// draft. Diffs the current (autosaved) draft against the latest saved version
// snapshot and folds in any chat prompts that drove the changes. The client
// should flush pending edits (PUT the draft) before calling this.
app.openapi(
  createRoute({
    method: "post",
    path: "/{id}/version-comment",
    tags: ["Apps"],
    summary: "Suggest a version comment for pending app changes",
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

      const newSnapshot = buildAppSnapshot(doc) as unknown as Record<
        string,
        unknown
      >;

      const latestVersion = await EntityVersion.findOne(
        {
          entityId: doc._id,
          entityType: "app",
        },
        { snapshot: 1, version: 1 },
      )
        .sort({ version: -1 })
        .lean();

      const previousSnapshot =
        (latestVersion?.snapshot as Record<string, unknown> | undefined) ??
        (doc.published as Record<string, unknown> | undefined) ??
        null;

      const chatPrompts = userId
        ? await getEntityChatPrompts(workspaceId, userId, id, ["appId"])
        : [];

      const result = await generateAppVersionComment(
        { previousSnapshot, newSnapshot, chatPrompts },
        userId
          ? { workspaceId, userId, userEmail: c.get("user")?.email }
          : undefined,
      );

      return c.json({
        success: true,
        comment: result.comment,
        diff: result.diff,
      });
    } catch (error) {
      logger.error("Error generating app version comment", { error });
      return c.json(
        { success: false, error: "Failed to generate version comment" },
        500,
      );
    }
  },
);

// GET /{id}/versions/{version} — full snapshot of one checkpoint
app.openapi(
  createRoute({
    method: "get",
    path: "/{id}/versions/{version}",
    tags: ["Apps"],
    summary: "Get an app version snapshot",
    security: AUTH_SECURITY,
    request: {
      params: AppIdParam.extend({
        version: z.string().openapi({ param: { name: "version", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const versionNum = parseInt(c.req.param("version"), 10);
      const userId = c.get("user")?.id;
      if (!Types.ObjectId.isValid(id) || Number.isNaN(versionNum)) {
        return c.json({ success: false, error: "Invalid request" }, 400);
      }
      const doc = await MakoApp.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!doc) return c.json({ success: false, error: "App not found" }, 404);
      if (!canRead(doc, userId, c.get("memberRole"))) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }
      const version = await getVersion(
        id,
        "app",
        versionNum,
        new Types.ObjectId(workspaceId),
      );
      if (!version) {
        return c.json({ success: false, error: "Version not found" }, 404);
      }
      return c.json({ success: true, version });
    } catch (error) {
      logger.error("Error fetching app version", { error });
      return c.json({ success: false, error: "Failed to fetch version" }, 500);
    }
  },
);

// POST /{id}/versions/{version}/restore — revert the app to a checkpoint
app.openapi(
  createRoute({
    method: "post",
    path: "/{id}/versions/{version}/restore",
    tags: ["Apps"],
    summary: "Restore an app version",
    security: AUTH_SECURITY,
    request: {
      params: AppIdParam.extend({
        version: z.string().openapi({ param: { name: "version", in: "path" } }),
      }),
      body: AppBody,
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const versionNum = parseInt(c.req.param("version"), 10);
      const userId = c.get("user")?.id;
      if (!Types.ObjectId.isValid(id) || Number.isNaN(versionNum)) {
        return c.json({ success: false, error: "Invalid request" }, 400);
      }
      const doc = await MakoApp.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!doc) return c.json({ success: false, error: "App not found" }, 404);
      if (!canManage(doc, userId, c.get("memberRole"))) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }
      const old = await getVersion(
        id,
        "app",
        versionNum,
        new Types.ObjectId(workspaceId),
      );
      if (!old) {
        return c.json({ success: false, error: "Version not found" }, 404);
      }

      applyAppSnapshot(doc, old.snapshot as unknown as AppSnapshot);
      const updated = await persistMutatedAppDraft(doc);
      if (!updated) {
        return c.json(
          {
            success: false,
            error:
              "App changed while this restore was being applied. Re-read the app and retry.",
            code: "version_conflict",
          },
          409,
        );
      }

      // Record the restore as a fresh checkpoint so history stays append-only.
      const body = (await c.req.json().catch(() => ({}))) as {
        comment?: string;
      };
      const displayName = await getUserDisplayName(userId ?? "system");
      await createVersion({
        entityType: "app",
        entityId: updated._id,
        workspaceId: new Types.ObjectId(workspaceId),
        snapshot: buildAppSnapshot(updated) as unknown as Record<
          string,
          unknown
        >,
        savedBy: userId ?? "system",
        savedByName: displayName,
        comment: (body.comment ?? `Restored from version ${versionNum}`).slice(
          0,
          500,
        ),
        restoredFrom: versionNum,
      });

      // Poke open tabs so they pull the reverted definition and rebuild preview.
      publishRealtimeEvent(workspaceId, {
        type: "app.updated",
        appId: updated._id.toString(),
        version: updated.version,
        updatedBy: userId ?? "system",
        origin: "save",
      });

      return c.json({
        success: true,
        message: `Restored to version ${versionNum}`,
        app: serializeApp(updated),
      });
    } catch (error) {
      logger.error("Error restoring app version", { error });
      return c.json(
        { success: false, error: "Failed to restore version" },
        500,
      );
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
