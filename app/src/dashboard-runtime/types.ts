export type {
  DashboardQueryLanguage,
  DashboardQueryDefinition,
  DashboardDataSourceOrigin,
  DashboardDataSource,
  DashboardWidget,
  TableRelationship,
  GlobalFilter,
  DashboardDefinition,
} from "@mako/schemas";

export {
  DashboardDefinitionSchema,
  DashboardWidgetSchema,
  DashboardDataSourceSchema,
  TableRelationshipSchema,
  GlobalFilterSchema,
} from "@mako/schemas";

import type { DashboardDefinition } from "@mako/schemas";

export interface Dashboard extends Omit<DashboardDefinition, "crossFilter"> {
  _id: string;
  workspaceId: string;
  crossFilter: {
    enabled: DashboardDefinition["crossFilter"]["enabled"];
    resolution: DashboardDefinition["crossFilter"]["resolution"];
    engine?: "mosaic";
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
      type: "dashboard/query-generation-bumped";
      dashboardId: string;
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
