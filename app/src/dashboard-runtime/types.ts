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

export interface Dashboard extends DashboardDefinition {
  _id: string;
  workspaceId: string;
  access: "private" | "workspace";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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
  status: DashboardRuntimeStatus;
  rowsLoaded: number;
  rowCount?: number;
  schema: DashboardRuntimeColumn[];
  sampleRows: Record<string, unknown>[];
  error: string | null;
}

export interface DashboardSessionRuntimeState {
  dashboardId: string;
  sessionId: string;
  dataSources: Record<string, DashboardDataSourceRuntimeState>;
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
      type: "datasource/load-started";
      dashboardId: string;
      dataSourceId: string;
    }
  | {
      type: "datasource/load-progress";
      dashboardId: string;
      dataSourceId: string;
      rowsLoaded: number;
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

import type { DashboardDefinition } from "@mako/schemas";

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
