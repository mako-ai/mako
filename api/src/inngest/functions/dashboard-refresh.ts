import { inngest } from "../client";
import { Dashboard } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { rebuildDashboardArtifacts } from "../../services/dashboard-artifact-rebuild.service";

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
    const { dashboardId, dataSourceIds, force } = event.data as {
      dashboardId: string;
      dataSourceIds?: string[];
      force?: boolean;
    };

    const dashboard = (await step.run("fetch-dashboard", async () => {
      const doc = await Dashboard.findById(dashboardId);
      if (!doc) throw new Error(`Dashboard not found: ${dashboardId}`);
      return doc.toObject();
    })) as any;

    logger.info("Refreshing dashboard data sources", {
      dashboardId,
      dataSourceCount: dashboard.dataSources.length,
    });

    const rebuild = await step.run("rebuild-dashboard-artifacts", async () => {
      return await rebuildDashboardArtifacts({
        dashboardId,
        dataSourceIds,
        force,
      });
    });

    logger.info("Dashboard refresh complete", {
      dashboardId,
      results: rebuild.results.map(r => ({
        dataSourceId: r.dataSourceId,
        success: r.success,
        rowCount: r.rowCount,
      })),
    });

    return { success: true, results: rebuild.results };
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
