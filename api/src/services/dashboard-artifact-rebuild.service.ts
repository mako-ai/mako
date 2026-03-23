import { promises as fsPromises } from "fs";
import crypto from "crypto";
import { Types } from "mongoose";
import { Dashboard, DatabaseConnection } from "../database/workspace-schema";
import { loggers } from "../logging";
import { databaseConnectionService } from "./database-connection.service";
import {
  artifactExists,
  buildDashboardArtifactKey,
  storeArtifact,
  withArtifactBuildLock,
} from "./dashboard-cache.service";
import { writeParquetTempFile } from "../utils/parquet-serializer";
import { generateSnapshotsForDataSource } from "./dashboard-snapshot.service";
import {
  appendMaterializationRunEvent,
  createMaterializationRun,
  finalizeMaterializationRun,
  trimMaterializationRuns,
  type DashboardMaterializationTriggerType,
  type MaterializationRunEventRecord,
  type MaterializationRunRecord,
} from "./dashboard-materialization-run.service";

const logger = loggers.api("dashboard-artifact-rebuild");

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return String(hash >>> 0);
}

export function buildDashboardDataSourceVersion(dataSource: {
  tableRef: string;
  rowLimit?: number;
  query: Record<string, unknown>;
  computedColumns?: Array<Record<string, unknown>>;
}): string {
  const payload = {
    tableRef: dataSource.tableRef,
    rowLimit: dataSource.rowLimit ?? null,
    query: {
      ...dataSource.query,
      connectionId: String(dataSource.query.connectionId ?? ""),
    },
    computedColumns: dataSource.computedColumns ?? [],
  };
  return hashString(JSON.stringify(payload));
}

function buildExecutableQuery(dataSource: {
  query?: {
    language?: string;
    code?: string;
    mongoOptions?: { collection?: string; operation?: string };
  };
}) {
  if (
    dataSource.query?.language === "mongodb" &&
    dataSource.query.mongoOptions?.collection
  ) {
    return {
      collection: dataSource.query.mongoOptions.collection,
      operation: dataSource.query.mongoOptions.operation || "find",
      query: dataSource.query.code || "",
    };
  }

  return dataSource.query?.code;
}

function normalizeFields(
  rows: Record<string, unknown>[],
  fields: Array<{
    name?: string;
    columnName?: string;
    type?: string;
    dataType?: string;
  }> = [],
) {
  const normalized = fields
    .map(field => ({
      name: field.name || field.columnName || "",
      type: field.type || field.dataType,
    }))
    .filter(field => field.name);

  if (normalized.length > 0 || rows.length === 0) {
    return normalized;
  }

  return Object.keys(rows[0]).map(name => ({
    name,
    type: undefined,
  }));
}

function pushRunEvent(
  run: MaterializationRunRecord,
  event: Omit<MaterializationRunEventRecord, "timestamp">,
): MaterializationRunEventRecord {
  const materializedEvent = {
    ...event,
    timestamp: new Date(),
  };
  run.events.push(materializedEvent);
  return materializedEvent;
}

export interface RebuildDashboardArtifactsInput {
  dashboardId: string;
  workspaceId?: string;
  dataSourceIds?: string[];
  force?: boolean;
  triggerType?: DashboardMaterializationTriggerType;
}

export interface RebuildDashboardArtifactsResult {
  dashboardId: string;
  results: Array<{
    dataSourceId: string;
    version: string;
    artifactKey: string;
    rowCount?: number;
    byteSize?: number;
    reused: boolean;
    success: boolean;
    error?: string;
  }>;
}

