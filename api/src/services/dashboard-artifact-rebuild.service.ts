import { promises as fsPromises } from "fs";
import { Types } from "mongoose";
import { Dashboard, DatabaseConnection } from "../database/workspace-schema";
import { loggers } from "../logging";
import { databaseConnectionService } from "./database-connection.service";
import {
  artifactExists,
  buildDashboardArtifactKey,
  storeArtifact,
} from "./dashboard-cache.service";
import { writeParquetTempFile } from "../utils/parquet-serializer";
import { generateSnapshotsForDataSource } from "./dashboard-snapshot.service";

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

export interface RebuildDashboardArtifactsInput {
  dashboardId: string;
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

    try {
      const cachedReady =
        !input.force &&
        dataSource.cache?.parquetArtifactKey === artifactKey &&
        dataSource.cache?.parquetVersion === version &&
        dataSource.cache?.parquetBuildStatus === "ready" &&
        (await artifactExists(artifactKey));

      if (cachedReady) {
        results.push({
          dataSourceId: dataSource.id,
          version,
          artifactKey,
          rowCount: dataSource.cache?.rowCount,
          byteSize: dataSource.cache?.byteSize,
          reused: true,
          success: true,
        });
        continue;
      }

      if (dsIndex !== -1) {
        await Dashboard.findByIdAndUpdate(dashboard._id, {
          $set: {
            [`dataSources.${dsIndex}.cache.parquetBuildStatus`]: "building",
            [`dataSources.${dsIndex}.cache.parquetLastError`]: null,
          },
        });
      }

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
      const normalizedFields = normalizeFields(
        limitedRows,
        (queryResult.fields || []) as Array<{
          name?: string;
          columnName?: string;
          type?: string;
          dataType?: string;
        }>,
      );

      const parquetFile = await writeParquetTempFile({
        rows: limitedRows,
        fields: normalizedFields,
        filenameBase: `${dashboard._id}-${dataSource.id}`,
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

      if (dsIndex !== -1) {
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
        await Dashboard.findByIdAndUpdate(dashboard._id, {
          $set: {
            [`dataSources.${dsIndex}.cache.lastRefreshedAt`]: new Date(),
            [`dataSources.${dsIndex}.cache.rowCount`]: parquetFile.rowCount,
            [`dataSources.${dsIndex}.cache.byteSize`]: parquetFile.byteSize,
            [`dataSources.${dsIndex}.cache.parquetArtifactKey`]: artifactKey,
            [`dataSources.${dsIndex}.cache.parquetVersion`]: version,
            [`dataSources.${dsIndex}.cache.parquetBuiltAt`]: new Date(),
            [`dataSources.${dsIndex}.cache.parquetExpiresAt`]: expiresAt,
            [`dataSources.${dsIndex}.cache.parquetBuildStatus`]: "ready",
            [`dataSources.${dsIndex}.cache.parquetLastError`]: null,
            "cache.lastRefreshedAt": new Date(),
            ...snapshotUpdates,
          },
        });
      }

      results.push({
        dataSourceId: dataSource.id,
        version,
        artifactKey,
        rowCount: parquetFile.rowCount,
        byteSize: parquetFile.byteSize,
        reused: false,
        success: true,
      });
    } catch (error) {
      logger.error("Failed to rebuild dashboard artifact", {
        error,
        dashboardId: dashboard._id.toString(),
        dataSourceId: dataSource.id,
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
