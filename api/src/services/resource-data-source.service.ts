import { Types } from "mongoose";
import {
  Dashboard,
  MakoApp,
  type IDashboard,
  type IDashboardDataSource,
  type IMakoApp,
  type IMakoAppDataBinding,
} from "../database/workspace-schema";
import { DashboardManager } from "../utils/dashboard-manager";
import { canReadResource, canWriteResource } from "../utils/resource-acl";
import {
  buildDataSourceMaterializationStatus,
  type MaterializationStatusValue,
} from "./dashboard-materialization.service";
import { queueDashboardArtifactRefresh } from "./dashboard-refresh-runner.service";
import {
  buildAppBindingMaterializationStatus,
  queueAppBindingMaterialization,
} from "./app-binding-materialization.service";
import {
  normalizeDashboardMaterializationSchedule,
  validateDashboardMaterializationSchedule,
  type DashboardMaterializationScheduleInput,
} from "./dashboard-materialization-schedule.service";

export type ResourceDataSourceType = "dashboard" | "app";
export type ResourceDataSourceMaterialization = "live" | "parquet";

export interface ResourceDataSourceSettingsInput {
  materialization?: ResourceDataSourceMaterialization;
  schedule?: DashboardMaterializationScheduleInput | null;
}

export interface ResourceDataSourceStatus {
  status: MaterializationStatusValue;
  rowCount: number | null;
  byteSize: number | null;
  artifactRevision: string | null;
  materializedAt: string | null;
  readUrl: string | null;
  lastError: string | null;
}

export interface UnifiedResourceDataSource {
  id: string;
  name: string;
  resourceType: ResourceDataSourceType;
  resourceId: string;
  sourceKind: "dashboard-data-source" | "app-binding";
  tableRef?: string;
  connectionId: string;
  language: "sql" | "javascript" | "mongodb";
  code: string;
  databaseId?: string;
  databaseName?: string;
  materialization: ResourceDataSourceMaterialization;
  materializationSchedule: {
    enabled: boolean;
    cron: string | null;
    timezone: string;
    dataFreshnessTtlMs?: number | null;
  };
  scheduleScope: "resource" | "data-source";
  status: ResourceDataSourceStatus;
}

export interface ResourceDataSourceRefreshResult {
  resourceType: ResourceDataSourceType;
  resourceId: string;
  dataSourceIds: string[];
  queued: boolean;
  alreadyRunning?: boolean;
}

function assertObjectId(id: string, label: string): void {
  if (!Types.ObjectId.isValid(id)) {
    throw new Error(`Invalid ${label}`);
  }
}

function requireDashboardRead(
  dashboard: IDashboard,
  userId: string | undefined,
  memberRole?: string,
): void {
  if (!userId || !DashboardManager.canRead(dashboard, userId, memberRole)) {
    throw new Error("Access denied");
  }
}

function requireDashboardWrite(
  dashboard: IDashboard,
  userId: string | undefined,
  memberRole?: string,
): void {
  const isAdmin = memberRole === "owner" || memberRole === "admin";
  if (
    !userId ||
    !DashboardManager.canWrite(dashboard, userId, isAdmin, memberRole)
  ) {
    throw new Error("Access denied");
  }
}

function requireAppRead(
  app: IMakoApp,
  userId: string | undefined,
  memberRole?: string,
): void {
  if (!canReadResource(app, userId, memberRole)) {
    throw new Error("Access denied");
  }
}

function requireAppWrite(
  app: IMakoApp,
  userId: string | undefined,
  memberRole?: string,
): void {
  if (!canWriteResource(app, userId, memberRole)) {
    throw new Error("Access denied");
  }
}

function serializeAppStatus(
  status: NonNullable<ReturnType<typeof buildAppBindingMaterializationStatus>>,
): ResourceDataSourceStatus {
  return {
    status: status.status,
    rowCount: status.rowCount ?? null,
    byteSize: status.byteSize ?? null,
    artifactRevision: status.artifactRevision ?? null,
    materializedAt:
      status.parquetBuiltAt?.toISOString() ??
      status.lastRefreshedAt?.toISOString() ??
      null,
    readUrl: null,
    lastError: status.error ?? null,
  };
}

