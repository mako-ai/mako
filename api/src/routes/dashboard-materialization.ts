import fs, { promises as fsPromises } from "fs";
import { Hono } from "hono";
import { Types } from "mongoose";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { workspaceService } from "../services/workspace.service";
import {
  buildDashboardMaterializationStatus,
  getDashboardForMaterialization,
  getDataSourceOrThrow,
  buildDataSourceMaterializationStatus,
} from "../services/dashboard-materialization.service";
import {
  getMaterializationRunByRunId,
  listMaterializationRuns,
} from "../services/dashboard-materialization-run.service";
import { queueDashboardArtifactRefresh } from "../services/dashboard-refresh-runner.service";
import {
  getDashboardArtifactStore,
  getDashboardArtifactStoreType,
  getFilesystemArtifactPath,
} from "../services/dashboard-artifact-store.service";

const logger = loggers.api("dashboard-materialization");
const app = new Hono();

function parseRangeHeader(rangeHeader: string, size: number) {
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) return null;
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || end >= size) return null;
  return { start, end };
}

app.use("*", unifiedAuthMiddleware);

app.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    return await next();
  }

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
        { success: false, error: "API key not authorized for this workspace" },
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
  await next();
});

async function getScopedDashboardOrResponse(c: AuthenticatedContext) {
  const workspaceId = c.req.param("workspaceId");
  const dashboardId = c.req.param("dashboardId");
  const dashboard = await getDashboardForMaterialization({
    workspaceId,
    dashboardId,
  });
  if (!dashboard) {
    return c.json({ success: false, error: "Dashboard not found" }, 404);
  }

  const userId = c.get("user")?.id;
  if (dashboard.access === "private" && dashboard.createdBy !== userId) {
    return c.json({ success: false, error: "Access denied" }, 403);
  }

  return dashboard;
}

app.get("/materialization", async (c: AuthenticatedContext) => {
  try {
    const dashboard = await getScopedDashboardOrResponse(c);
    if (dashboard instanceof Response) {
      return dashboard;
    }

    return c.json({
      success: true,
      data: await buildDashboardMaterializationStatus(dashboard),
    });
  } catch (error) {
    logger.error("Failed to get dashboard materialization status", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get materialization status",
      },
      500,
    );
  }
});

app.post("/materialize", async (c: AuthenticatedContext) => {
  try {
    const dashboard = await getScopedDashboardOrResponse(c);
    if (dashboard instanceof Response) {
      return dashboard;
    }

    const body = await c.req.json().catch(() => ({}));
    const force = body?.force === true;
    const dataSourceIds = Array.isArray(body?.dataSourceIds)
      ? body.dataSourceIds.filter((value: unknown) => typeof value === "string")
      : undefined;

    const queueResult = await queueDashboardArtifactRefresh({
      dashboardId: dashboard._id.toString(),
      workspaceId: dashboard.workspaceId.toString(),
      dataSourceIds,
      force,
      triggerType: "manual",
    });
    return c.json({
      success: true,
      queued: queueResult.queued,
      alreadyRunning: !queueResult.queued,
      dataSourceIds: queueResult.dataSourceIds,
      activeRunIds: queueResult.activeRunIds || [],
    });
  } catch (error) {
    logger.error("Failed to materialize dashboard", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to materialize dashboard",
      },
      500,
    );
  }
});

app.get(
  "/data-sources/:dataSourceId/materialization",
  async (c: AuthenticatedContext) => {
    try {
      const dashboard = await getScopedDashboardOrResponse(c);
      if (dashboard instanceof Response) {
        return dashboard;
      }

      const dataSource = getDataSourceOrThrow(
        dashboard,
        c.req.param("dataSourceId"),
      );
      return c.json({
        success: true,
        data: await buildDataSourceMaterializationStatus({
          workspaceId: dashboard.workspaceId.toString(),
          dashboardId: dashboard._id.toString(),
          dataSource,
        }),
      });
    } catch (error) {
      logger.error("Failed to get datasource materialization status", {
        error,
      });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to get data source materialization status",
        },
        500,
      );
    }
  },
);

app.post(
  "/data-sources/:dataSourceId/materialize",
  async (c: AuthenticatedContext) => {
    try {
      const dashboard = await getScopedDashboardOrResponse(c);
      if (dashboard instanceof Response) {
        return dashboard;
      }

      const dataSourceId = c.req.param("dataSourceId");
      getDataSourceOrThrow(dashboard, dataSourceId);
      const body = await c.req.json().catch(() => ({}));
      const force = body?.force === true;

      const queueResult = await queueDashboardArtifactRefresh({
        dashboardId: dashboard._id.toString(),
        workspaceId: dashboard.workspaceId.toString(),
        dataSourceIds: [dataSourceId],
        force,
        triggerType: "manual",
      });
      return c.json({
        success: true,
        queued: queueResult.queued,
        alreadyRunning: !queueResult.queued,
        dataSourceId,
        activeRunIds: queueResult.activeRunIds || [],
      });
    } catch (error) {
      logger.error("Failed to materialize dashboard data source", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to materialize dashboard data source",
        },
        500,
      );
    }
  },
);

