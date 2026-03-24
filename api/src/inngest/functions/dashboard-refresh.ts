import * as os from "os";
import { inngest } from "../client";
import { Dashboard } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { rebuildDashboardArtifacts } from "../../services/dashboard-artifact-rebuild.service";
import { isDashboardMaterializationDue } from "../../services/dashboard-materialization-schedule.service";
import {
  listActiveMaterializationRuns,
  markStaleRunsAbandoned,
  updateMaterializationRunHeartbeat,
} from "../../services/dashboard-materialization-run.service";

const logger = loggers.inngest();

const WORKER_ID = `inngest-${os.hostname()}-${process.pid}`;

export const dashboardRefreshFunction = inngest.createFunction(
  {
    id: "dashboard-refresh",
    name: "Refresh Dashboard Data Sources",
    concurrency: {
      limit: 1,
      key: "event.data.dashboardId",
    },
    retries: 2,
  },
  { event: "dashboard.refresh" },
  async ({ event, step }) => {
    const {
      dashboardId,
      dataSourceIds,
      force,
      triggerType,
      queuedRunIdsByDataSourceId,
    } = event.data as {
      dashboardId: string;
      dataSourceIds?: string[];
      queuedRunIdsByDataSourceId?: Record<string, string>;
      force?: boolean;
      triggerType?: "manual" | "schedule" | "dashboard_update";
    };

    const dashboard = (await step.run("fetch-dashboard", async () => {
      const doc = await Dashboard.findById(dashboardId);
      if (!doc) throw new Error(`Dashboard not found: ${dashboardId}`);
      return doc.toObject();
    })) as any;

    if (triggerType === "schedule" && dashboard.cache?.lastRefreshedAt) {
      const msSinceRefresh =
        Date.now() - new Date(dashboard.cache.lastRefreshedAt).getTime();
      const isDue = isDashboardMaterializationDue({
        schedule: dashboard.materializationSchedule,
        lastRefreshedAt: dashboard.cache.lastRefreshedAt,
      });
      if (!isDue && msSinceRefresh < 10 * 60 * 1000) {
        logger.info("Skipping stale scheduled refresh (already refreshed)", {
          dashboardId,
          msSinceRefresh,
        });
        return { success: true, skipped: true };
      }
    }

    const filteredDataSources = dashboard.dataSources.filter(
      (ds: any) => !dataSourceIds?.length || dataSourceIds.includes(ds.id),
    );

    logger.info("Refreshing dashboard data sources", {
      dashboardId,
      dataSourceCount: filteredDataSources.length,
      workerId: WORKER_ID,
    });

    const rebuild = await step.run("rebuild-dashboard-artifacts", async () => {
      return await rebuildDashboardArtifacts({
        dashboardId,
        dataSourceIds,
        queuedRunIdsByDataSourceId,
        force,
        triggerType,
        workerId: WORKER_ID,
        onProgress: async (runId: string, stage: string) => {
          await updateMaterializationRunHeartbeat({ runId, stage });
        },
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
  { cron: "* * * * *" },
  async ({ step }) => {
    const dashboards = (await step.run("find-stale-dashboards", async () => {
      return Dashboard.find({
        "materializationSchedule.enabled": true,
        "materializationSchedule.cron": { $type: "string", $ne: "" },
      }).select("_id cache dataSources materializationSchedule");
    })) as any[];

    let triggered = 0;

    for (const dashboard of dashboards) {
      let isDue = false;
      try {
        isDue = isDashboardMaterializationDue({
          schedule: dashboard.materializationSchedule,
          lastRefreshedAt: dashboard.cache?.lastRefreshedAt ?? null,
        });
      } catch (error) {
        logger.warn(
          "Skipping dashboard with invalid materialization schedule",
          {
            error,
            dashboardId: dashboard._id.toString(),
          },
        );
        continue;
      }

      if (isDue && dashboard.dataSources?.length > 0) {
        await Dashboard.findByIdAndUpdate(dashboard._id, {
          $set: { "cache.lastRefreshedAt": new Date() },
        });
        await step.sendEvent("trigger-refresh", {
          name: "dashboard.refresh",
          data: {
            dashboardId: dashboard._id.toString(),
            triggerType: "schedule",
            force: true,
          },
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

export const cleanupAbandonedMaterializationRunsFunction =
  inngest.createFunction(
    {
      id: "cleanup-abandoned-materialization-runs",
      name: "Cleanup Abandoned Materialization Runs",
    },
    { cron: "*/5 * * * *" },
    async ({ step }) => {
      const abandonedCount = await step.run(
        "mark-stale-runs-abandoned",
        async () => {
          const count = await markStaleRunsAbandoned({
            heartbeatTimeoutMs: 2 * 60 * 1000,
            queuedTimeoutMs: 5 * 60 * 1000,
          });
          return count;
        },
      );

      if (abandonedCount > 0) {
        logger.warn("Marked stale materialization runs as abandoned", {
          abandonedCount,
        });
      }

      const orphanedCount = await step.run(
        "fix-orphaned-building-status",
        async () => {
          const staleDashboards = await Dashboard.find({
            "dataSources.cache.parquetBuildStatus": {
              $in: ["building", "queued"],
            },
          }).select("_id workspaceId dataSources");

          let fixed = 0;

          for (const dashboard of staleDashboards) {
            const buildingDsIds = dashboard.dataSources
              .filter(
                ds =>
                  ds.cache?.parquetBuildStatus === "building" ||
                  ds.cache?.parquetBuildStatus === "queued",
              )
              .map(ds => ds.id);

            if (buildingDsIds.length === 0) continue;

            const activeRuns = await listActiveMaterializationRuns({
              workspaceId: dashboard.workspaceId.toString(),
              dashboardId: dashboard._id.toString(),
              dataSourceIds: buildingDsIds,
            });

            const coveredDsIds = new Set(activeRuns.map(r => r.dataSourceId));
            const orphanedDsIds = buildingDsIds.filter(
              id => !coveredDsIds.has(id),
            );

            if (orphanedDsIds.length === 0) continue;

            const updates: Record<string, unknown> = {};
            dashboard.dataSources.forEach((ds, index) => {
              if (orphanedDsIds.includes(ds.id)) {
                updates[`dataSources.${index}.cache.parquetBuildStatus`] =
                  "error";
                updates[`dataSources.${index}.cache.parquetLastError`] =
                  "Orphaned build status reset (no active materialization run found)";
              }
            });

            if (Object.keys(updates).length > 0) {
              await Dashboard.findByIdAndUpdate(dashboard._id, {
                $set: updates,
              }).catch(() => undefined);
              fixed += orphanedDsIds.length;
            }
          }

          return fixed;
        },
      );

      if (orphanedCount > 0) {
        logger.warn("Reset orphaned dashboard build statuses", {
          orphanedCount,
        });
      }

      return { abandonedCount, orphanedCount };
    },
  );
