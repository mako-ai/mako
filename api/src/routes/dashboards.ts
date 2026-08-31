import { createRoute, z } from "@hono/zod-openapi";
import { workspaceResourceLoader } from "./lib/load-resource";
import {
  Dashboard,
  DashboardFolder,
  DatabaseConnection,
  EntityVersion,
  type IDashboard,
} from "../database/workspace-schema";
import { Types } from "mongoose";
import { nanoid } from "nanoid";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import {
  DashboardDefinitionSchema,
  normalizeWidgetLayouts,
  sanitizeTableRef,
  buildTableRef,
} from "@mako/schemas";
import { hydrateDashboardArtifactUrls } from "../services/dashboard-cache.service";
import { snapshotsEqual } from "../services/snapshot-diff";
import { publishRealtimeEvent } from "../services/realtime.service";
import { buildDashboardDataSourceDefinitionHash } from "../services/dashboard-artifact-rebuild.service";
import {
  isDashboardMaterializationEnabled,
  normalizeDashboardMaterializationSchedule,
  validateDashboardMaterializationSchedule,
} from "../services/dashboard-materialization-schedule.service";
import { queueDashboardArtifactRefresh } from "../services/dashboard-refresh-runner.service";
import { DashboardManager } from "../utils/dashboard-manager";
import {
  createVersion,
  listVersions,
  getVersion,
  getUserDisplayName,
} from "../services/entity-version.service";
import { generateDashboardVersionComment } from "../services/version-comment.service";
import { getEntityChatPrompts } from "../services/entity-version-context.service";
import {
  registerCollaboratorRoutes,
  registerSharingSettingsRoutes,
} from "./lib/collaborator-routes";
import { registerPublicShareRoutes } from "./lib/public-share-routes";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  dataResponse,
  errorJson,
  zDateTime,
  zObjectId,
} from "../openapi/core";

const logger = loggers.api("dashboards");

const app = createRouter();

const DASHBOARD_QUERY_LANGUAGES = new Set(["sql", "javascript", "mongodb"]);

const JsonObjectSchema = z.record(z.string(), z.unknown());

const DashboardQuerySchema = z.object({
  connectionId: zObjectId(),
  language: z.enum(["sql", "javascript", "mongodb"]),
  code: z.string(),
  databaseId: z.string().optional(),
  databaseName: z.string().optional(),
  mongoOptions: z
    .object({
      collection: z.string().optional(),
      operation: z
        .enum([
          "find",
          "aggregate",
          "insertMany",
          "updateMany",
          "deleteMany",
          "findOne",
          "updateOne",
          "deleteOne",
        ])
        .optional(),
    })
    .optional(),
});

const DashboardDataSourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  tableRef: z.string(),
  materialization: z.enum(["live", "parquet"]).default("parquet"),
  query: DashboardQuerySchema,
  origin: z
    .object({
      type: z.enum(["saved_console", "local"]),
      consoleId: zObjectId().optional(),
      consoleName: z.string().optional(),
      importedAt: zDateTime().optional(),
    })
    .optional(),
  timeDimension: z.string().optional(),
  rowLimit: z.number().optional(),
  computedColumns: z
    .array(
      z.object({
        name: z.string(),
        expression: z.string(),
        type: z.enum(["quantitative", "temporal", "nominal", "ordinal"]),
      }),
    )
    .optional(),
  cache: z
    .object({
      lastRefreshedAt: zDateTime().optional(),
      rowCount: z.number().optional(),
      byteSize: z.number().optional(),
      parquetArtifactKey: z.string().optional(),
      definitionHash: z.string().optional(),
      artifactRevision: z.string().optional(),
      parquetVersion: z.string().optional(),
      parquetBuiltAt: zDateTime().optional(),
      parquetBuildStatus: z
        .enum(["missing", "queued", "building", "ready", "error"])
        .nullable()
        .optional(),
      parquetLastError: z.string().optional(),
      parquetUrl: z.string().optional(),
    })
    .nullable()
    .optional(),
});

const DashboardRelationshipSchema = z.object({
  id: z.string(),
  from: z.object({ dataSourceId: z.string(), column: z.string() }),
  to: z.object({ dataSourceId: z.string(), column: z.string() }),
  type: z.enum(["one-to-one", "one-to-many", "many-to-one", "many-to-many"]),
});

const DashboardLayoutCellSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  minW: z.number().optional(),
  minH: z.number().optional(),
  custom: z.boolean().optional(),
});

const DashboardWidgetSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  type: z.enum(["chart", "kpi", "table"]),
  dataSourceId: z.string(),
  localSql: z.string(),
  vegaLiteSpec: JsonObjectSchema.optional(),
  kpiConfig: z
    .object({
      valueField: z.string().optional(),
      format: z.string().optional(),
      comparisonField: z.string().optional(),
      comparisonLabel: z.string().optional(),
    })
    .optional(),
  tableConfig: z
    .object({
      columns: z.array(z.string()).optional(),
      pageSize: z.number().optional(),
    })
    .optional(),
  crossFilter: z.object({
    enabled: z.boolean(),
    fields: z.array(z.string()).optional(),
  }),
  layouts: z.object({
    lg: DashboardLayoutCellSchema,
    md: DashboardLayoutCellSchema.optional(),
    sm: DashboardLayoutCellSchema.optional(),
    xs: DashboardLayoutCellSchema.optional(),
  }),
});

const DashboardGlobalFilterSchema = z.object({
  id: z.string(),
  type: z.enum(["date-range", "select", "multi-select", "search"]),
  label: z.string(),
  dataSourceId: z.string(),
  column: z.string(),
  config: JsonObjectSchema,
  layout: z.object({ order: z.number(), width: z.number().optional() }),
});

const DashboardResponseSchema = z
  .object({
    _id: zObjectId(),
    workspaceId: zObjectId(),
    title: z.string(),
    description: z.string().optional(),
    dataSources: z.array(DashboardDataSourceSchema),
    relationships: z.array(DashboardRelationshipSchema),
    widgets: z.array(DashboardWidgetSchema),
    globalFilters: z.array(DashboardGlobalFilterSchema),
    crossFilter: z.object({
      enabled: z.boolean(),
      resolution: z.enum(["intersect", "union"]),
      engine: z.enum(["mosaic", "legacy"]).optional(),
    }),
    materializationSchedule: z.object({
      enabled: z.boolean(),
      cron: z.string().nullable(),
      timezone: z.string().optional(),
      dataFreshnessTtlMs: z.number().nullable().optional(),
    }),
    layout: z.object({
      columns: z.number(),
      rowHeight: z.number(),
    }),
    cache: z
      .object({
        lastRefreshedAt: zDateTime().optional(),
      })
      .optional(),
    snapshots: z
      .record(
        z.string(),
        z.object({
          version: z.string(),
          generatedAt: zDateTime(),
          rowCount: z.number(),
          rows: z.array(JsonObjectSchema),
          fields: z.array(z.object({ name: z.string(), type: z.string() })),
        }),
      )
      .optional(),
    version: z.number(),
    editLock: z
      .object({
        userId: z.string(),
        userName: z.string(),
        lockedAt: zDateTime(),
        expiresAt: zDateTime(),
      })
      .nullable()
      .optional(),
    folderId: zObjectId().optional(),
    access: z.enum(["private", "workspace"]),
    workspaceRole: z.enum(["viewer", "editor"]).optional(),
    sharedWith: z
      .array(
        z.object({
          userId: z.string(),
          role: z.enum(["viewer", "editor"]),
          addedAt: zDateTime().optional(),
        }),
      )
      .optional(),
    publicShare: z
      .object({
        enabled: z.boolean(),
        token: z.string().optional(),
        hasPassword: z.boolean().optional(),
        createdAt: zDateTime().optional(),
      })
      .optional(),
    owner_id: z.string().optional(),
    createdBy: z.string(),
    createdAt: zDateTime(),
    updatedAt: zDateTime(),
    readOnly: z.boolean().optional(),
  })
  .openapi("Dashboard");