export async function rebuildDashboardArtifacts(
  input: RebuildDashboardArtifactsInput,
): Promise<RebuildDashboardArtifactsResult> {
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
  const filteredDataSources = dashboard.dataSources.filter(ds =>
    input.dataSourceIds?.length ? input.dataSourceIds.includes(ds.id) : true,
  );

  const results: RebuildDashboardArtifactsResult["results"] = [];

  for (const dataSource of filteredDataSources) {
    const version = buildDashboardDataSourceVersion(dataSource as any);
    const artifactKey = buildDashboardArtifactKey({
      workspaceId,
      dashboardId: dashboard._id.toString(),
      dataSourceId: dataSource.id,
      version,
    });
    const dsIndex = dashboard.dataSources.findIndex(
      ds => ds.id === dataSource.id,
    );
    const requestedAt = new Date();
    const currentRun: MaterializationRunRecord = {
      runId: crypto.randomUUID(),
      workspaceId,
      dashboardId: dashboard._id.toString(),
      dataSourceId: dataSource.id,
      triggerType: input.triggerType || "dashboard_update",
      status: "building",
      requestedAt,
      startedAt: requestedAt,
      version,
      artifactKey,
      events: [],
    };

    try {
      const requestedEvent = pushRunEvent(currentRun, {
        type: "materialization_requested",
        message: "Materialization requested",
      });
      await createMaterializationRun({
        workspaceId,
        dashboardId: dashboard._id.toString(),
        dataSourceId: dataSource.id,
        runId: currentRun.runId,
        triggerType: currentRun.triggerType,
        status: currentRun.status,
        requestedAt,
        startedAt: currentRun.startedAt,
        artifactKey,
        version,
        events: [requestedEvent],
      });

      const result = await withArtifactBuildLock(artifactKey, async () => {
        const cachedReady =
          !input.force &&
          dataSource.cache?.parquetArtifactKey === artifactKey &&
          dataSource.cache?.parquetVersion === version &&
          dataSource.cache?.parquetBuildStatus === "ready" &&
          (await artifactExists(artifactKey));

        if (cachedReady) {
          const reusedEvent = pushRunEvent(currentRun, {
            type: "materialization_reused",
            message: "Reused existing parquet artifact",
            metadata: {
              artifactKey,
            },
          });
          await appendMaterializationRunEvent({
            runId: currentRun.runId,
            event: reusedEvent,
          });
          currentRun.status = "ready";
          currentRun.finishedAt = new Date();
          currentRun.rowCount = dataSource.cache?.rowCount;
          currentRun.byteSize = dataSource.cache?.byteSize;
          await finalizeMaterializationRun({
            runId: currentRun.runId,
            status: currentRun.status,
            finishedAt: currentRun.finishedAt,
            rowCount: currentRun.rowCount,
            byteSize: currentRun.byteSize,
            artifactKey,
            version,
          });

          return {
            dataSourceId: dataSource.id,
            version,
            artifactKey,
            rowCount: dataSource.cache?.rowCount,
            byteSize: dataSource.cache?.byteSize,
            reused: true,
            success: true,
          };
        }

        if (dsIndex !== -1) {
          await Dashboard.findByIdAndUpdate(dashboard._id, {
            $set: {
              [`dataSources.${dsIndex}.cache.parquetBuildStatus`]: "building",
              [`dataSources.${dsIndex}.cache.parquetLastError`]: null,
            },
          });
        }

        const sourceQueryStartedEvent = pushRunEvent(currentRun, {
          type: "source_query_started",
          message: "Started source query execution",
        });
        await appendMaterializationRunEvent({
          runId: currentRun.runId,
          event: sourceQueryStartedEvent,
        });
        const connectionId = String(dataSource.query.connectionId || "");
        if (!Types.ObjectId.isValid(connectionId)) {
          throw new Error(
            `Invalid connectionId for data source ${dataSource.id}`,
          );
        }

        const database = await DatabaseConnection.findById(connectionId);
        if (!database) {
          throw new Error(`Database connection not found for ${dataSource.id}`);
        }

        const executableQuery = buildExecutableQuery(dataSource);
        if (!executableQuery) {
          throw new Error(
            `Dashboard data source query is missing for ${dataSource.id}`,
          );
        }

        const queryResult = await databaseConnectionService.executeQuery(
          database,
          executableQuery,
          {
            databaseId: dataSource.query.databaseId,
            databaseName: dataSource.query.databaseName,
          },
        );

        if (!queryResult.success || !queryResult.data) {
          throw new Error(queryResult.error || "Query failed");
        }

        const rows = Array.isArray(queryResult.data) ? queryResult.data : [];
        const limit = dataSource.rowLimit || 500000;
        const limitedRows = rows.slice(0, limit);
        const sourceQueryFinishedEvent = pushRunEvent(currentRun, {
          type: "source_query_finished",
          message: "Finished source query execution",
          metadata: {
            rowCount: limitedRows.length,
          },
        });
        await appendMaterializationRunEvent({
          runId: currentRun.runId,
          event: sourceQueryFinishedEvent,
        });

        const normalizedFields = normalizeFields(
          limitedRows,
          (queryResult.fields || []) as Array<{
            name?: string;
            columnName?: string;
            type?: string;
            dataType?: string;
          }>,
        );

        const parquetWriteStartedEvent = pushRunEvent(currentRun, {
          type: "parquet_write_started",
          message: "Started parquet serialization",
        });
        await appendMaterializationRunEvent({
          runId: currentRun.runId,
          event: parquetWriteStartedEvent,
        });
        const parquetFile = await writeParquetTempFile({
          rows: limitedRows,
          fields: normalizedFields,
          filenameBase: `${dashboard._id}-${dataSource.id}`,
        });
        currentRun.rowCount = parquetFile.rowCount;
        currentRun.byteSize = parquetFile.byteSize;
        const parquetWriteFinishedEvent = pushRunEvent(currentRun, {
          type: "parquet_write_finished",
          message: "Finished parquet serialization",
          metadata: {
            rowCount: parquetFile.rowCount,
            byteSize: parquetFile.byteSize,
          },
        });
        await appendMaterializationRunEvent({
          runId: currentRun.runId,
          event: parquetWriteFinishedEvent,
        });

        const snapshots = await generateSnapshotsForDataSource({
          dashboard: {
            widgets: dashboard.widgets.map(widget => ({
              id: widget.id,
              dataSourceId: widget.dataSourceId,
              localSql: widget.localSql,
            })),
          },
          dataSource: {
            id: dataSource.id,
            tableRef: dataSource.tableRef,
          },
          version,
          parquetFilePath: parquetFile.filePath,
        });

        const artifactStorePutStartedEvent = pushRunEvent(currentRun, {
          type: "artifact_store_put_started",
          message: "Started artifact store upload",
          metadata: {
            artifactKey,
          },
        });
        await appendMaterializationRunEvent({
          runId: currentRun.runId,
          event: artifactStorePutStartedEvent,
        });
        try {
          await storeArtifact(parquetFile.filePath, artifactKey, {
            dashboardId: dashboard._id.toString(),
            dataSourceId: dataSource.id,
            version,
          });
        } finally {
          await fsPromises
            .rm(parquetFile.filePath, { force: true })
            .catch(() => undefined);
        }
        const artifactStorePutFinishedEvent = pushRunEvent(currentRun, {
          type: "artifact_store_put_finished",
          message: "Stored artifact successfully",
          metadata: {
            artifactKey,
          },
        });
        await appendMaterializationRunEvent({
          runId: currentRun.runId,
          event: artifactStorePutFinishedEvent,
        });

        const refreshedAt = new Date();
        currentRun.status = "ready";
        currentRun.finishedAt = refreshedAt;
        const readyEvent = pushRunEvent(currentRun, {
          type: "materialization_ready",
          message: "Materialization completed successfully",
          metadata: {
            artifactKey,
          },
        });
        await appendMaterializationRunEvent({
          runId: currentRun.runId,
          event: readyEvent,
        });

        if (dsIndex !== -1) {
          const snapshotUpdates = Object.fromEntries(
            Object.entries(snapshots).map(([widgetId, snapshot]) => [
              `snapshots.${widgetId}`,
              snapshot,
            ]),
          );
          await Dashboard.findByIdAndUpdate(dashboard._id, {
            $set: {
              [`dataSources.${dsIndex}.cache.lastRefreshedAt`]: refreshedAt,
              [`dataSources.${dsIndex}.cache.rowCount`]: parquetFile.rowCount,
              [`dataSources.${dsIndex}.cache.byteSize`]: parquetFile.byteSize,
              [`dataSources.${dsIndex}.cache.parquetArtifactKey`]: artifactKey,
              [`dataSources.${dsIndex}.cache.parquetVersion`]: version,
              [`dataSources.${dsIndex}.cache.parquetBuiltAt`]: refreshedAt,
              [`dataSources.${dsIndex}.cache.parquetBuildStatus`]: "ready",
              [`dataSources.${dsIndex}.cache.parquetLastError`]: null,
              "cache.lastRefreshedAt": refreshedAt,
              ...snapshotUpdates,
            },
          });
        }

        await finalizeMaterializationRun({
          runId: currentRun.runId,
          status: currentRun.status,
          finishedAt: currentRun.finishedAt,
          rowCount: currentRun.rowCount,
          byteSize: currentRun.byteSize,
          artifactKey,
          version,
        });

        return {
          dataSourceId: dataSource.id,
          version,
          artifactKey,
          rowCount: parquetFile.rowCount,
          byteSize: parquetFile.byteSize,
          reused: false,
          success: true,
        };
      });

      results.push(result);
    } catch (error) {
      logger.error("Failed to rebuild dashboard artifact", {
        error,
        dashboardId: dashboard._id.toString(),
        dataSourceId: dataSource.id,
      });

      currentRun.status = "error";
      currentRun.error =
        error instanceof Error ? error.message : "Unknown error";
      currentRun.finishedAt = new Date();
      const failedEvent = pushRunEvent(currentRun, {
        type: "materialization_failed",
        message: "Materialization failed",
        metadata: {
          error: currentRun.error,
        },
      });
      await appendMaterializationRunEvent({
        runId: currentRun.runId,
        event: failedEvent,
      });

      if (dsIndex !== -1) {
        await Dashboard.findByIdAndUpdate(dashboard._id, {
          $set: {
            [`dataSources.${dsIndex}.cache.parquetBuildStatus`]: "error",
            [`dataSources.${dsIndex}.cache.parquetLastError`]:
              error instanceof Error ? error.message : "Unknown error",
          },
        }).catch(() => undefined);
      }

      await finalizeMaterializationRun({
        runId: currentRun.runId,
        status: "error",
        finishedAt: currentRun.finishedAt,
        error: currentRun.error,
        artifactKey,
        version,
      });

      results.push({
        dataSourceId: dataSource.id,
        version,
        artifactKey,
        reused: false,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }

    await trimMaterializationRuns({
      dashboardId: dashboard._id.toString(),
      dataSourceId: dataSource.id,
      keep: 100,
    }).catch(() => undefined);
  }

  return {
    dashboardId: dashboard._id.toString(),
    results,
  };
}
