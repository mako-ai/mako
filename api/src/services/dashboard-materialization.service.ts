import { Types } from "mongoose";
import {
  Dashboard,
  type IDashboard,
  type IDashboardDataSource,
} from "../database/workspace-schema";
import {
  artifactExists,
  buildDashboardArtifactKey,
  buildDashboardMaterializationArtifactPath,
} from "./dashboard-cache.service";
import { getDashboardArtifactStoreType } from "./dashboard-artifact-store.service";
import { buildDashboardDataSourceVersion } from "./dashboard-artifact-rebuild.service";

export type MaterializationStatusValue =
  | "missing"
  | "building"
  | "ready"
  | "error";

export interface DashboardDataSourceMaterializationStatus {
  dataSourceId: string;
  name: string;
  status: MaterializationStatusValue;
  version: string | null;
  format: "parquet";
  storageBackend: "filesystem" | "gcs" | "s3";
  rowCount: number | null;
  byteSize: number | null;
  builtAt: string | null;
  readUrl: string | null;
  lastError: string | null;
  artifactKey: string | null;
  lastMaterializedAt: string | null;
}

export interface DashboardMaterializationStatus {
  dashboardId: string;
  workspaceId: string;
  status: MaterializationStatusValue;
  lastRefreshedAt: string | null;
  allReady: boolean;
  anyBuilding: boolean;
  dataSources: DashboardDataSourceMaterializationStatus[];
}

export async function buildDataSourceMaterializationStatus(input: {
  workspaceId: string;
  dashboardId: string;
  dataSource: IDashboardDataSource;
}): Promise<DashboardDataSourceMaterializationStatus> {
  const { workspaceId, dashboardId, dataSource } = input;
  const version = buildDashboardDataSourceVersion(dataSource as any);
  const cache = dataSource.cache;
  const artifactKey =
    cache?.parquetArtifactKey ||
    buildDashboardArtifactKey({
      workspaceId,
      dashboardId,
      dataSourceId: dataSource.id,
      version,
    });
  const canReadArtifact = artifactKey
    ? await artifactExists(artifactKey)
    : false;
  const status: MaterializationStatusValue =
    cache?.parquetBuildStatus === "building"
      ? "building"
      : canReadArtifact && cache?.parquetBuildStatus !== "error"
        ? "ready"
        : cache?.parquetBuildStatus || "missing";

  return {
    dataSourceId: dataSource.id,
    name: dataSource.name,
    status,
    version: cache?.parquetVersion || version,
    format: "parquet",
    storageBackend: getDashboardArtifactStoreType(),
    rowCount: cache?.rowCount ?? null,
    byteSize: cache?.byteSize ?? null,
    builtAt: cache?.parquetBuiltAt ? cache.parquetBuiltAt.toISOString() : null,
    readUrl:
      artifactKey || cache?.parquetBuildStatus === "building"
        ? buildDashboardMaterializationArtifactPath({
            workspaceId,
            dashboardId,
            dataSourceId: dataSource.id,
          })
        : null,
    lastError: cache?.parquetLastError || null,
    artifactKey,
    lastMaterializedAt: cache?.parquetBuiltAt
      ? cache.parquetBuiltAt.toISOString()
      : null,
  };
}

export async function buildDashboardMaterializationStatus(
  dashboard: IDashboard,
): Promise<DashboardMaterializationStatus> {
  const workspaceId = dashboard.workspaceId.toString();
  const dashboardId = dashboard._id.toString();
  const dataSources = await Promise.all(
    dashboard.dataSources.map(dataSource =>
      buildDataSourceMaterializationStatus({
        workspaceId,
        dashboardId,
        dataSource,
      }),
    ),
  );
  const anyBuilding = dataSources.some(source => source.status === "building");
  const anyError = dataSources.some(source => source.status === "error");
  const allReady =
    dataSources.length > 0 &&
    dataSources.every(source => source.status === "ready");

  return {
    dashboardId,
    workspaceId,
    status: anyBuilding
      ? "building"
      : anyError
        ? "error"
        : allReady
          ? "ready"
          : "missing",
    lastRefreshedAt: dashboard.cache?.lastRefreshedAt
      ? dashboard.cache.lastRefreshedAt.toISOString()
      : null,
    allReady,
    anyBuilding,
    dataSources,
  };
}

export async function getDashboardForMaterialization(input: {
  workspaceId: string;
  dashboardId: string;
}) {
  if (
    !Types.ObjectId.isValid(input.workspaceId) ||
    !Types.ObjectId.isValid(input.dashboardId)
  ) {
    return null;
  }

  return await Dashboard.findOne({
    _id: new Types.ObjectId(input.dashboardId),
    workspaceId: new Types.ObjectId(input.workspaceId),
  });
}

export function getDataSourceOrThrow(
  dashboard: IDashboard,
  dataSourceId: string,
): IDashboardDataSource {
  const dataSource = dashboard.dataSources.find(ds => ds.id === dataSourceId);
  if (!dataSource) {
    throw new Error(`Dashboard data source not found: ${dataSourceId}`);
  }
  return dataSource;
}