const DashboardReadResponses = {
  200: dataResponse(DashboardResponseSchema, "Dashboard details."),
  401: errorJson("Authentication required"),
  403: errorJson("Access denied"),
  404: errorJson("Dashboard not found"),
  500: errorJson("Internal server error"),
};

function buildDashboardSnapshot(
  doc: IDashboard | Record<string, any>,
): Record<string, unknown> {
  return {
    title: doc.title,
    description: doc.description,
    dataSources: doc.dataSources,
    widgets: doc.widgets,
    relationships: doc.relationships,
    globalFilters: doc.globalFilters,
    crossFilter: doc.crossFilter,
    layout: doc.layout,
    materializationSchedule: doc.materializationSchedule,
  };
}

/**
 * True when the working definition differs from the last published snapshot
 * (or the dashboard was never published). Drives the "unpublished changes" hint
 * so editors know the live/shared version is behind the working draft (e.g.
 * after a restore, which reverts the draft without publishing).
 */
function dashboardHasUnpublishedChanges(
  doc: IDashboard | Record<string, any>,
): boolean {
  if (!doc.published) return true;
  return !snapshotsEqual(buildDashboardSnapshot(doc), doc.published);
}

/**
 * Publish the current definition: stamp it onto a (Mongoose) dashboard doc as
 * the viewer-facing `published` snapshot at the given version, and persist.
 * Call after createVersion on every explicit save.
 */
async function publishDashboard(
  doc: IDashboard,
  version: number,
): Promise<void> {
  doc.published = buildDashboardSnapshot(doc.toObject());
  doc.markModified("published"); // Mixed: assignment isn't auto-tracked
  doc.publishedVersion = version;
  doc.publishedAt = new Date();
  await doc.save();
}

