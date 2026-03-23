import { loggers } from "../logging";
import { inngest } from "../inngest/client";
import crypto from "crypto";
import { Dashboard } from "../database/workspace-schema";
import {
  createMaterializationRun,
  finalizeMaterializationRun,
  listActiveMaterializationRuns,
} from "./dashboard-materialization-run.service";

const logger = loggers.api("dashboard-refresh-runner");

export type DashboardRefreshTriggerType =
  | "manual"
  | "schedule"
  | "dashboard_update";

export interface QueueDashboardArtifactRefreshResult {
  queued: boolean;
  dataSourceIds: string[];
  queuedRunIdsByDataSourceId?: Record<string, string>;
  activeRunIds?: string[];
}

export async function queueDashboardArtifactRefresh(input: {
  dashboardId: string;
  workspaceId?: string;
  dataSourceIds?: string[];
  force?: boolean;
  triggerType?: DashboardRefreshTriggerType;
}): Promise<QueueDashboardArtifactRefreshResult> {
  const dashboard = await Dashboard.findById(input.dashboardId);
  if (!dashboard) {
    throw new Error(`Dashboard not found: ${input.dashboardId}`);
  }

  const workspaceId = dashboard.workspaceId.toString();
  if (input.workspaceId && input.workspaceId !== workspaceId) {
    throw new Error(
      `Dashboard ${input.dashboardId} does not belong to workspace ${input.workspaceId}`,
    );
  }

  const requestedIds =
    input.dataSourceIds?.length && dashboard.dataSources.length > 0
      ? input.dataSourceIds
      : dashboard.dataSources.map(dataSource => dataSource.id);
  const dataSourceIds = requestedIds.filter(dataSourceId =>
    dashboard.dataSources.some(dataSource => dataSource.id === dataSourceId),
  );

  if (dataSourceIds.length === 0) {
    return {
      queued: false,
      dataSourceIds: [],
    };
  }

  const activeRuns = await listActiveMaterializationRuns({
    workspaceId,
    dashboardId: dashboard._id.toString(),
    dataSourceIds,
  });

  if (activeRuns.length > 0) {
    logger.info("Skipping duplicate dashboard artifact refresh", {
      dashboardId: input.dashboardId,
      dataSourceIds,
      activeRunIds: activeRuns.map(run => run.runId),
    });

    return {
      queued: false,
      dataSourceIds,
      activeRunIds: activeRuns.map(run => run.runId),
    };
  }

  const updates: Record<string, unknown> = {};
  dashboard.dataSources.forEach((dataSource, index) => {
    if (!dataSourceIds.includes(dataSource.id)) {
      return;
    }

    updates[`dataSources.${index}.cache.parquetBuildStatus`] = "building";
    updates[`dataSources.${index}.cache.parquetLastError`] = null;
  });

  if (Object.keys(updates).length > 0) {
    const lockFilter = {
      _id: dashboard._id,
      $nor: dataSourceIds.map(dataSourceId => ({
        dataSources: {
          $elemMatch: {
            id: dataSourceId,
            "cache.parquetBuildStatus": "building",
          },
        },
      })),
    };
    const lockAcquired = await Dashboard.findOneAndUpdate(
      lockFilter,
      {
        $set: updates,
      },
      { new: false },
    );

    if (!lockAcquired) {
      const refreshedActiveRuns = await listActiveMaterializationRuns({
        workspaceId,
        dashboardId: dashboard._id.toString(),
        dataSourceIds,
      });

      logger.info("Dashboard materialization already in progress", {
        dashboardId: input.dashboardId,
        dataSourceIds,
        activeRunIds: refreshedActiveRuns.map(run => run.runId),
      });

      return {
        queued: false,
        dataSourceIds,
        activeRunIds: refreshedActiveRuns.map(run => run.runId),
      };
    }
  }

  const requestedAt = new Date();
  const queuedRunIdsByDataSourceId: Record<string, string> = {};

  for (const dataSourceId of dataSourceIds) {
    const runId = crypto.randomUUID();
    queuedRunIdsByDataSourceId[dataSourceId] = runId;

    await createMaterializationRun({
      workspaceId,
      dashboardId: dashboard._id.toString(),
      dataSourceId,
      runId,
      triggerType: input.triggerType || "dashboard_update",
      status: "queued",
      requestedAt,
      events: [
        {
          type: "materialization_requested",
          timestamp: requestedAt,
          message: "Materialization requested",
        },
      ],
    });
  }

  logger.info("Queuing dashboard artifact refresh via Inngest", {
    dashboardId: input.dashboardId,
    dataSourceIds,
    force: input.force,
    triggerType: input.triggerType,
  });

  try {
    await inngest.send({
      name: "dashboard.refresh",
      data: {
        ...input,
        workspaceId,
        dataSourceIds,
        queuedRunIdsByDataSourceId,
      },
    });
  } catch (error) {
    await Promise.all(
      Object.values(queuedRunIdsByDataSourceId).map(runId =>
        finalizeMaterializationRun({
          runId,
          status: "error",
          finishedAt: new Date(),
          error: "Failed to enqueue dashboard refresh",
        }),
      ),
    );
    await Dashboard.findByIdAndUpdate(dashboard._id, {
      $set: Object.fromEntries(
        dashboard.dataSources.flatMap((dataSource, index) =>
          dataSourceIds.includes(dataSource.id)
            ? ([
                [`dataSources.${index}.cache.parquetBuildStatus`, "error"],
                [
                  `dataSources.${index}.cache.parquetLastError`,
                  "Failed to enqueue dashboard refresh",
                ],
              ] as Array<[string, unknown]>)
            : [],
        ),
      ),
    }).catch(() => undefined);

    throw error;
  }

  return {
    queued: true,
    dataSourceIds,
    queuedRunIdsByDataSourceId,
  };
}