async function serializeDashboardDataSource(input: {
  workspaceId: string;
  dashboard: IDashboard;
  dataSource: IDashboardDataSource;
}): Promise<UnifiedResourceDataSource> {
  const status = await buildDataSourceMaterializationStatus({
    workspaceId: input.workspaceId,
    dashboardId: input.dashboard._id.toString(),
    dataSource: input.dataSource,
  });
  const schedule = normalizeDashboardMaterializationSchedule(
    input.dashboard.materializationSchedule,
  );
  return {
    id: input.dataSource.id,
    name: input.dataSource.name,
    resourceType: "dashboard",
    resourceId: input.dashboard._id.toString(),
    sourceKind: "dashboard-data-source",
    tableRef: input.dataSource.tableRef,
    connectionId: input.dataSource.query.connectionId.toString(),
    language: input.dataSource.query.language,
    code: input.dataSource.query.code,
    databaseId: input.dataSource.query.databaseId,
    databaseName: input.dataSource.query.databaseName,
    materialization: input.dataSource.materialization ?? "parquet",
    materializationSchedule: schedule,
    scheduleScope: "resource",
    status: {
      status: status.status,
      rowCount: status.rowCount,
      byteSize: status.byteSize,
      artifactRevision: status.artifactRevision,
      materializedAt: status.builtAt ?? status.lastMaterializedAt,
      readUrl: status.readUrl,
      lastError: status.lastError,
    },
  };
}

function serializeAppBinding(input: {
  app: IMakoApp;
  binding: IMakoAppDataBinding;
}): UnifiedResourceDataSource {
  const status = buildAppBindingMaterializationStatus(
    input.app,
    input.binding.id,
  );
  return {
    id: input.binding.id,
    name: input.binding.name,
    resourceType: "app",
    resourceId: input.app._id.toString(),
    sourceKind: "app-binding",
    connectionId: input.binding.connectionId.toString(),
    language: input.binding.language,
    code: input.binding.code,
    databaseId: input.binding.databaseId,
    databaseName: input.binding.databaseName,
    materialization: input.binding.materialization,
    materializationSchedule: normalizeDashboardMaterializationSchedule(
      input.binding.materializationSchedule ?? {
        enabled: false,
        cron: null,
        timezone: "UTC",
      },
    ),
    scheduleScope: "data-source",
    status: status
      ? serializeAppStatus(status)
      : {
          status: "missing",
          rowCount: null,
          byteSize: null,
          artifactRevision: null,
          materializedAt: null,
          readUrl: null,
          lastError: "Binding not found",
        },
  };
}

async function getDashboardOrThrow(input: {
  workspaceId: string;
  resourceId: string;
}): Promise<IDashboard> {
  assertObjectId(input.resourceId, "dashboard ID");
  const dashboard = await Dashboard.findOne({
    _id: new Types.ObjectId(input.resourceId),
    workspaceId: new Types.ObjectId(input.workspaceId),
  });
  if (!dashboard) {
    throw new Error("Dashboard not found");
  }
  return dashboard;
}

async function getAppOrThrow(input: {
  workspaceId: string;
  resourceId: string;
}): Promise<IMakoApp> {
  assertObjectId(input.resourceId, "app ID");
  const app = await MakoApp.findOne({
    _id: new Types.ObjectId(input.resourceId),
    workspaceId: new Types.ObjectId(input.workspaceId),
  });
  if (!app) {
    throw new Error("App not found");
  }
  return app;
}

export async function listResourceDataSources(input: {
  workspaceId: string;
  resourceType: ResourceDataSourceType;
  resourceId: string;
  userId?: string;
  memberRole?: string;
}): Promise<UnifiedResourceDataSource[]> {
  if (input.resourceType === "dashboard") {
    const dashboard = await getDashboardOrThrow(input);
    requireDashboardRead(dashboard, input.userId, input.memberRole);
    return await Promise.all(
      dashboard.dataSources.map(dataSource =>
        serializeDashboardDataSource({
          workspaceId: input.workspaceId,
          dashboard,
          dataSource,
        }),
      ),
    );
  }

  const app = await getAppOrThrow(input);
  requireAppRead(app, input.userId, input.memberRole);
  return app.dataBindings.map(binding => serializeAppBinding({ app, binding }));
}

