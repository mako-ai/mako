import { hashContent } from "./hash";

/**
 * Compute a hash of the console state for dirty state tracking.
 * This single hash replaces multiple saved* fields and enables
 * accurate detection of unsaved changes across all editable properties.
 *
 * When current state hash !== savedStateHash, the console has unsaved changes.
 */
export function computeConsoleStateHash(
  content: string,
  connectionId?: string,
  databaseId?: string,
  databaseName?: string,
): string {
  return hashContent(
    `${content}|${connectionId || ""}|${databaseId || ""}|${databaseName || ""}`,
  );
}

/**
 * Compute a hash of the dashboard definition for dirty state tracking.
 * Includes all user-editable fields; excludes runtime/cache metadata.
 * When current hash !== savedStateHash, the dashboard has unsaved changes.
 */
export function computeDashboardStateHash(dashboard: {
  title?: string;
  description?: string;
  widgets: Array<{
    id: string;
    title?: string;
    type: string;
    dataSourceId: string;
    localSql: string;
    vegaLiteSpec?: unknown;
    kpiConfig?: unknown;
    tableConfig?: unknown;
    crossFilter?: unknown;
    layouts?: unknown;
  }>;
  dataSources: Array<{
    id: string;
    name: string;
    query: unknown;
    computedColumns?: unknown[];
    timeDimension?: string;
    rowLimit?: number;
  }>;
  relationships: unknown[];
  globalFilters: unknown[];
  crossFilter: unknown;
  layout: unknown;
  materializationSchedule?: unknown;
}): string {
  const payload = {
    title: dashboard.title,
    description: dashboard.description,
    widgets: dashboard.widgets.map(w => ({
      id: w.id,
      title: w.title,
      type: w.type,
      dataSourceId: w.dataSourceId,
      localSql: w.localSql,
      vegaLiteSpec: w.vegaLiteSpec,
      kpiConfig: w.kpiConfig,
      tableConfig: w.tableConfig,
      crossFilter: w.crossFilter,
      layouts: w.layouts,
    })),
    dataSources: dashboard.dataSources.map(ds => ({
      id: ds.id,
      name: ds.name,
      query: ds.query,
      computedColumns: ds.computedColumns,
      timeDimension: ds.timeDimension,
      rowLimit: ds.rowLimit,
    })),
    relationships: dashboard.relationships,
    globalFilters: dashboard.globalFilters,
    crossFilter: dashboard.crossFilter,
    layout: dashboard.layout,
    materializationSchedule: dashboard.materializationSchedule,
  };
  return hashContent(JSON.stringify(payload));
}
