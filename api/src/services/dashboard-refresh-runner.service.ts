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

  const STALE_THRESHOLD_MS = 3 * 60 * 1000;
  const now = Date.now();
  const genuinelyActiveRuns = activeRuns.filter(run => {
    const heartbeat = run.lastHeartbeat
      ? new Date(run.lastHeartbeat).getTime()
      : 0;
    const requested = new Date(run.requestedAt).getTime();
    const latestSignal = Math.max(heartbeat, requested);
    return now - latestSignal < STALE_THRESHOLD_MS;
  });

  if (genuinelyActiveRuns.length > 0) {
    logger.info("Skipping duplicate dashboard artifact refresh", {
      dashboardId: input.dashboardId,
      dataSourceIds,
      activeRunIds: genuinelyActiveRuns.map(run => run.runId),
    });

    return {
      queued: false,
      dataSourceIds,
      activeRunIds: genuinelyActiveRuns.map(run => run.runId),
    };
  }

  if (activeRuns.length > genuinelyActiveRuns.length) {
    const staleRunIds = activeRuns
      .filter(run => !genuinelyActiveRuns.includes(run))
      .map(run => run.runId);
    logger.info("Abandoning stale materialization runs before requeueing", {
      dashboardId: input.dashboardId,
      staleRunIds,
    });
    await Promise.all(
      staleRunIds.map(runId =>
        finalizeMaterializationRun({
          runId,
          status: "abandoned",
          finishedAt: new Date(),
          error: "Stale run abandoned on new materialization request",
        }),
      ),
    );
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
      const refreshedGenuine = refreshedActiveRuns.filter(run => {
        const heartbeat = run.lastHeartbeat
          ? new Date(run.lastHeartbeat).getTime()
          : 0;
        const requested = new Date(run.requestedAt).getTime();
        return now - Math.max(heartbeat, requested) < STALE_THRESHOLD_MS;
      });

      if (refreshedGenuine.length > 0) {
        logger.info("Dashboard materialization already in progress", {
          dashboardId: input.dashboardId,
          dataSourceIds,
          activeRunIds: refreshedGenuine.map(run => run.runId),
        });

        return {
          queued: false,
          dataSourceIds,
          activeRunIds: refreshedGenuine.map(run => run.runId),
        };
      }

      logger.info("Resetting stuck dashboard build status", {
        dashboardId: input.dashboardId,
        dataSourceIds,
      });
      await Promise.all(
        refreshedActiveRuns.map(run =>
          finalizeMaterializationRun({
            runId: run.runId,
            status: "abandoned",
            finishedAt: new Date(),
            error: "Stale run abandoned on new materialization request",
          }),
        ),
      );
      await Dashboard.findByIdAndUpdate(dashboard._id, {
        $set: updates,
      });
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