export async function getResourceDataSource(input: {
  workspaceId: string;
  resourceType: ResourceDataSourceType;
  resourceId: string;
  dataSourceId: string;
  userId?: string;
  memberRole?: string;
}): Promise<UnifiedResourceDataSource> {
  const dataSources = await listResourceDataSources(input);
  const dataSource = dataSources.find(source => source.id === input.dataSourceId);
  if (!dataSource) {
    throw new Error("Data source not found");
  }
  return dataSource;
}

export async function updateResourceDataSourceSettings(input: {
  workspaceId: string;
  resourceType: ResourceDataSourceType;
  resourceId: string;
  dataSourceId: string;
  settings: ResourceDataSourceSettingsInput;
  userId?: string;
  memberRole?: string;
}): Promise<UnifiedResourceDataSource> {
  if (input.resourceType === "dashboard") {
    const dashboard = await getDashboardOrThrow(input);
    requireDashboardWrite(dashboard, input.userId, input.memberRole);
    const dataSource = dashboard.dataSources.find(
      ds => ds.id === input.dataSourceId,
    );
    if (!dataSource) {
      throw new Error("Data source not found");
    }
    // Per-data-source live/parquet toggle (parity with app bindings).
    if (input.settings.materialization) {
      dataSource.materialization = input.settings.materialization;
      dashboard.markModified("dataSources");
    }
    if (input.settings.schedule !== undefined) {
      dashboard.materializationSchedule = validateDashboardMaterializationSchedule(
        input.settings.schedule,
      );
    }
    await dashboard.save();
    return await getResourceDataSource(input);
  }

  const app = await getAppOrThrow(input);
  requireAppWrite(app, input.userId, input.memberRole);
  const bindingIndex = app.dataBindings.findIndex(
    binding => binding.id === input.dataSourceId,
  );
  if (bindingIndex < 0) {
    throw new Error("Data source not found");
  }

  const binding = app.dataBindings[bindingIndex];
  if (input.settings.materialization) {
    binding.materialization = input.settings.materialization;
  }
  if (input.settings.schedule !== undefined) {
    binding.materializationSchedule = validateDashboardMaterializationSchedule(
      input.settings.schedule,
    );
  }
  app.markModified("dataBindings");
  await app.save();
  return await getResourceDataSource(input);
}

export async function refreshResourceDataSources(input: {
  workspaceId: string;
  resourceType: ResourceDataSourceType;
  resourceId: string;
  dataSourceId?: string;
  userId?: string;
  memberRole?: string;
}): Promise<ResourceDataSourceRefreshResult> {
  if (input.resourceType === "dashboard") {
    const dashboard = await getDashboardOrThrow(input);
    requireDashboardWrite(dashboard, input.userId, input.memberRole);
    if (input.dataSourceId) {
      const target = dashboard.dataSources.find(
        ds => ds.id === input.dataSourceId,
      );
      if (!target) {
        throw new Error("Data source not found");
      }
      if (target.materialization === "live") {
        throw new Error("Live data sources always run fresh; nothing to refresh");
      }
    }
    const result = await queueDashboardArtifactRefresh({
      workspaceId: input.workspaceId,
      dashboardId: input.resourceId,
      dataSourceIds: input.dataSourceId ? [input.dataSourceId] : undefined,
      force: true,
      triggerType: "manual",
    });
    return {
      resourceType: "dashboard",
      resourceId: input.resourceId,
      dataSourceIds: result.dataSourceIds,
      queued: result.queued,
      alreadyRunning: result.activeRunIds
        ? result.activeRunIds.length > 0
        : undefined,
    };
  }

  const app = await getAppOrThrow(input);
  requireAppWrite(app, input.userId, input.memberRole);
  const targetBindings = input.dataSourceId
    ? app.dataBindings.filter(binding => binding.id === input.dataSourceId)
    : app.dataBindings.filter(binding => binding.materialization === "parquet");
  if (targetBindings.length === 0) {
    throw new Error(
      input.dataSourceId
        ? "Data source not found or not materialized"
        : "No materialized app data sources to refresh",
    );
  }

  const results = await Promise.all(
    targetBindings.map(binding =>
      queueAppBindingMaterialization({
        workspaceId: input.workspaceId,
        appId: input.resourceId,
        bindingId: binding.id,
        force: true,
      }),
    ),
  );
  return {
    resourceType: "app",
    resourceId: input.resourceId,
    dataSourceIds: results.map(result => result.bindingId),
    queued: results.some(result => result.queued),
    alreadyRunning: results.some(result => result.alreadyRunning),
  };
}
