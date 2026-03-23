import { loggers } from "../logging";
import { inngest } from "../inngest/client";

const logger = loggers.api("dashboard-refresh-runner");

export type DashboardRefreshTriggerType =
  | "manual"
  | "schedule"
  | "dashboard_update";

export async function queueDashboardArtifactRefresh(input: {
  dashboardId: string;
  workspaceId?: string;
  dataSourceIds?: string[];
  force?: boolean;
  triggerType?: DashboardRefreshTriggerType;
}): Promise<void> {
  logger.info("Queuing dashboard artifact refresh via Inngest", {
    dashboardId: input.dashboardId,
    dataSourceIds: input.dataSourceIds,
    force: input.force,
    triggerType: input.triggerType,
  });
  await inngest.send({
    name: "dashboard.refresh",
    data: input,
  });
}
