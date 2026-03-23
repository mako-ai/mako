import { Dashboard } from "../database/workspace-schema";
import { loggers } from "../logging";
import { inngest } from "../inngest/client";
import { rebuildDashboardArtifacts } from "./dashboard-artifact-rebuild.service";

const logger = loggers.api("dashboard-refresh-runner");

export type DashboardRefreshRunner = "none" | "inngest" | "poller";

let pollerStarted = false;

export function getDashboardRefreshRunner(): DashboardRefreshRunner {
  const raw = process.env.DASHBOARD_REFRESH_RUNNER;
  if (raw === "inngest" || raw === "poller") {
    return raw;
  }
  return "none";
}

export async function queueDashboardArtifactRefresh(input: {
  dashboardId: string;
  workspaceId?: string;
  dataSourceIds?: string[];
  force?: boolean;
}): Promise<void> {
  const runner = getDashboardRefreshRunner();
  if (runner === "inngest") {
    await inngest.send({
      name: "dashboard.refresh",
      data: input,
    });
    return;
  }

  setTimeout(() => {
    void rebuildDashboardArtifacts(input).catch(error => {
      logger.error("Async dashboard refresh failed", {
        error,
        dashboardId: input.dashboardId,
        runner,
      });
    });
  }, 0);
}

export async function refreshDashboardArtifactsNow(input: {
  dashboardId: string;
  workspaceId?: string;
  dataSourceIds?: string[];
  force?: boolean;
}) {
  return await rebuildDashboardArtifacts(input);
}

export function startDashboardRefreshPoller(): void {
  if (pollerStarted || getDashboardRefreshRunner() !== "poller") {
    return;
  }

  pollerStarted = true;
  const intervalMs = Number(
    process.env.DASHBOARD_REFRESH_INTERVAL_MS || 15 * 60 * 1000,
  );

  setInterval(() => {
    void (async () => {
      const dashboards = await Dashboard.find({
        "cache.ttlSeconds": { $gt: 0 },
      }).select("_id cache dataSources");

      for (const dashboard of dashboards) {
        const ttlMs = (dashboard.cache?.ttlSeconds || 3600) * 1000;
        const lastRefresh = dashboard.cache?.lastRefreshedAt;
        const isStale =
          !lastRefresh || Date.now() - new Date(lastRefresh).getTime() > ttlMs;

        if (isStale && dashboard.dataSources?.length > 0) {
          await rebuildDashboardArtifacts({
            dashboardId: dashboard._id.toString(),
          }).catch(error => {
            logger.error("Dashboard refresh poller rebuild failed", {
              error,
              dashboardId: dashboard._id.toString(),
            });
          });
        }
      }
    })().catch(error => {
      logger.error("Dashboard refresh poller tick failed", { error });
    });
  }, intervalMs);
}
