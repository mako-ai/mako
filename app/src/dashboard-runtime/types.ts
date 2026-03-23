export type {
  DashboardQueryLanguage,
  DashboardQueryDefinition,
  DashboardDataSourceOrigin,
  DashboardWidget,
  TableRelationship,
  GlobalFilter,
} from "@mako/schemas";

export {
  DashboardDefinitionSchema,
  DashboardWidgetSchema,
  DashboardDataSourceSchema,
  TableRelationshipSchema,
  GlobalFilterSchema,
} from "@mako/schemas";

import type {
  DashboardDataSource as SchemaDashboardDataSource,
  DashboardDefinition,
} from "@mako/schemas";

export interface DashboardDataSource
  extends Omit<SchemaDashboardDataSource, "cache"> {
  cache?:
    | (SchemaDashboardDataSource["cache"] & {
        parquetArtifactKey?: string;
        parquetVersion?: string;
        parquetBuiltAt?: string;
        parquetBuildStatus?: "missing" | "building" | "ready" | "error";
        parquetLastError?: string;
        parquetUrl?: string;
      })
    | null;
}

export interface Dashboard
  extends Omit<DashboardDefinition, "crossFilter" | "dataSources"> {
  _id: string;
  workspaceId: string;
  dataSources: DashboardDataSource[];
  crossFilter: {
    enabled: DashboardDefinition["crossFilter"]["enabled"];
    resolution: DashboardDefinition["crossFilter"]["resolution"];
    engine?: "mosaic";
  };
  materializationSchedule: {
    enabled: boolean;
    cron: string | null;
    timezone?: string;
  };
  access: "private" | "workspace";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  snapshots?: Record<
    string,
    {
      version: string;
      generatedAt: string;
      rowCount: number;
      rows: Record<string, unknown>[];
      fields: Array<{ name: string; type: string }>;
    }
  >;
}

export type DashboardRuntimeStatus = "idle" | "loading" | "ready" | "error";

export interface DashboardRuntimeColumn {
  name: string;
  type: string;
  sampleValues?: unknown[];
}

export interface DashboardDataSourceRuntimeState {
  dataSourceId: string;
  tableRef: string;
  version: string;
  dataVersion: number;
  status: DashboardRuntimeStatus;
  rowsLoaded: number;
  rowCount?: number;
  schema: DashboardRuntimeColumn[];
  sampleRows: Record<string, unknown>[];
  error: string | null;
  loadPath?: "memory" | "arrow_stream" | "ndjson_stream" | null;
  resolvedMode?: "builder" | "viewer";
  artifactUrl?: string | null;
  loadDurationMs?: number | null;
  materializationStatus?: "missing" | "building" | "ready" | "error";
  materializationVersion?: string | null;
  materializedAt?: string | null;
  storageBackend?: "filesystem" | "gcs" | "s3" | null;
}

export interface DashboardLogEntry {
  timestamp: number;
  level: "info" | "warn" | "error";
  message: string;
  metadata?: Record<string, unknown>;
}

export interface DashboardWidgetRuntimeState {
  widgetId: string;
  queryEngine: "mosaic";
  queryStatus: DashboardRuntimeStatus;
  queryError: string | null;
  queryErrorKind: string | null;
  queryRowCount: number | null;
  queryFields: string[];
  renderStatus: "idle" | "ready" | "error";
  renderError: string | null;
  renderErrorKind: string | null;
  lastQueryAt: number | null;
  lastRenderAt: number | null;
  refreshGeneration: number;
}

export interface DashboardSessionRuntimeState {
  dashboardId: string;
  sessionId: string;
  queryGeneration: number;
  dataSources: Record<string, DashboardDataSourceRuntimeState>;
  widgets: Record<string, DashboardWidgetRuntimeState>;
  eventLog: DashboardLogEntry[];
  runtimeContext: "builder" | "viewer";
  persistent: boolean;
  materializationPolling: boolean;
  freshDataAvailable: boolean;
}

export interface DashboardRuntimeState {
  activeDashboardId: string | null;
  sessions: Record<string, DashboardSessionRuntimeState>;
}

