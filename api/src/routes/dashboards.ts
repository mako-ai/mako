import { Hono } from "hono";
import {
  Dashboard,
  DashboardFolder,
  DatabaseConnection,
} from "../database/workspace-schema";
import { User } from "../database/schema";
import { Types } from "mongoose";
import { nanoid } from "nanoid";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import {
  DashboardDefinitionSchema,
  normalizeWidgetLayouts,
} from "@mako/schemas";
import { hydrateDashboardArtifactUrls } from "../services/dashboard-cache.service";
import { buildDashboardDataSourceVersion } from "../services/dashboard-artifact-rebuild.service";
import {
  isDashboardMaterializationEnabled,
  normalizeDashboardMaterializationSchedule,
  validateDashboardMaterializationSchedule,
} from "../services/dashboard-materialization-schedule.service";
import { queueDashboardArtifactRefresh } from "../services/dashboard-refresh-runner.service";
import { DashboardManager } from "../utils/dashboard-manager";

const logger = loggers.api("dashboards");

const app = new Hono();

const DASHBOARD_QUERY_LANGUAGES = new Set(["sql", "javascript", "mongodb"]);

function sanitizeTableRef(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+/, "") || "ds_table";
}

async function normalizeDashboardDataSources(
  workspaceId: string,
  inputDataSources: unknown,
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
  const connectionIds = dataSources
    .map(ds => ds?.query?.connectionId)
    .filter(Boolean);

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
          tableRef: sanitizeTableRef(
            typeof ds.tableRef === "string" && ds.tableRef.trim()
              ? ds.tableRef.trim()
              : `ds_${nanoid()}`,
          ),
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
          computedColumns: ds.computedColumns || [],
          cache: ds.cache,
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

function getDataSourceVersionMap(dataSources: Array<Record<string, any>>) {
  return new Map(
    dataSources.map(ds => [
      String(ds.id),
      buildDashboardDataSourceVersion(ds as any),
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

  const before = getDataSourceVersionMap(beforeDataSources);
  const after = getDataSourceVersionMap(afterDataSources);
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
      const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
      if (!hasAccess) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }
      const member = await workspaceService.getMember(workspaceId, user.id);
      if (member) c.set("memberRole", member.role);
    } else {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    enrichContextWithWorkspace(workspaceId);
  }
  await next();
});

// GET /api/workspaces/:workspaceId/dashboards - List dashboards as tree
app.get("/", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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

    return c.json({ success: true, myDashboards: [], workspaceDashboards: [] });
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
});

// POST /api/workspaces/:workspaceId/dashboards - Create dashboard
app.post("/", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const user = c.get("user");
    const userId = user?.id ?? "system";
    const body = await c.req.json();

    if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
      return c.json({ success: false, error: "title is required" }, 400);
    }

    if (body.dataSources && !Array.isArray(body.dataSources)) {
      return c.json(
        { success: false, error: "dataSources must be an array" },
        400,
      );
    }

    const normalizedDataSources = await normalizeDashboardDataSources(
      workspaceId,
      body.dataSources,
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

    const dashboard = new Dashboard({
      ...body,
      dataSources: normalizedDataSources.dataSources || [],
      workspaceId: new Types.ObjectId(workspaceId),
      createdBy: userId,
      owner_id: userId,
      materializationSchedule,
    });

    await dashboard.save();
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
});

// GET /api/workspaces/:workspaceId/dashboards/:id - Get dashboard by ID
app.get("/:id", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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
    const readOnly = !DashboardManager.canWrite(dashboard, userId, isAdmin);

    const plain = dashboard.toObject ? dashboard.toObject() : dashboard;
    normalizeDashboardWidgetLayouts(plain);

    return c.json({
      success: true,
      data: {
        ...sanitizeDashboardResponse(
          await hydrateDashboardArtifactUrls(plain as any),
        ),
        readOnly,
      },
    });
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
});

