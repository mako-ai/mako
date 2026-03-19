export type DashboardQueryLanguage = "sql" | "javascript" | "mongodb";

export interface DashboardQueryDefinition {
  connectionId: string;
  language: DashboardQueryLanguage;
  code: string;
  databaseId?: string;
  databaseName?: string;
  mongoOptions?: {
    collection?: string;
    operation?:
      | "find"
      | "aggregate"
      | "insertMany"
      | "updateMany"
      | "deleteMany"
      | "findOne"
      | "updateOne"
      | "deleteOne";
  };
}

export interface DashboardDataSourceOrigin {
  type: "saved_console" | "local";
  consoleId?: string;
  consoleName?: string;
  importedAt?: string;
}

export interface DashboardDataSource {
  id: string;
  name: string;
  tableRef: string;
  query: DashboardQueryDefinition;
  origin?: DashboardDataSourceOrigin;
  timeDimension?: string;
  rowLimit?: number;
  cache?: {
    ttlSeconds?: number;
    lastRefreshedAt?: string;
    rowCount?: number;
    byteSize?: number;
  };
  computedColumns?: Array<{
    name: string;
    expression: string;
    type: "quantitative" | "temporal" | "nominal" | "ordinal";
  }>;
}

export interface DashboardWidget {
  id: string;
  title?: string;
  type: "chart" | "kpi" | "table";
  dataSourceId: string;
  localSql: string;
  vegaLiteSpec?: Record<string, unknown>;
  kpiConfig?: {
    valueField: string;
    format?: string;
    comparisonField?: string;
    comparisonLabel?: string;
  };
  tableConfig?: { columns?: string[]; pageSize?: number };
  crossFilter: { enabled: boolean; fields?: string[] };
  layout: {
    x: number;
    y: number;
    w: number;
    h: number;
    minW?: number;
    minH?: number;
  };
}

export interface TableRelationship {
  id: string;
  from: { dataSourceId: string; column: string };
  to: { dataSourceId: string; column: string };
  type: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
}

export interface GlobalFilter {
  id: string;
  type: "date-range" | "select" | "multi-select" | "search";
  label: string;
  dataSourceId: string;
  column: string;
  config: Record<string, unknown>;
  layout: { order: number; width?: number };
}

export interface Dashboard {
  _id: string;
  workspaceId: string;
  title: string;
  description?: string;
  dataSources: DashboardDataSource[];
  relationships: TableRelationship[];
  widgets: DashboardWidget[];
  globalFilters: GlobalFilter[];
  crossFilter: { enabled: boolean; resolution: "intersect" | "union" };
  layout: { columns: number; rowHeight: number };
  cache: { ttlSeconds: number; lastRefreshedAt?: string };
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