app.get("/materialization/runs", async (c: AuthenticatedContext) => {
  try {
    const dashboard = await getScopedDashboardOrResponse(c);
    if (dashboard instanceof Response) {
      return dashboard;
    }

    const limit = Number(c.req.query("limit") || 100);
    return c.json({
      success: true,
      data: await listMaterializationRuns({
        workspaceId: dashboard.workspaceId.toString(),
        dashboardId: dashboard._id.toString(),
        limit: Number.isFinite(limit) ? limit : 100,
      }),
    });
  } catch (error) {
    logger.error("Failed to get materialization runs", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get materialization runs",
      },
      500,
    );
  }
});

app.get("/materialization/runs/:runId", async (c: AuthenticatedContext) => {
  try {
    const dashboard = await getScopedDashboardOrResponse(c);
    if (dashboard instanceof Response) {
      return dashboard;
    }

    const run = await getMaterializationRunByRunId({
      workspaceId: dashboard.workspaceId.toString(),
      dashboardId: dashboard._id.toString(),
      runId: c.req.param("runId"),
    });

    if (!run) {
      return c.json(
        { success: false, error: "Materialization run not found" },
        404,
      );
    }

    return c.json({ success: true, data: run });
  } catch (error) {
    logger.error("Failed to get materialization run", { error });
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to get materialization run",
      },
      500,
    );
  }
});

app.get(
  "/data-sources/:dataSourceId/materialization/runs",
  async (c: AuthenticatedContext) => {
    try {
      const dashboard = await getScopedDashboardOrResponse(c);
      if (dashboard instanceof Response) {
        return dashboard;
      }

      const dataSourceId = c.req.param("dataSourceId");
      getDataSourceOrThrow(dashboard, dataSourceId);
      const limit = Number(c.req.query("limit") || 100);

      return c.json({
        success: true,
        data: await listMaterializationRuns({
          workspaceId: dashboard.workspaceId.toString(),
          dashboardId: dashboard._id.toString(),
          dataSourceId,
          limit: Number.isFinite(limit) ? limit : 100,
        }),
      });
    } catch (error) {
      logger.error("Failed to get data source materialization runs", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to get data source materialization runs",
        },
        500,
      );
    }
  },
);

app.get(
  "/data-sources/:dataSourceId/materialization/artifact",
  async (c: AuthenticatedContext) => {
    try {
      const dashboard = await getScopedDashboardOrResponse(c);
      if (dashboard instanceof Response) {
        return dashboard;
      }

      const dataSource = getDataSourceOrThrow(
        dashboard,
        c.req.param("dataSourceId"),
      );
      const status = await buildDataSourceMaterializationStatus({
        workspaceId: dashboard.workspaceId.toString(),
        dashboardId: dashboard._id.toString(),
        dataSource,
      });

      if (!status.artifactKey) {
        return c.json({ success: false, error: "Artifact not found" }, 404);
      }

      const store = getDashboardArtifactStore();
      if (getDashboardArtifactStoreType() === "filesystem") {
        const filePath = getFilesystemArtifactPath(status.artifactKey);
        let stat;
        try {
          stat = await fsPromises.stat(filePath);
        } catch {
          return c.json({ success: false, error: "Artifact not found" }, 404);
        }

        const rangeHeader = c.req.header("range");
        const headers: Record<string, string> = {
          "Content-Type": "application/vnd.apache.parquet",
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=300",
        };

        if (!rangeHeader) {
          headers["Content-Length"] = String(stat.size);
          headers["X-Row-Count"] = String(status.rowCount || "");
          const stream = await store.openReadStream(status.artifactKey);
          return c.body(
            (stream || fs.createReadStream(filePath)) as any,
            200,
            headers,
          );
        }

        const range = parseRangeHeader(rangeHeader, stat.size);
        if (!range) {
          return c.text("Invalid range", 416);
        }

        headers["Content-Range"] =
          `bytes ${range.start}-${range.end}/${stat.size}`;
        headers["Content-Length"] = String(range.end - range.start + 1);
        headers["X-Row-Count"] = String(status.rowCount || "");
        return c.body(
          fs.createReadStream(filePath, {
            start: range.start,
            end: range.end,
          }) as any,
          206,
          headers,
        );
      }

      const signedUrl = await store.getSignedUrl(status.artifactKey, 3600);
      if (!signedUrl) {
        return c.json({ success: false, error: "Artifact not available" }, 404);
      }

      return c.redirect(signedUrl, 302);
    } catch (error) {
      logger.error("Failed to stream materialized artifact", { error });
      return c.json(
        {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Failed to stream materialized artifact",
        },
        500,
      );
    }
  },
);

export const dashboardMaterializationRoutes = app;