// PUT /api/workspaces/:workspaceId/dashboards/:id - Full update
app.put("/:id", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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
    if (!DashboardManager.canWrite(dashboard, userId, isAdmin)) {
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

    // Optimistic concurrency check
    const clientVersion =
      typeof body.version === "number" ? body.version : null;
    if (clientVersion !== null && dashboard.version !== clientVersion) {
      const plain = dashboard.toObject ? dashboard.toObject() : dashboard;
      normalizeDashboardWidgetLayouts(plain);
      return c.json(
        {
          success: false,
          error: "Dashboard was modified by another user",
          code: "VERSION_CONFLICT",
          serverVersion: dashboard.version,
          data: sanitizeDashboardResponse(
            await hydrateDashboardArtifactUrls(plain as any),
          ),
        },
        409,
      );
    }

    const previousDataSources = dashboard.toObject().dataSources || [];

    if (body.title !== undefined) {
      dashboard.title = body.title;
    }
    if (body.description !== undefined) {
      dashboard.description = body.description;
    }
    if (body.dataSources !== undefined) {
      const normalizedDataSources = await normalizeDashboardDataSources(
        workspaceId,
        body.dataSources,
      );
      if (!normalizedDataSources.success) {
        return c.json(
          { success: false, error: normalizedDataSources.error },
          400,
        );
      }
      dashboard.dataSources = normalizedDataSources.dataSources || [];
    }
    if (body.widgets !== undefined) {
      dashboard.widgets = body.widgets;
    }
    if (body.relationships !== undefined) {
      dashboard.relationships = body.relationships;
    }
    if (body.globalFilters !== undefined) {
      dashboard.globalFilters = body.globalFilters;
    }
    if (body.layout !== undefined) {
      dashboard.layout = body.layout;
    }
    if (body.crossFilter !== undefined) {
      dashboard.crossFilter = body.crossFilter;
    }
    if (body.materializationSchedule !== undefined) {
      try {
        dashboard.materializationSchedule =
          validateDashboardMaterializationSchedule(
            body.materializationSchedule,
          ) as any;
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
    if (body.cache !== undefined) {
      dashboard.cache = body.cache;
    }
    if (body.access !== undefined) {
      dashboard.access = body.access;
    }

    dashboard.version = (dashboard.version || 1) + 1;
    await dashboard.save();
    if (
      didDashboardArtifactInputsChange(
        previousDataSources as any[],
        (dashboard.toObject().dataSources || []) as any[],
      ) &&
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
    logger.error("Error updating dashboard", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// PATCH /api/workspaces/:workspaceId/dashboards/:id - Partial update (widget mutations, layout changes)
app.patch("/:id", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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
    if (!DashboardManager.canWrite(existing, userId, isAdmin)) {
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

    const validation = DashboardDefinitionSchema.partial().safeParse(body);
    if (!validation.success) {
      return c.json(
        {
          success: false,
          error: "Invalid dashboard definition",
          issues: validation.error.issues.map(
            (i: { path: PropertyKey[]; message: string }) => ({
              path: i.path.join("."),
              message: i.message,
            }),
          ),
        },
        400,
      );
    }
    const validatedBody = validation.data as Record<string, unknown>;

    if (validatedBody.dataSources !== undefined) {
      const normalizedDataSources = await normalizeDashboardDataSources(
        workspaceId,
        validatedBody.dataSources as any[],
      );
      if (!normalizedDataSources.success) {
        return c.json(
          { success: false, error: normalizedDataSources.error },
          400,
        );
      }
      validatedBody.dataSources = normalizedDataSources.dataSources;
    }
    if (validatedBody.materializationSchedule !== undefined) {
      try {
        validatedBody.materializationSchedule =
          validateDashboardMaterializationSchedule(
            validatedBody.materializationSchedule as Record<string, unknown>,
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

    if (
      didDashboardArtifactInputsChange(
        previousDataSources as any[],
        (dashboard.toObject().dataSources || []) as any[],
      ) &&
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
    logger.error("Error patching dashboard", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

app.post("/:id/refresh", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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
});

// DELETE /api/workspaces/:workspaceId/dashboards/:id - Delete dashboard
app.delete("/:id", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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
    if (!DashboardManager.canWrite(dashboard, userId, isAdmin)) {
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

    return c.json({ success: true, message: "Dashboard deleted successfully" });
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
});

// POST /api/workspaces/:workspaceId/dashboards/:id/duplicate - Duplicate dashboard
app.post("/:id/duplicate", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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
});

// ── Edit lock endpoints ──

const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

// POST /api/workspaces/:workspaceId/dashboards/:id/lock - Acquire edit lock
app.post("/:id/lock", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    const userId = c.get("user")?.id;
    if (!userId) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    const user = await User.findById(userId).lean();
    const userName = user?.email || userId;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

    const dashboard = await Dashboard.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
        $or: [
          { editLock: null },
          { "editLock.userId": { $exists: false } },
          { "editLock.expiresAt": { $lt: now } },
          { "editLock.userId": userId },
        ],
      },
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
      { new: true },
    );

    if (!dashboard) {
      const existing = await Dashboard.findOne({
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      });
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

    const plain = dashboard.toObject ? dashboard.toObject() : dashboard;
    normalizeDashboardWidgetLayouts(plain);

    return c.json({
      success: true,
      data: sanitizeDashboardResponse(
        await hydrateDashboardArtifactUrls(plain as any),
      ),
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
});

// POST /api/workspaces/:workspaceId/dashboards/:id/lock/heartbeat - Extend lock
app.post("/:id/lock/heartbeat", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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
});

// DELETE /api/workspaces/:workspaceId/dashboards/:id/lock - Release lock
app.delete("/:id/lock", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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
});

// ── Folder endpoints ──

// POST /api/workspaces/:workspaceId/dashboards/folders - Create folder
app.post("/folders", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const userId = c.get("user")?.id;
    if (!userId) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    const body = await c.req.json();
    const { name, parentId, access } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return c.json({ success: false, error: "Folder name is required" }, 400);
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
});

// PATCH /api/workspaces/:workspaceId/dashboards/folders/:id/rename
app.patch("/folders/:id/rename", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const folderId = c.req.param("id");
    const userId = c.get("user")?.id;
    if (!userId) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    const body = await c.req.json();
    const { name } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return c.json({ success: false, error: "Folder name is required" }, 400);
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
});

// DELETE /api/workspaces/:workspaceId/dashboards/folders/:id
app.delete("/folders/:id", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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

    const descendantIds = await collectFolderIds(new Types.ObjectId(folderId));
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
});

// PATCH /api/workspaces/:workspaceId/dashboards/folders/:id/move
app.patch("/folders/:id/move", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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
});

// PATCH /api/workspaces/:workspaceId/dashboards/:id/move - Move dashboard to folder
app.patch("/:id/move", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
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
    if (!DashboardManager.canWrite(dashboard, userId, isAdmin)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    if (folderId !== undefined) {
      dashboard.folderId = folderId ? new Types.ObjectId(folderId) : undefined;
    }
    if (access !== undefined) {
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
});

export const dashboardRoutes = app;
