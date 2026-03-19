import { inngest } from "../client";
import {
  Dashboard,
  SavedConsole,
  DatabaseConnection,
} from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { serializeToArrowIPC } from "../../utils/arrow-serializer";
import { loggers } from "../../logging";

const logger = loggers.inngest();

export const dashboardRefreshFunction = inngest.createFunction(
  {
    id: "dashboard-refresh",
    name: "Refresh Dashboard Data Sources",
    concurrency: {
      limit: 3,
      key: "event.data.dashboardId",
    },
    retries: 2,
  },
  { event: "dashboard.refresh" },
  async ({ event, step }) => {
    const { dashboardId } = event.data;

    const dashboard = (await step.run("fetch-dashboard", async () => {
      const doc = await Dashboard.findById(dashboardId);
      if (!doc) throw new Error(`Dashboard not found: ${dashboardId}`);
      return doc.toObject();
    })) as any;

    logger.info("Refreshing dashboard data sources", {
      dashboardId,
      dataSourceCount: dashboard.dataSources.length,
    });

    const results: Array<{
      dataSourceId: string;
      success: boolean;
      rowCount?: number;
      error?: string;
    }> = [];

    for (const ds of dashboard.dataSources) {
      const result = await step.run(`export-${ds.id}`, async () => {
        try {
          const savedConsole = await SavedConsole.findById(ds.consoleId);
          if (!savedConsole) {
            return {
              dataSourceId: ds.id,
              success: false,
              error: "Console not found",
            };
          }

          const database = await DatabaseConnection.findById(ds.connectionId);
          if (!database) {
            return {
              dataSourceId: ds.id,
              success: false,
              error: "Database connection not found",
            };
          }

          const queryResult = await databaseConnectionService.executeQuery(
            database,
            savedConsole.code,
            {
              databaseId: savedConsole.databaseId,
              databaseName: savedConsole.databaseName,
            },
          );

          if (!queryResult.success || !queryResult.data) {
            return {
              dataSourceId: ds.id,
              success: false,
              error: queryResult.error || "Query failed",
            };
          }

          const rows = Array.isArray(queryResult.data) ? queryResult.data : [];
          const limit = ds.rowLimit || 500000;
          const limitedRows = rows.slice(0, limit);

          const fields = (queryResult.fields || []).map((f: any) => ({
            name: f.name || f.columnName || String(f),
            type: f.type || f.dataType,
          }));

          if (fields.length === 0 && limitedRows.length > 0) {
            for (const key of Object.keys(limitedRows[0])) {
              fields.push({ name: key, type: undefined });
            }
          }

          const arrowBuffer = serializeToArrowIPC(limitedRows, fields, {
            limit,
          });

          return {
            dataSourceId: ds.id,
            success: true,
            rowCount: limitedRows.length,
            byteSize: arrowBuffer.byteLength,
          };
        } catch (error) {
          return {
            dataSourceId: ds.id,
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }
      });

      results.push(result as any);
    }

    await step.run("update-cache-metadata", async () => {
      const updates: Record<string, any> = {};
      for (const result of results) {
        if (result.success) {
          const dsIndex = dashboard.dataSources.findIndex(
            (ds: any) => ds.id === result.dataSourceId,
          );
          if (dsIndex !== -1) {
            updates[`dataSources.${dsIndex}.cache.lastRefreshedAt`] =
              new Date();
            updates[`dataSources.${dsIndex}.cache.rowCount`] = result.rowCount;
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        updates["cache.lastRefreshedAt"] = new Date();
        await Dashboard.findByIdAndUpdate(dashboardId, { $set: updates });
      }
    });

    logger.info("Dashboard refresh complete", {
      dashboardId,
      results: results.map(r => ({
        dataSourceId: r.dataSourceId,
        success: r.success,
        rowCount: r.rowCount,
      })),
    });

    return { success: true, results };
  },
);

export const dashboardSchedulerFunction = inngest.createFunction(
  {
    id: "scheduled-dashboard-refresh",
    name: "Scheduled Dashboard Refresh",
  },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    const dashboards = (await step.run("find-stale-dashboards", async () => {
      return Dashboard.find({
        "cache.ttlSeconds": { $gt: 0 },
      }).select("_id cache dataSources");
    })) as any[];

    let triggered = 0;

    for (const dashboard of dashboards) {
      const ttlMs = (dashboard.cache?.ttlSeconds || 3600) * 1000;
      const lastRefresh = dashboard.cache?.lastRefreshedAt;
      const isStale =
        !lastRefresh || Date.now() - new Date(lastRefresh).getTime() > ttlMs;

      if (isStale && dashboard.dataSources?.length > 0) {
        await step.sendEvent("trigger-refresh", {
          name: "dashboard.refresh",
          data: { dashboardId: dashboard._id.toString() },
        });
        triggered++;
      }
    }

    logger.info("Dashboard scheduler run", {
      total: dashboards.length,
      triggered,
    });

    return { total: dashboards.length, triggered };
  },
);
