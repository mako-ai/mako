import { Hono } from "hono";
import { Dashboard, DatabaseConnection } from "../database/workspace-schema";
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
  queueDashboardArtifactRefresh,
  refreshDashboardArtifactsNow,
} from "../services/dashboard-refresh-runner.service";

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
          materializationMode: ds.materializationMode,
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

// GET /api/workspaces/:workspaceId/dashboards - List dashboards for workspace
app.get("/", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const userId = c.get("user")?.id;

    const dashboards = await Dashboard.find({
      workspaceId: new Types.ObjectId(workspaceId),
      $or: [{ access: "workspace" }, { access: "private", createdBy: userId }],
    })
      .sort({ updatedAt: -1 })
      .lean();

    const normalizedDashboards = dashboards.map(d =>
      normalizeDashboardWidgetLayouts(d),
    );
    const hydratedDashboards = await Promise.all(
      normalizedDashboards.map(dashboard =>
        hydrateDashboardArtifactUrls(dashboard as any),
      ),
    );
    return c.json({ success: true, data: hydratedDashboards });
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

    const dashboard = new Dashboard({
      ...body,
      dataSources: normalizedDataSources.dataSources || [],
      workspaceId: new Types.ObjectId(workspaceId),
      createdBy: userId,
      materializationMode: body.materializationMode || "auto",
    });

    await dashboard.save();
    if ((dashboard.dataSources || []).length > 0) {
      await queueDashboardArtifactRefresh({
        dashboardId: dashboard._id.toString(),
      }).catch(() => undefined);
    }

    return c.json({
      success: true,
      data: await hydrateDashboardArtifactUrls(dashboard.toObject() as any),
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
    if (dashboard.access === "private" && dashboard.createdBy !== userId) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const plain = dashboard.toObject ? dashboard.toObject() : dashboard;
    normalizeDashboardWidgetLayouts(plain);

    return c.json({
      success: true,
      data: await hydrateDashboardArtifactUrls(plain as any),
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
    if (dashboard.access === "private" && dashboard.createdBy !== userId) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    if (dashboard.access === "workspace" && dashboard.createdBy !== userId) {
      const memberRole = c.get("memberRole");
      if (memberRole !== "owner" && memberRole !== "admin") {
        return c.json(
          {
            success: false,
            error: "Only the owner or admins can edit this dashboard",
          },
          403,
        );
      }
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
    if (body.materializationMode !== undefined) {
      dashboard.materializationMode = body.materializationMode;
    }
    if (body.cache !== undefined) {
      dashboard.cache = body.cache;
    }
    if (body.access !== undefined) {
      dashboard.access = body.access;
    }

    await dashboard.save();
    if (
      didDashboardArtifactInputsChange(
        previousDataSources as any[],
        (dashboard.toObject().dataSources || []) as any[],
      )
    ) {
      await queueDashboardArtifactRefresh({
        dashboardId: dashboard._id.toString(),
      }).catch(() => undefined);
    }

    return c.json({
      success: true,
      data: await hydrateDashboardArtifactUrls(dashboard.toObject() as any),
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
    if (existing.access === "private" && existing.createdBy !== userId) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    if (existing.access === "workspace" && existing.createdBy !== userId) {
      const memberRole = c.get("memberRole");
      if (memberRole !== "owner" && memberRole !== "admin") {
        return c.json(
          {
            success: false,
            error: "Only the owner or admins can edit this dashboard",
          },
          403,
        );
      }
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

    const previousDataSources = existing.toObject().dataSources || [];

    const dashboard = await Dashboard.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      },
      { $set: validatedBody },
      { new: true, runValidators: true },
    );

    if (
      dashboard &&
      didDashboardArtifactInputsChange(
        previousDataSources as any[],
        (dashboard.toObject().dataSources || []) as any[],
      )
    ) {
      await queueDashboardArtifactRefresh({
        dashboardId: dashboard._id.toString(),
      }).catch(() => undefined);
    }

    return c.json({
      success: true,
      data: dashboard
        ? await hydrateDashboardArtifactUrls(dashboard.toObject() as any)
        : dashboard,
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
    const body = await c.req.json().catch(() => ({}));
    const blocking = body?.blocking === true;

    const dashboard = await Dashboard.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!dashboard) {
      return c.json({ success: false, error: "Dashboard not found" }, 404);
    }

    if (blocking) {
      const result = await refreshDashboardArtifactsNow({
        dashboardId: dashboard._id.toString(),
        force: true,
      });
      return c.json({ success: true, data: result });
    }

    await queueDashboardArtifactRefresh({
      dashboardId: dashboard._id.toString(),
      force: true,
    });

    return c.json({ success: true, queued: true });
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
app.delete("/:id", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");

    const result = await Dashboard.deleteOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (result.deletedCount === 0) {
      return c.json({ success: false, error: "Dashboard not found" }, 404);
    }

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

    const spec: any = dashboard.toObject();
    delete spec._id;
    delete spec.__v;
    spec.title = `${spec.title} (copy)`;
    spec.createdBy = userId;

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
    if ((duplicate.dataSources || []).length > 0) {
      await queueDashboardArtifactRefresh({
        dashboardId: duplicate._id.toString(),
      }).catch(() => undefined);
    }

    return c.json({
      success: true,
      data: await hydrateDashboardArtifactUrls(duplicate.toObject() as any),
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

export const dashboardRoutes = app;
