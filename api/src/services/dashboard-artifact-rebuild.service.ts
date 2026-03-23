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
import { getDashboardArtifactStoreType } from "./dashboard-artifact-store.service";
import { writeParquetTempFile } from "../utils/parquet-serializer";
import { generateSnapshotsForDataSource } from "./dashboard-snapshot.service";
import type {
  MaterializationRunEvent,
  MaterializationRunRecord,
} from "./dashboard-materialization.service";

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
  event: Omit<MaterializationRunEvent, "timestamp">,
) {
  run.events = run.events || [];
  run.events.push({
    ...event,
    timestamp: new Date(),
  });
}

async function persistMaterializationRuns(options: {
  dashboardId: string;
  dsIndex: number;
  runs: MaterializationRunRecord[];
}) {
  await Dashboard.findByIdAndUpdate(options.dashboardId, {
    $set: {
      [`dataSources.${options.dsIndex}.cache.materializationRuns`]:
        options.runs,
    },
  }).catch(() => undefined);
}

export interface RebuildDashboardArtifactsInput {
  dashboardId: string;
  workspaceId?: string;
  dataSourceIds?: string[];
  force?: boolean;
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
    const existingRuns = (
      (dataSource.cache?.materializationRuns as MaterializationRunRecord[]) ||
      []
    )
      .map(run => ({
        ...run,
        requestedAt: new Date(run.requestedAt),
        startedAt: run.startedAt ? new Date(run.startedAt) : undefined,
        finishedAt: run.finishedAt ? new Date(run.finishedAt) : undefined,
        events: (run.events || []).map(event => ({
          ...event,
          timestamp: new Date(event.timestamp),
        })),
      }))
      .slice(0, 9);
    const currentRun: MaterializationRunRecord = {
      runId: crypto.randomUUID(),
      status: "building",
      requestedAt: new Date(),
      startedAt: new Date(),
      version,
      artifactKey,
      storageBackend: getDashboardArtifactStoreType(),
      events: [],
    };
    const materializationRuns = [currentRun, ...existingRuns];

    try {
      pushRunEvent(currentRun, {
        type: "materialization_requested",
        message: "Materialization requested",
      });

      const result = await withArtifactBuildLock(artifactKey, async () => {
        const cachedReady =
          !input.force &&
          dataSource.cache?.parquetArtifactKey === artifactKey &&
          dataSource.cache?.parquetVersion === version &&
          dataSource.cache?.parquetBuildStatus === "ready" &&
          (await artifactExists(artifactKey));

        if (cachedReady) {
          pushRunEvent(currentRun, {
            type: "materialization_reused",
            message: "Reused existing parquet artifact",
            metadata: {
              artifactKey,
            },
          });
          currentRun.status = "ready";
          currentRun.finishedAt = new Date();
          currentRun.rowCount = dataSource.cache?.rowCount;
          currentRun.byteSize = dataSource.cache?.byteSize;
          if (dsIndex !== -1) {
            await persistMaterializationRuns({
              dashboardId: dashboard._id.toString(),
              dsIndex,
              runs: materializationRuns,
            });
          }

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
              [`dataSources.${dsIndex}.cache.materializationRuns`]:
                materializationRuns,
            },
          });
        }

        pushRunEvent(currentRun, {
          type: "source_query_started",
          message: "Started source query execution",
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
        pushRunEvent(currentRun, {
          type: "source_query_finished",
          message: "Finished source query execution",
          metadata: {
            rowCount: limitedRows.length,
          },
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

        pushRunEvent(currentRun, {
          type: "parquet_write_started",
          message: "Started parquet serialization",
        });
        const parquetFile = await writeParquetTempFile({
          rows: limitedRows,
          fields: normalizedFields,
          filenameBase: `${dashboard._id}-${dataSource.id}`,
        });
        currentRun.rowCount = parquetFile.rowCount;
        currentRun.byteSize = parquetFile.byteSize;
        pushRunEvent(currentRun, {
          type: "parquet_write_finished",
          message: "Finished parquet serialization",
          metadata: {
            rowCount: parquetFile.rowCount,
            byteSize: parquetFile.byteSize,
          },
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

        pushRunEvent(currentRun, {
          type: "artifact_store_put_started",
          message: "Started artifact store upload",
          metadata: {
            artifactKey,
          },
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
        pushRunEvent(currentRun, {
          type: "artifact_store_put_finished",
          message: "Stored artifact successfully",
          metadata: {
            artifactKey,
          },
        });

        if (dsIndex !== -1) {
          const refreshedAt = new Date();
          const expiresAt =
            dataSource.cache?.ttlSeconds && dataSource.cache.ttlSeconds > 0
              ? new Date(Date.now() + dataSource.cache.ttlSeconds * 1000)
              : undefined;
          const snapshotUpdates = Object.fromEntries(
            Object.entries(snapshots).map(([widgetId, snapshot]) => [
              `snapshots.${widgetId}`,
              snapshot,
            ]),
          );
          currentRun.status = "ready";
          currentRun.finishedAt = refreshedAt;
          pushRunEvent(currentRun, {
            type: "materialization_ready",
            message: "Materialization completed successfully",
            metadata: {
              artifactKey,
            },
          });
          await Dashboard.findByIdAndUpdate(dashboard._id, {
            $set: {
              [`dataSources.${dsIndex}.cache.lastRefreshedAt`]: refreshedAt,
              [`dataSources.${dsIndex}.cache.rowCount`]: parquetFile.rowCount,
              [`dataSources.${dsIndex}.cache.byteSize`]: parquetFile.byteSize,
              [`dataSources.${dsIndex}.cache.parquetArtifactKey`]: artifactKey,
              [`dataSources.${dsIndex}.cache.parquetVersion`]: version,
              [`dataSources.${dsIndex}.cache.parquetBuiltAt`]: refreshedAt,
              [`dataSources.${dsIndex}.cache.parquetExpiresAt`]: expiresAt,
              [`dataSources.${dsIndex}.cache.parquetBuildStatus`]: "ready",
              [`dataSources.${dsIndex}.cache.parquetLastError`]: null,
              [`dataSources.${dsIndex}.cache.materializationRuns`]:
                materializationRuns,
              "cache.lastRefreshedAt": refreshedAt,
              ...snapshotUpdates,
            },
          });
        }

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

      if (dsIndex !== -1) {
        currentRun.status = "error";
        currentRun.error =
          error instanceof Error ? error.message : "Unknown error";
        currentRun.finishedAt = new Date();
        pushRunEvent(currentRun, {
          type: "materialization_failed",
          message: "Materialization failed",
          metadata: {
            error: currentRun.error,
          },
        });
        await Dashboard.findByIdAndUpdate(dashboard._id, {
          $set: {
            [`dataSources.${dsIndex}.cache.parquetBuildStatus`]: "error",
            [`dataSources.${dsIndex}.cache.parquetLastError`]:
              error instanceof Error ? error.message : "Unknown error",
            [`dataSources.${dsIndex}.cache.materializationRuns`]:
              materializationRuns,
          },
        }).catch(() => undefined);
      }

      results.push({
        dataSourceId: dataSource.id,
        version,
        artifactKey,
        reused: false,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return {
    dashboardId: dashboard._id.toString(),
    results,
  };
}