export type DashboardRuntimeEvent =
  | {
      type: "session/activated";
      dashboardId: string;
      sessionId: string;
      runtimeContext: "builder" | "viewer";
      persistent: boolean;
    }
  | {
      type: "session/disposed";
      dashboardId: string;
    }
  | {
      type: "datasource/registered";
      dashboardId: string;
      dataSourceId: string;
      tableRef: string;
      version: string;
    }
  | {
      type: "dashboard/log-appended";
      dashboardId: string;
      level: "info" | "warn" | "error";
      message: string;
      metadata?: Record<string, unknown>;
    }
  | {
      type: "dashboard/query-generation-bumped";
      dashboardId: string;
    }
  | {
      type: "dashboard/materialization-polling-set";
      dashboardId: string;
      polling: boolean;
    }
  | {
      type: "dashboard/fresh-data-available-set";
      dashboardId: string;
      value: boolean;
    }
  | {
      type: "dashboard/reset";
      dashboardId: string;
    }
  | {
      type: "datasource/load-started";
      dashboardId: string;
      dataSourceId: string;
      preserveExistingData?: boolean;
    }
  | {
      type: "widget/query-started";
      dashboardId: string;
      widgetId: string;
    }
  | {
      type: "widget/query-succeeded";
      dashboardId: string;
      widgetId: string;
      rowCount: number;
      fields: string[];
    }
  | {
      type: "widget/query-failed";
      dashboardId: string;
      widgetId: string;
      error: string;
      errorKind: string | null;
    }
  | {
      type: "widget/render-succeeded";
      dashboardId: string;
      widgetId: string;
    }
  | {
      type: "widget/render-failed";
      dashboardId: string;
      widgetId: string;
      error: string;
      errorKind: string | null;
    }
  | {
      type: "widget/refresh-bumped";
      dashboardId: string;
      widgetId: string;
    }
  | {
      type: "widget/removed";
      dashboardId: string;
      widgetId: string;
    }
  | {
      type: "datasource/load-progress";
      dashboardId: string;
      dataSourceId: string;
      rowsLoaded: number;
      preserveExistingData?: boolean;
    }
  | {
      type: "datasource/load-succeeded";
      dashboardId: string;
      dataSourceId: string;
      rowsLoaded: number;
      rowCount: number;
      schema: DashboardRuntimeColumn[];
      sampleRows: Record<string, unknown>[];
    }
  | {
      type: "datasource/load-failed";
      dashboardId: string;
      dataSourceId: string;
      rowsLoaded: number;
      error: string;
      preserveExistingData?: boolean;
      loadDurationMs?: number;
    }
  | {
      type: "datasource/diagnostics-updated";
      dashboardId: string;
      dataSourceId: string;
      diagnostics: Partial<
        Pick<
          DashboardDataSourceRuntimeState,
          | "loadPath"
          | "resolvedMode"
          | "artifactUrl"
          | "loadDurationMs"
          | "materializationStatus"
          | "materializationVersion"
          | "materializedAt"
          | "storageBackend"
        >
      >;
    }
  | {
      type: "datasource/removed";
      dashboardId: string;
      dataSourceId: string;
    };

export interface DashboardQueryResult {
  rows: Record<string, unknown>[];
  fields: Array<{ name: string; type: string }>;
  rowCount: number;
}

export type DashboardQueryExecutor = (
  sql: string,
  options?: { dataSourceId?: string },
) => Promise<DashboardQueryResult>;

/**
 * Metadata fields that are excluded from the code editor.
 * These are managed by the server and should never be editable by users.
 */
const DASHBOARD_METADATA_KEYS: ReadonlySet<string> = new Set([
  "_id",
  "workspaceId",
  "access",
  "createdBy",
  "createdAt",
  "updatedAt",
]);

/**
 * Serializes a Dashboard into the editable definition portion only,
 * stripping DB metadata fields (_id, workspaceId, etc.).
 */
export function serializeDashboardDefinition(
  dashboard: Dashboard,
): DashboardDefinition {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dashboard)) {
    if (!DASHBOARD_METADATA_KEYS.has(key)) {
      result[key] = value;
    }
  }
  return result as DashboardDefinition;
}
