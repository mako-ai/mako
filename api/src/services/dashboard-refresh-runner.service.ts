import { Dashboard } from "../database/workspace-schema";
import { loggers } from "../logging";
import { inngest } from "../inngest/client";
import { rebuildDashboardArtifacts } from "./dashboard-artifact-rebuild.service";
import { isDashboardMaterializationDue } from "./dashboard-materialization-schedule.service";

const logger = loggers.api("dashboard-refresh-runner");

export type DashboardRefreshRunner = "none" | "inngest" | "poller";
export type DashboardRefreshTriggerType =
  | "manual"
  | "schedule"
  | "dashboard_update";

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
  triggerType?: DashboardRefreshTriggerType;
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
  triggerType?: DashboardRefreshTriggerType;
}) {
  return await rebuildDashboardArtifacts(input);
}

export function startDashboardRefreshPoller(): void {
  if (pollerStarted || getDashboardRefreshRunner() !== "poller") {
    return;
  }

  pollerStarted = true;
  const intervalMs = Number(
    process.env.DASHBOARD_REFRESH_INTERVAL_MS || 60 * 1000,
  );

  setInterval(() => {
    void (async () => {
      const dashboards = await Dashboard.find({
        "materializationSchedule.enabled": true,
        "materializationSchedule.cron": { $type: "string", $ne: "" },
      }).select("_id cache dataSources materializationSchedule");

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
          await rebuildDashboardArtifacts({
            dashboardId: dashboard._id.toString(),
            triggerType: "schedule",
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