async function normalizeDashboardDataSources(
  workspaceId: string,
  inputDataSources: unknown,
  existingDataSources?: Array<Record<string, any>>,
) {
  if (inputDataSources === undefined) {
    return { success: true as const, dataSources: undefined };
  }

  if (!Array.isArray(inputDataSources)) {
    return {
      success: false as const,
      error: "dataSources must be an array",
    };
  }

  const dataSources = inputDataSources as Array<Record<string, any>>;
  const existingCacheById = new Map(
    (existingDataSources || []).map(dataSource => [
      String(dataSource.id),
      dataSource.cache,
    ]),
  );
  const connectionIds = [
    ...new Set(dataSources.map(ds => ds?.query?.connectionId).filter(Boolean)),
  ];

  for (const connectionId of connectionIds) {
    if (!Types.ObjectId.isValid(String(connectionId))) {
      return {
        success: false as const,
        error: `Invalid connectionId in dashboard data source: ${connectionId}`,
      };
    }
  }

  if (connectionIds.length > 0) {
    const validConnections = await DatabaseConnection.countDocuments({
      _id: {
        $in: connectionIds.map((id: string) => new Types.ObjectId(id)),
      },
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (validConnections !== connectionIds.length) {
      return {
        success: false as const,
        error: "One or more dashboard data source connections are invalid",
      };
    }
  }

  try {
    return {
      success: true as const,
      dataSources: dataSources.map(ds => {
        if (!ds?.name || typeof ds.name !== "string" || !ds.name.trim()) {
          throw new Error("Each dashboard data source must have a name");
        }

        if (!ds?.query || typeof ds.query !== "object") {
          throw new Error(
            `Dashboard data source "${ds.name}" must include an embedded query definition`,
          );
        }

        if (
          !ds.query.language ||
          !DASHBOARD_QUERY_LANGUAGES.has(String(ds.query.language))
        ) {
          throw new Error(
            `Dashboard data source "${ds.name}" has an invalid query language`,
          );
        }

        if (!ds.query.code || typeof ds.query.code !== "string") {
          throw new Error(
            `Dashboard data source "${ds.name}" must include query code`,
          );
        }

        if (!ds.query.connectionId) {
          throw new Error(
            `Dashboard data source "${ds.name}" must include a connectionId`,
          );
        }

        const id = ds.id || nanoid();
        return {
          id,
          name: ds.name.trim(),
          tableRef:
            typeof ds.tableRef === "string" && ds.tableRef.trim()
              ? sanitizeTableRef(ds.tableRef.trim())
              : buildTableRef(ds.name?.trim()),
          query: {
            connectionId: new Types.ObjectId(String(ds.query.connectionId)),
            language: ds.query.language,
            code: ds.query.code,
            databaseId: ds.query.databaseId,
            databaseName: ds.query.databaseName,
            mongoOptions: ds.query.mongoOptions,
          },
          origin: ds.origin
            ? {
                type: ds.origin.type,
                consoleId:
                  ds.origin.consoleId &&
                  Types.ObjectId.isValid(ds.origin.consoleId)
                    ? new Types.ObjectId(String(ds.origin.consoleId))
                    : undefined,
                consoleName: ds.origin.consoleName,
                importedAt: ds.origin.importedAt
                  ? new Date(ds.origin.importedAt)
                  : undefined,
              }
            : undefined,
          timeDimension: ds.timeDimension,
          rowLimit: ds.rowLimit,
          materialization: ds.materialization === "live" ? "live" : "parquet",
          computedColumns: ds.computedColumns || [],
          cache: existingCacheById.get(String(id)),
        };
      }),
    };
  } catch (error) {
    return {
      success: false as const,
      error:
        error instanceof Error
          ? error.message
          : "Invalid dashboard data source definition",
    };
  }
}

function normalizeDashboardWidgetLayouts(dashboard: Record<string, any>) {
  if (Array.isArray(dashboard.widgets)) {
    dashboard.widgets = dashboard.widgets.map((w: Record<string, unknown>) =>
      normalizeWidgetLayouts(w),
    );
  }
  return dashboard;
}

function sanitizeDashboardResponse<
  T extends Record<string, any> & {
    dataSources?: Array<Record<string, unknown>>;
    materializationSchedule?: unknown;
  },
>(dashboard: T): T {
  delete dashboard.materializationMode;
  // Never leak the password hash; expose only safe public-share metadata.
  const loose = dashboard as Record<string, any>;
  // Draft/published: expose a cheap dirty flag, then drop the (large) published
  // snapshot from the editor payload — editors render the live draft fields.
  loose.hasUnpublishedChanges = dashboardHasUnpublishedChanges(loose);
  delete loose.published;
  if (loose.publicShare && typeof loose.publicShare === "object") {
    const ps = loose.publicShare as Record<string, unknown>;
    if (ps.enabled && ps.token) {
      loose.publicShare = {
        enabled: true,
        token: ps.token,
        hasPassword: !!ps.passwordHash,
        createdAt: ps.createdAt,
      };
    } else {
      delete loose.publicShare;
    }
  }
  dashboard.materializationSchedule = normalizeDashboardMaterializationSchedule(
    dashboard.materializationSchedule as
      | Record<string, unknown>
      | null
      | undefined,
  );
  if (dashboard.cache && typeof dashboard.cache === "object") {
    delete dashboard.cache.ttlSeconds;
  }
  if (Array.isArray(dashboard.dataSources)) {
    dashboard.dataSources = dashboard.dataSources.map(
      (dataSource: Record<string, unknown>) => {
        const next = { ...dataSource };
        delete next.materializationMode;
        if (next.cache && typeof next.cache === "object") {
          delete (next.cache as Record<string, unknown>).ttlSeconds;
          delete (next.cache as Record<string, unknown>).parquetExpiresAt;
          delete (next.cache as Record<string, unknown>).materializationRuns;
        }
        return next;
      },
    );
  }
  return dashboard;
}

function getDataSourceDefinitionHashMap(
  dataSources: Array<Record<string, any>>,
) {
  return new Map(
    dataSources.map(ds => [
      String(ds.id),
      buildDashboardDataSourceDefinitionHash(ds as any),
    ]),
  );
}

function didDashboardArtifactInputsChange(
  beforeDataSources: Array<Record<string, any>>,
  afterDataSources: Array<Record<string, any>>,
): boolean {
  if (beforeDataSources.length !== afterDataSources.length) {
    return true;
  }

  const before = getDataSourceDefinitionHashMap(beforeDataSources);
  const after = getDataSourceDefinitionHashMap(afterDataSources);
  if (before.size !== after.size) {
    return true;
  }

  for (const [id, version] of before) {
    if (after.get(id) !== version) {
      return true;
    }
  }

  return false;
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
      // Single membership lookup (used for both access check + role extraction).
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

// GET /api/workspaces/:workspaceId/dashboards - List dashboards as tree
app.openapi(
  createRoute({
    method: "get",
    path: "/",
    tags: ["Dashboards"],
    summary: "GET /",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const userId = c.get("user")?.id;
      const memberRole = c.get("memberRole");

      if (userId) {
        const { myDashboards, workspaceDashboards } =
          await DashboardManager.listDashboardsSplit(
            workspaceId,
            userId,
            memberRole || "member",
          );

        return c.json({
          success: true,
          myDashboards,
          workspaceDashboards,
        });
      }

      return c.json({
        success: true,
        myDashboards: [],
        workspaceDashboards: [],
      });
    } catch (error) {
      logger.error("Error listing dashboards", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/dashboards - Create dashboard
app.openapi(
  createRoute({
    method: "post",
    path: "/",
    tags: ["Dashboards"],
    summary: "POST /",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const user = c.get("user");
      const userId = user?.id ?? "system";
      const body = await c.req.json();
      const {
        cache: _ignoredCache,
        snapshots: _ignoredSnapshots,
        idempotencyKey: rawIdempotencyKey,
        ...dashboardInput
      } = body as Record<string, unknown>;

      if (
        !dashboardInput.title ||
        typeof dashboardInput.title !== "string" ||
        !dashboardInput.title.trim()
      ) {
        return c.json({ success: false, error: "title is required" }, 400);
      }

      // Creation idempotency: agent-driven creates send the toolCallId as the
      // key. Multiple windows attached to the same chat stream dispatch the
      // same create_dashboard call; the first insert wins and every other
      // request gets the SAME dashboard back instead of creating a duplicate.
      const idempotencyKey =
        typeof rawIdempotencyKey === "string" && rawIdempotencyKey.trim()
          ? rawIdempotencyKey.trim()
          : undefined;
      const findExistingByIdempotencyKey = () =>
        idempotencyKey
          ? Dashboard.findOne({
              workspaceId: new Types.ObjectId(workspaceId),
              creationIdempotencyKey: idempotencyKey,
            })
          : null;

      const preExisting = await findExistingByIdempotencyKey();
      if (preExisting) {
        return c.json({
          success: true,
          idempotentReplay: true,
          data: sanitizeDashboardResponse(
            await hydrateDashboardArtifactUrls(preExisting.toObject() as any),
          ),
        });
      }

      if (
        dashboardInput.dataSources &&
        !Array.isArray(dashboardInput.dataSources)
      ) {
        return c.json(
          { success: false, error: "dataSources must be an array" },
          400,
        );
      }

      const normalizedDataSources = await normalizeDashboardDataSources(
        workspaceId,
        dashboardInput.dataSources,
      );
      if (!normalizedDataSources.success) {
        return c.json(
          { success: false, error: normalizedDataSources.error },
          400,
        );
      }

      let materializationSchedule;
      try {
        materializationSchedule = validateDashboardMaterializationSchedule(
          dashboardInput.materializationSchedule as
            | Record<string, unknown>
            | null
            | undefined,
        );
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

      const dashboard = new Dashboard({
        ...dashboardInput,
        dataSources: normalizedDataSources.dataSources || [],
        workspaceId: new Types.ObjectId(workspaceId),
        createdBy: userId,
        owner_id: userId,
        materializationSchedule,
        ...(idempotencyKey ? { creationIdempotencyKey: idempotencyKey } : {}),
      });

      try {
        await dashboard.save();
      } catch (saveError) {
        // E11000 on the { workspaceId, creationIdempotencyKey } unique index:
        // a concurrent duplicate request won the race — return its dashboard.
        const isDuplicateKey =
          (saveError as { code?: number } | null)?.code === 11000;
        if (isDuplicateKey && idempotencyKey) {
          const winner = await findExistingByIdempotencyKey();
          if (winner) {
            return c.json({
              success: true,
              idempotentReplay: true,
              data: sanitizeDashboardResponse(
                await hydrateDashboardArtifactUrls(winner.toObject() as any),
              ),
            });
          }
        }
        throw saveError;
      }

      // Create version 1 for the new dashboard and publish it.
      const displayName = await getUserDisplayName(userId);
      const createdVersion = await createVersion({
        entityType: "dashboard",
        entityId: dashboard._id,
        workspaceId: new Types.ObjectId(workspaceId),
        snapshot: buildDashboardSnapshot(dashboard.toObject()),
        savedBy: userId,
        savedByName: displayName,
        comment: body.comment ?? "",
      });
      await publishDashboard(dashboard, createdVersion.version);

      if (
        (dashboard.dataSources || []).length > 0 &&
        isDashboardMaterializationEnabled(dashboard.materializationSchedule)
      ) {
        await queueDashboardArtifactRefresh({
          dashboardId: dashboard._id.toString(),
          triggerType: "dashboard_update",
        }).catch(() => undefined);
      }

      return c.json({
        success: true,
        data: sanitizeDashboardResponse(
          await hydrateDashboardArtifactUrls(dashboard.toObject() as any),
        ),
      });
    } catch (error) {
      logger.error("Error creating dashboard", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// GET /api/workspaces/:workspaceId/dashboards/:id - Get dashboard by ID
app.openapi(
  createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Dashboards"],
    summary: "GET /{id}",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
    },
    responses: DashboardReadResponses,
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");

      const dashboard = await Dashboard.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!dashboard) {
        return c.json({ success: false, error: "Dashboard not found" }, 404);
      }

      const userId = c.get("user")?.id;
      if (userId && !DashboardManager.canRead(dashboard, userId)) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      const memberRole = c.get("memberRole");
      const isAdmin = memberRole === "owner" || memberRole === "admin";
      const readOnly = !DashboardManager.canWrite(
        dashboard,
        userId,
        isAdmin,
        memberRole,
      );

      const plain = dashboard.toObject ? dashboard.toObject() : dashboard;
      normalizeDashboardWidgetLayouts(plain);

      return c.json(
        {
          success: true as const,
          data: {
            ...sanitizeDashboardResponse(
              await hydrateDashboardArtifactUrls(plain as any),
            ),
            readOnly,
          },
        },
        200,
      );
    } catch (error) {
      logger.error("Error getting dashboard", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// PUT /api/workspaces/:workspaceId/dashboards/:id - Full update
app.openapi(
  createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Dashboards"],
    summary: "PUT /{id}",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const body = await c.req.json();

      const dashboard = await Dashboard.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!dashboard) {
        return c.json({ success: false, error: "Dashboard not found" }, 404);
      }

      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const memberRole = c.get("memberRole");
      const isAdmin = memberRole === "owner" || memberRole === "admin";
      if (!DashboardManager.canWrite(dashboard, userId, isAdmin, memberRole)) {
        return c.json(
          {
            success: false,
            error: "You do not have permission to edit this dashboard",
          },
          403,
        );
      }

      // Edit lock enforcement
      const lock = dashboard.editLock;
      if (lock && lock.expiresAt > new Date() && lock.userId !== userId) {
        return c.json(
          {
            success: false,
            error: "Dashboard is locked for editing",
            code: "EDIT_LOCKED",
            lockedBy: { userId: lock.userId, userName: lock.userName },
          },
          423,
        );
      }

      const previousDataSources = dashboard.toObject().dataSources || [];

      const updateFields: Record<string, unknown> = {};
      if (body.title !== undefined) {
        updateFields.title = body.title;
      }
      if (body.description !== undefined) {
        updateFields.description = body.description;
      }
      if (body.dataSources !== undefined) {
        const normalizedDataSources = await normalizeDashboardDataSources(
          workspaceId,
          body.dataSources,
          previousDataSources,
        );
        if (!normalizedDataSources.success) {
          return c.json(
            { success: false, error: normalizedDataSources.error },
            400,
          );
        }
        updateFields.dataSources = normalizedDataSources.dataSources || [];
      }
      if (body.widgets !== undefined) {
        updateFields.widgets = body.widgets;
      }
      if (body.relationships !== undefined) {
        updateFields.relationships = body.relationships;
      }
      if (body.globalFilters !== undefined) {
        updateFields.globalFilters = body.globalFilters;
      }
      if (body.layout !== undefined) {
        updateFields.layout = body.layout;
      }
      if (body.crossFilter !== undefined) {
        updateFields.crossFilter = body.crossFilter;
      }
      if (body.materializationSchedule !== undefined) {
        try {
          updateFields.materializationSchedule =
            validateDashboardMaterializationSchedule(
              body.materializationSchedule,
            );
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
      if (body.access !== undefined || body.workspaceRole !== undefined) {
        // Changing visibility is owner/admin-only — collaborators can edit
        // content but must not be able to re-scope who can see the dashboard.
        if (!DashboardManager.isOwner(dashboard, userId) && !isAdmin) {
          return c.json(
            {
              success: false,
              error:
                "Only the owner or an admin can change dashboard visibility",
            },
            403,
          );
        }
        if (body.access !== undefined) {
          updateFields.access = body.access;
        }
        if (
          body.workspaceRole === "viewer" ||
          body.workspaceRole === "editor"
        ) {
          updateFields.workspaceRole = body.workspaceRole;
        }
      }

      // Atomic optimistic concurrency update
      const clientVersion =
        typeof body.version === "number" ? body.version : null;
      const filter: Record<string, unknown> = {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      };
      if (clientVersion !== null) {
        filter.version = clientVersion;
      }

      const updated = await Dashboard.findOneAndUpdate(
        filter,
        {
          $set: updateFields,
          $inc: { version: 1 },
        },
        { new: true, runValidators: true },
      );

      if (!updated) {
        const latest = await Dashboard.findOne({
          _id: new Types.ObjectId(id),
          workspaceId: new Types.ObjectId(workspaceId),
        });
        if (latest) {
          const plain = latest.toObject ? latest.toObject() : latest;
          normalizeDashboardWidgetLayouts(plain);
          return c.json(
            {
              success: false,
              error: "Dashboard was modified by another user",
              code: "VERSION_CONFLICT",
              serverVersion: latest.version,
              data: sanitizeDashboardResponse(
                await hydrateDashboardArtifactUrls(plain as any),
              ),
            },
            409,
          );
        }
        return c.json({ success: false, error: "Dashboard not found" }, 404);
      }

      // Create version record for the new state
      const putDisplayName = await getUserDisplayName(userId);
      const putVersion = await createVersion({
        entityType: "dashboard",
        entityId: updated._id,
        workspaceId: new Types.ObjectId(workspaceId),
        snapshot: buildDashboardSnapshot(updated.toObject()),
        savedBy: userId,
        savedByName: putDisplayName,
        comment: body.comment ?? "",
      });
      // A full update is a publish.
      await publishDashboard(updated, putVersion.version);

      publishRealtimeEvent(workspaceId, {
        type: "dashboard.updated",
        dashboardId: updated._id.toString(),
        version: updated.version,
        updatedBy: userId,
        clientId: typeof body.clientId === "string" ? body.clientId : undefined,
        origin: "save",
      });

      if (
        didDashboardArtifactInputsChange(
          previousDataSources as any[],
          (updated.toObject().dataSources || []) as any[],
        ) &&
        isDashboardMaterializationEnabled(updated.materializationSchedule)
      ) {
        void queueDashboardArtifactRefresh({
          dashboardId: updated._id.toString(),
          triggerType: "dashboard_update",
        }).catch(() => undefined);
      }

      return c.json({
        success: true,
        data: sanitizeDashboardResponse(
          await hydrateDashboardArtifactUrls(updated.toObject() as any),
        ),
      });
    } catch (error) {
      logger.error("Error updating dashboard", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// PATCH /api/workspaces/:workspaceId/dashboards/:id - Partial update (widget mutations, layout changes)
app.openapi(
  createRoute({
    method: "patch",
    path: "/{id}",
    tags: ["Dashboards"],
    summary: "PATCH /{id}",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const body = await c.req.json();

      const existing = await Dashboard.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!existing) {
        return c.json({ success: false, error: "Dashboard not found" }, 404);
      }

      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const memberRole = c.get("memberRole");
      const isAdmin = memberRole === "owner" || memberRole === "admin";
      if (!DashboardManager.canWrite(existing, userId, isAdmin, memberRole)) {
        return c.json(
          {
            success: false,
            error: "You do not have permission to edit this dashboard",
          },
          403,
        );
      }

      // Edit lock enforcement: reject saves from users who don't own the lock
      const lock = existing.editLock;
      if (lock && lock.expiresAt > new Date() && lock.userId !== userId) {
        return c.json(
          {
            success: false,
            error: "Dashboard is locked for editing",
            code: "EDIT_LOCKED",
            lockedBy: { userId: lock.userId, userName: lock.userName },
          },
          423,
        );
      }

      // Normalize widget layouts and defaults before schema validation
      if (Array.isArray(body.widgets)) {
        body.widgets = body.widgets.map((w: Record<string, unknown>) => {
          const normalized = normalizeWidgetLayouts(w);
          if (!normalized.crossFilter) {
            normalized.crossFilter = { enabled: true };
          }
          return normalized;
        });
      }

      const validation = DashboardDefinitionSchema.partial().safeParse(body);
      if (!validation.success) {
        const issues = validation.error.issues.map(
          (i: { path: PropertyKey[]; message: string }) => ({
            path: i.path.join("."),
            message: i.message,
          }),
        );
        logger.warn("Dashboard PATCH validation failed", {
          dashboardId: id,
          workspaceId,
          issues,
        });
        return c.json(
          { success: false, error: "Invalid dashboard definition", issues },
          400,
        );
      }
      const validatedBody = validation.data as Record<string, unknown>;

      if (validatedBody.dataSources !== undefined) {
        const normalizedDataSources = await normalizeDashboardDataSources(
          workspaceId,
          validatedBody.dataSources as any[],
          existing.toObject().dataSources || [],
        );
        if (!normalizedDataSources.success) {
          logger.warn("Dashboard PATCH data source normalization failed", {
            dashboardId: id,
            workspaceId,
            error: normalizedDataSources.error,
          });
          return c.json(
            { success: false, error: normalizedDataSources.error },
            400,
          );
        }
        validatedBody.dataSources = normalizedDataSources.dataSources;
      }
      delete validatedBody.cache;
      delete validatedBody.snapshots;
      if (validatedBody.materializationSchedule !== undefined) {
        try {
          validatedBody.materializationSchedule =
            validateDashboardMaterializationSchedule(
              validatedBody.materializationSchedule as Record<string, unknown>,
            );
        } catch (error) {
          const msg =
            error instanceof Error
              ? error.message
              : "Invalid materialization schedule";
          logger.warn("Dashboard PATCH materialization schedule invalid", {
            dashboardId: id,
            workspaceId,
            error: msg,
          });
          return c.json({ success: false, error: msg }, 400);
        }
      }

      const previousDataSources = existing.toObject().dataSources || [];

      // Optimistic concurrency: if client sends a version, require it to match
      const clientVersion =
        typeof body.version === "number" ? body.version : null;
      const filter: Record<string, unknown> = {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      };
      if (clientVersion !== null) {
        filter.version = clientVersion;
      }

      const dashboard = await Dashboard.findOneAndUpdate(
        filter,
        {
          $set: validatedBody,
          $inc: { version: 1 },
        },
        { new: true, runValidators: true },
      );

      if (!dashboard) {
        if (clientVersion !== null) {
          const current = await Dashboard.findOne({
            _id: new Types.ObjectId(id),
            workspaceId: new Types.ObjectId(workspaceId),
          });
          if (current) {
            const plain = current.toObject ? current.toObject() : current;
            normalizeDashboardWidgetLayouts(plain);
            return c.json(
              {
                success: false,
                error: "Dashboard was modified by another user",
                code: "VERSION_CONFLICT",
                serverVersion: current.version,
                data: sanitizeDashboardResponse(
                  await hydrateDashboardArtifactUrls(plain as any),
                ),
              },
              409,
            );
          }
        }
        return c.json({ success: false, error: "Dashboard not found" }, 404);
      }

      if (typeof body.comment === "string") {
        const patchDisplayName = await getUserDisplayName(userId);
        const createdVersion = await createVersion({
          entityType: "dashboard",
          entityId: dashboard._id,
          workspaceId: new Types.ObjectId(workspaceId),
          snapshot: buildDashboardSnapshot(dashboard.toObject()),
          savedBy: userId,
          savedByName: patchDisplayName,
          comment: body.comment,
        });
        // Explicit save publishes: the snapshot becomes the viewer-facing def.
        await publishDashboard(dashboard, createdVersion.version);
      }

      // Poke open tabs (poke-then-pull) so other viewers reload the saved def.
      publishRealtimeEvent(workspaceId, {
        type: "dashboard.updated",
        dashboardId: dashboard._id.toString(),
        version: dashboard.version,
        updatedBy: userId,
        clientId: typeof body.clientId === "string" ? body.clientId : undefined,
        origin: "save",
      });

      if (
        didDashboardArtifactInputsChange(
          previousDataSources as any[],
          (dashboard.toObject().dataSources || []) as any[],
        ) &&
        isDashboardMaterializationEnabled(dashboard.materializationSchedule)
      ) {
        void queueDashboardArtifactRefresh({
          dashboardId: dashboard._id.toString(),
          triggerType: "dashboard_update",
        }).catch(() => undefined);
      }

      return c.json({
        success: true,
        data: sanitizeDashboardResponse(
          await hydrateDashboardArtifactUrls(dashboard.toObject() as any),
        ),
      });
    } catch (error) {
      logger.error("Error patching dashboard", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/dashboards/:id/version-comment
// Generate an AI-suggested commit message for the dashboard changes about to
// be saved. Diffs the pending definition against the latest saved version and
// folds in any chat prompts that drove the changes.
app.openapi(
  createRoute({
    method: "post",
    path: "/{id}/version-comment",
    tags: ["Dashboards"],
    summary: "POST /{id}/version-comment",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const dashboardId = c.req.param("id");
      const userId = c.get("user")?.id;

      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      if (!Types.ObjectId.isValid(dashboardId)) {
        return c.json(
          { success: false, error: "Invalid dashboard ID format" },
          400,
        );
      }

      const body = await c.req.json().catch(() => ({}));
      const definition =
        body && typeof body.definition === "object" && body.definition !== null
          ? (body.definition as Record<string, unknown>)
          : (body as Record<string, unknown>);

      const newSnapshot = buildDashboardSnapshot(definition);

      const latestVersion = await EntityVersion.findOne(
        {
          entityId: new Types.ObjectId(dashboardId),
          entityType: "dashboard",
        },
        { snapshot: 1, version: 1 },
      )
        .sort({ version: -1 })
        .lean();

      const previousSnapshot =
        (latestVersion?.snapshot as Record<string, unknown> | undefined) ??
        null;

      const chatPrompts = await getEntityChatPrompts(
        workspaceId,
        userId,
        dashboardId,
        ["dashboardId"],
      );

      const result = await generateDashboardVersionComment(
        { previousSnapshot, newSnapshot, chatPrompts },
        { workspaceId, userId, userEmail: c.get("user")?.email },
      );

      return c.json({
        success: true,
        comment: result.comment,
        diff: result.diff,
      });
    } catch (error) {
      logger.error("Error generating dashboard version comment", { error });
      return c.json(
        { success: false, error: "Failed to generate version comment" },
        500,
      );
    }
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/{id}/refresh",
    tags: ["Dashboards"],
    summary: "POST /{id}/refresh",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const dashboard = await Dashboard.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!dashboard) {
        return c.json({ success: false, error: "Dashboard not found" }, 404);
      }

      const userId = c.get("user")?.id;
      if (userId && !DashboardManager.canRead(dashboard, userId)) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      const queueResult = await queueDashboardArtifactRefresh({
        dashboardId: dashboard._id.toString(),
        workspaceId: dashboard.workspaceId.toString(),
        force: true,
        triggerType: "manual",
      });

      return c.json({
        success: true,
        queued: queueResult.queued,
        alreadyRunning: !queueResult.queued,
        activeRunIds: queueResult.activeRunIds || [],
      });
    } catch (error) {
      logger.error("Error refreshing dashboard artifacts", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to refresh dashboard artifacts",
        },
        500,
      );
    }
  },
);

// DELETE /api/workspaces/:workspaceId/dashboards/:id - Delete dashboard
app.openapi(
  createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Dashboards"],
    summary: "DELETE /{id}",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");

      const dashboard = await Dashboard.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!dashboard) {
        return c.json({ success: false, error: "Dashboard not found" }, 404);
      }

      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const memberRole = c.get("memberRole");
      const isAdmin = memberRole === "owner" || memberRole === "admin";
      if (!DashboardManager.canWrite(dashboard, userId, isAdmin, memberRole)) {
        return c.json(
          {
            success: false,
            error: "You do not have permission to delete this dashboard",
          },
          403,
        );
      }

      await Dashboard.deleteOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      return c.json({
        success: true,
        message: "Dashboard deleted successfully",
      });
    } catch (error) {
      logger.error("Error deleting dashboard", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/dashboards/:id/duplicate - Duplicate dashboard
app.openapi(
  createRoute({
    method: "post",
    path: "/{id}/duplicate",
    tags: ["Dashboards"],
    summary: "POST /{id}/duplicate",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const user = c.get("user");
      const userId = user?.id ?? "system";

      const dashboard = await Dashboard.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!dashboard) {
        return c.json({ success: false, error: "Dashboard not found" }, 404);
      }

      if (!DashboardManager.canRead(dashboard, userId)) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      const spec: any = dashboard.toObject();
      delete spec._id;
      delete spec.__v;
      // A duplicate is a fresh, owner-only private copy: never inherit the
      // original's collaborators or a stale edit lock.
      delete spec.sharedWith;
      delete spec.editLock;
      spec.title = `${spec.title} (copy)`;
      spec.createdBy = userId;
      spec.owner_id = userId;
      spec.access = "private";

      // Regenerate all internal IDs and remap references
      const dsIdMap = new Map<string, string>();
      spec.dataSources = spec.dataSources.map((ds: any) => {
        const newId = nanoid();
        dsIdMap.set(ds.id, newId);
        return { ...ds, id: newId };
      });
      spec.widgets = spec.widgets.map((w: any) => ({
        ...w,
        id: nanoid(),
        dataSourceId: dsIdMap.get(w.dataSourceId) || w.dataSourceId,
      }));
      spec.relationships = spec.relationships.map((r: any) => ({
        ...r,
        id: nanoid(),
        from: {
          ...r.from,
          dataSourceId: dsIdMap.get(r.from.dataSourceId) || r.from.dataSourceId,
        },
        to: {
          ...r.to,
          dataSourceId: dsIdMap.get(r.to.dataSourceId) || r.to.dataSourceId,
        },
      }));
      spec.globalFilters = spec.globalFilters.map((f: any) => ({
        ...f,
        id: nanoid(),
        dataSourceId: dsIdMap.get(f.dataSourceId) || f.dataSourceId,
      }));

      const duplicate = new Dashboard(spec);
      await duplicate.save();
      if (
        (duplicate.dataSources || []).length > 0 &&
        isDashboardMaterializationEnabled(duplicate.materializationSchedule)
      ) {
        await queueDashboardArtifactRefresh({
          dashboardId: duplicate._id.toString(),
          triggerType: "dashboard_update",
        }).catch(() => undefined);
      }

      return c.json({
        success: true,
        data: sanitizeDashboardResponse(
          await hydrateDashboardArtifactUrls(duplicate.toObject() as any),
        ),
      });
    } catch (error) {
      logger.error("Error duplicating dashboard", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// ── Edit lock endpoints ──

const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

// POST /api/workspaces/:workspaceId/dashboards/:id/lock - Acquire edit lock
// Query params: ?force=true to forcefully take the lock from another user
app.openapi(
  createRoute({
    method: "post",
    path: "/{id}/lock",
    tags: ["Dashboards"],
    summary: "POST /{id}/lock",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      query: z.object({
        force: z
          .string()
          .optional()
          .openapi({ param: { name: "force", in: "query" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const force = c.req.query("force") === "true";
      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      if (force) {
        const memberRole = c.get("memberRole");
        const isAdmin = memberRole === "owner" || memberRole === "admin";
        if (!isAdmin) {
          return c.json(
            { success: false, error: "Only admins can force-lock a dashboard" },
            403,
          );
        }
      }

      const user = c.get("user");
      const userName = user?.email || userId;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

      const filter: Record<string, unknown> = {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      };
      if (!force) {
        filter.$or = [
          { editLock: null },
          { "editLock.userId": { $exists: false } },
          { "editLock.expiresAt": { $lt: now } },
          { "editLock.userId": userId },
        ];
      }

      const dashboard = await Dashboard.findOneAndUpdate(
        filter,
        {
          $set: {
            editLock: {
              userId,
              userName,
              lockedAt: now,
              expiresAt,
            },
          },
        },
        {
          new: true,
          projection: {
            _id: 1,
            editLock: 1,
          },
        },
      );

      if (!dashboard) {
        const existing = await Dashboard.findOne(
          {
            _id: new Types.ObjectId(id),
            workspaceId: new Types.ObjectId(workspaceId),
          },
          {
            _id: 1,
            editLock: 1,
          },
        );
        if (!existing) {
          return c.json({ success: false, error: "Dashboard not found" }, 404);
        }
        return c.json(
          {
            success: false,
            error: "Dashboard is locked for editing",
            code: "EDIT_LOCKED",
            lockedBy: {
              userId: existing.editLock?.userId,
              userName: existing.editLock?.userName,
            },
            expiresAt: existing.editLock?.expiresAt,
          },
          409,
        );
      }

      return c.json({
        success: true,
        data: {
          editLock: dashboard.editLock,
        },
      });
    } catch (error) {
      logger.error("Error acquiring dashboard lock", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// POST /api/workspaces/:workspaceId/dashboards/:id/lock/heartbeat - Extend lock
app.openapi(
  createRoute({
    method: "post",
    path: "/{id}/lock/heartbeat",
    tags: ["Dashboards"],
    summary: "POST /{id}/lock/heartbeat",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

      const dashboard = await Dashboard.findOneAndUpdate(
        {
          _id: new Types.ObjectId(id),
          workspaceId: new Types.ObjectId(workspaceId),
          "editLock.userId": userId,
        },
        {
          $set: {
            "editLock.expiresAt": expiresAt,
          },
        },
        { new: true },
      );

      if (!dashboard) {
        return c.json({ success: false, error: "Lock not held" }, 404);
      }

      return c.json({ success: true });
    } catch (error) {
      logger.error("Error extending dashboard lock", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// DELETE /api/workspaces/:workspaceId/dashboards/:id/lock - Release lock
app.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/lock",
    tags: ["Dashboards"],
    summary: "DELETE /{id}/lock",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      const memberRole = c.get("memberRole");
      const isAdmin = memberRole === "owner" || memberRole === "admin";

      const filter: Record<string, unknown> = {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      };
      if (!isAdmin) {
        filter["editLock.userId"] = userId;
      }

      await Dashboard.findOneAndUpdate(filter, {
        $unset: { editLock: "" },
      });

      return c.json({ success: true });
    } catch (error) {
      logger.error("Error releasing dashboard lock", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// ── Folder endpoints ──

// POST /api/workspaces/:workspaceId/dashboards/folders - Create folder
app.openapi(
  createRoute({
    method: "post",
    path: "/folders",
    tags: ["Dashboards"],
    summary: "POST /folders",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }
      const body = await c.req.json();
      const { name, parentId, access } = body;

      if (!name || typeof name !== "string" || !name.trim()) {
        return c.json(
          { success: false, error: "Folder name is required" },
          400,
        );
      }

      if (parentId && !Types.ObjectId.isValid(parentId)) {
        return c.json({ success: false, error: "Invalid parentId" }, 400);
      }

      const folder = new DashboardFolder({
        workspaceId: new Types.ObjectId(workspaceId),
        name: name.trim(),
        parentId: parentId ? new Types.ObjectId(parentId) : undefined,
        ownerId: userId,
        access: access || "private",
      });

      await folder.save();
      return c.json({
        success: true,
        data: {
          id: folder._id.toString(),
          name: folder.name,
          parentId: folder.parentId?.toString() || null,
          access: folder.access,
          ownerId: folder.ownerId,
        },
      });
    } catch (error) {
      logger.error("Error creating dashboard folder", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// PATCH /api/workspaces/:workspaceId/dashboards/folders/:id/rename
app.openapi(
  createRoute({
    method: "patch",
    path: "/folders/{id}/rename",
    tags: ["Dashboards"],
    summary: "PATCH /folders/{id}/rename",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const folderId = c.req.param("id");
      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      const body = await c.req.json();
      const { name } = body;

      if (!name || typeof name !== "string" || !name.trim()) {
        return c.json(
          { success: false, error: "Folder name is required" },
          400,
        );
      }

      const folder = await DashboardFolder.findOne({
        _id: new Types.ObjectId(folderId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!folder) {
        return c.json({ success: false, error: "Folder not found" }, 404);
      }

      const memberRole = c.get("memberRole");
      const isAdmin = memberRole === "owner" || memberRole === "admin";
      if (folder.ownerId !== userId && !isAdmin) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      folder.name = name.trim();
      await folder.save();

      return c.json({
        success: true,
        data: { id: folder._id.toString(), name: folder.name },
      });
    } catch (error) {
      logger.error("Error renaming dashboard folder", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// DELETE /api/workspaces/:workspaceId/dashboards/folders/:id
app.openapi(
  createRoute({
    method: "delete",
    path: "/folders/{id}",
    tags: ["Dashboards"],
    summary: "DELETE /folders/{id}",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const folderId = c.req.param("id");
      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      const folder = await DashboardFolder.findOne({
        _id: new Types.ObjectId(folderId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!folder) {
        return c.json({ success: false, error: "Folder not found" }, 404);
      }

      const memberRole = c.get("memberRole");
      const isAdmin = memberRole === "owner" || memberRole === "admin";
      if (folder.ownerId !== userId && !isAdmin) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      const wsId = new Types.ObjectId(workspaceId);
      const collectFolderIds = async (
        parentId: Types.ObjectId,
      ): Promise<Types.ObjectId[]> => {
        const children = await DashboardFolder.find({
          workspaceId: wsId,
          parentId,
        });
        const ids: Types.ObjectId[] = [];
        for (const child of children) {
          ids.push(child._id);
          ids.push(...(await collectFolderIds(child._id)));
        }
        return ids;
      };

      const descendantIds = await collectFolderIds(
        new Types.ObjectId(folderId),
      );
      const allFolderIds = [new Types.ObjectId(folderId), ...descendantIds];

      await Dashboard.updateMany(
        { workspaceId: wsId, folderId: { $in: allFolderIds } },
        { $unset: { folderId: "" } },
      );
      await DashboardFolder.deleteMany({ _id: { $in: allFolderIds } });

      return c.json({ success: true });
    } catch (error) {
      logger.error("Error deleting dashboard folder", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// PATCH /api/workspaces/:workspaceId/dashboards/folders/:id/move
app.openapi(
  createRoute({
    method: "patch",
    path: "/folders/{id}/move",
    tags: ["Dashboards"],
    summary: "PATCH /folders/{id}/move",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const folderId = c.req.param("id");
      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      const body = await c.req.json();
      const { parentId, access } = body;

      const folder = await DashboardFolder.findOne({
        _id: new Types.ObjectId(folderId),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!folder) {
        return c.json({ success: false, error: "Folder not found" }, 404);
      }

      if (parentId !== undefined && parentId !== null) {
        const wouldCycle = await DashboardManager.wouldCreateCycle(
          folderId,
          parentId,
          workspaceId,
        );
        if (wouldCycle) {
          return c.json(
            { success: false, error: "Folder not found or circular nesting" },
            404,
          );
        }
      }

      if (parentId !== undefined) {
        folder.parentId = parentId ? new Types.ObjectId(parentId) : undefined;
      }
      if (access !== undefined) {
        folder.access = access;
      }
      await folder.save();

      return c.json({ success: true });
    } catch (error) {
      logger.error("Error moving dashboard folder", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// PATCH /api/workspaces/:workspaceId/dashboards/:id/move - Move dashboard to folder
app.openapi(
  createRoute({
    method: "patch",
    path: "/{id}/move",
    tags: ["Dashboards"],
    summary: "PATCH /{id}/move",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const userId = c.get("user")?.id;
      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      const body = await c.req.json();
      const { folderId, access } = body;

      const dashboard = await Dashboard.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });

      if (!dashboard) {
        return c.json({ success: false, error: "Dashboard not found" }, 404);
      }

      const memberRole = c.get("memberRole");
      const isAdmin = memberRole === "owner" || memberRole === "admin";
      if (!DashboardManager.canWrite(dashboard, userId, isAdmin, memberRole)) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      if (folderId !== undefined) {
        dashboard.folderId = folderId
          ? new Types.ObjectId(folderId)
          : undefined;
      }
      if (access !== undefined) {
        // Visibility changes are owner/admin-only (see PUT handler).
        if (!DashboardManager.isOwner(dashboard, userId) && !isAdmin) {
          return c.json(
            {
              success: false,
              error:
                "Only the owner or an admin can change dashboard visibility",
            },
            403,
          );
        }
        dashboard.access = access;
      }
      await dashboard.save();

      return c.json({ success: true });
    } catch (error) {
      logger.error("Error moving dashboard", { error });
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Version history routes
// ---------------------------------------------------------------------------

// GET /api/workspaces/:workspaceId/dashboards/:id/versions
app.openapi(
  createRoute({
    method: "get",
    path: "/{id}/versions",
    tags: ["Dashboards"],
    summary: "List dashboard versions",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
      }),
      query: z.object({
        limit: z
          .string()
          .optional()
          .openapi({ param: { name: "limit", in: "query" } }),
        offset: z
          .string()
          .optional()
          .openapi({ param: { name: "offset", in: "query" } }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const userId = c.get("user")?.id;

      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      if (!Types.ObjectId.isValid(id)) {
        return c.json({ success: false, error: "Invalid dashboard ID" }, 400);
      }

      const dashboard = await Dashboard.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!dashboard) {
        return c.json({ success: false, error: "Dashboard not found" }, 404);
      }
      if (!DashboardManager.canRead(dashboard, userId)) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      const limit = Math.min(
        parseInt(c.req.query("limit") ?? "50", 10) || 50,
        100,
      );
      const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;

      const result = await listVersions(new Types.ObjectId(id), "dashboard", {
        limit,
        offset,
      });

      return c.json({ success: true, ...result });
    } catch (error) {
      logger.error("Error listing dashboard versions", { error });
      return c.json({ success: false, error: "Failed to list versions" }, 500);
    }
  },
);

// GET /api/workspaces/:workspaceId/dashboards/:id/versions/:version
app.openapi(
  createRoute({
    method: "get",
    path: "/{id}/versions/{version}",
    tags: ["Dashboards"],
    summary: "GET /{id}/versions/{version}",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
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

      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      if (!Types.ObjectId.isValid(id) || isNaN(versionNum)) {
        return c.json(
          { success: false, error: "Invalid dashboard ID or version" },
          400,
        );
      }

      const dashboard = await Dashboard.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!dashboard) {
        return c.json({ success: false, error: "Dashboard not found" }, 404);
      }
      if (!DashboardManager.canRead(dashboard, userId)) {
        return c.json({ success: false, error: "Access denied" }, 403);
      }

      const version = await getVersion(id, "dashboard", versionNum);
      if (!version) {
        return c.json({ success: false, error: "Version not found" }, 404);
      }

      return c.json({ success: true, version });
    } catch (error) {
      logger.error("Error getting dashboard version", { error });
      return c.json({ success: false, error: "Failed to get version" }, 500);
    }
  },
);

// POST /api/workspaces/:workspaceId/dashboards/:id/versions/:version/restore
app.openapi(
  createRoute({
    method: "post",
    path: "/{id}/versions/{version}/restore",
    tags: ["Dashboards"],
    summary: "POST /{id}/versions/{version}/restore",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        workspaceId: z
          .string()
          .openapi({ param: { name: "workspaceId", in: "path" } }),
        id: z.string().openapi({ param: { name: "id", in: "path" } }),
        version: z.string().openapi({ param: { name: "version", in: "path" } }),
      }),
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId = c.req.param("workspaceId") as string;
      const id = c.req.param("id");
      const versionNum = parseInt(c.req.param("version"), 10);
      const body = await c.req.json().catch(() => ({}));
      const userId = c.get("user")?.id;

      if (!userId) {
        return c.json({ success: false, error: "Unauthorized" }, 401);
      }

      if (!Types.ObjectId.isValid(id) || isNaN(versionNum)) {
        return c.json(
          { success: false, error: "Invalid dashboard ID or version" },
          400,
        );
      }

      const dashboard = await Dashboard.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (!dashboard) {
        return c.json({ success: false, error: "Dashboard not found" }, 404);
      }

      const memberRole = c.get("memberRole");
      const isAdmin = memberRole === "owner" || memberRole === "admin";
      if (!DashboardManager.canWrite(dashboard, userId, isAdmin, memberRole)) {
        return c.json(
          { success: false, error: "You do not have write access" },
          403,
        );
      }

      const oldVersion = await getVersion(id, "dashboard", versionNum);
      if (!oldVersion) {
        return c.json({ success: false, error: "Version not found" }, 404);
      }

      const snap = oldVersion.snapshot as Record<string, any>;

      const restoreFields: Record<string, any> = {
        title: snap.title,
        description: snap.description,
        dataSources: snap.dataSources,
        widgets: snap.widgets,
        relationships: snap.relationships,
        globalFilters: snap.globalFilters,
        crossFilter: snap.crossFilter,
        layout: snap.layout,
        materializationSchedule: snap.materializationSchedule,
      };

      const restored = await Dashboard.findOneAndUpdate(
        {
          _id: new Types.ObjectId(id),
          workspaceId: new Types.ObjectId(workspaceId),
        },
        { $set: restoreFields, $inc: { version: 1 } },
        { new: true },
      );

      if (!restored) {
        return c.json({ success: false, error: "Restore failed" }, 500);
      }

      const displayName = await getUserDisplayName(userId);
      const comment = body.comment ?? `Restored from version ${versionNum}`;
      await createVersion({
        entityType: "dashboard",
        entityId: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
        snapshot: buildDashboardSnapshot(restored.toObject()),
        savedBy: userId,
        savedByName: displayName,
        comment,
        restoredFrom: versionNum,
      });

      // Restore reverts the working draft only (no publish): public/shared
      // viewers keep seeing the published version until the next explicit save.
      // Poke open editor tabs so they reload the reverted draft.
      publishRealtimeEvent(workspaceId, {
        type: "dashboard.updated",
        dashboardId: restored._id.toString(),
        version: restored.version,
        updatedBy: userId,
        origin: "save",
      });

      return c.json({
        success: true,
        message: `Restored to version ${versionNum}`,
        data: sanitizeDashboardResponse(
          await hydrateDashboardArtifactUrls(restored.toObject() as any),
        ),
      });
    } catch (error) {
      logger.error("Error restoring dashboard version", { error });
      return c.json(
        { success: false, error: "Failed to restore version" },
        500,
      );
    }
  },
);

// ── Sharing (collaborators, general access, public link) ──

const loadDashboardById = workspaceResourceLoader(Dashboard);

registerCollaboratorRoutes(app, {
  resourceName: "Dashboard",
  load: loadDashboardById,
});
registerSharingSettingsRoutes(app, {
  resourceName: "Dashboard",
  load: loadDashboardById,
});
registerPublicShareRoutes(app, {
  resourceName: "Dashboard",
  load: loadDashboardById,
  getTitle: doc => (doc as unknown as IDashboard).title,
});

export const dashboardRoutes = app;
