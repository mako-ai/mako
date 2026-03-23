import { DuckDBInstance } from "@duckdb/node-api";
import { loggers } from "../logging";

const logger = loggers.api("dashboard-snapshot");

export interface DashboardWidgetSnapshot {
  version: string;
  generatedAt: Date;
  rowCount: number;
  rows: Record<string, unknown>[];
  fields: Array<{ name: string; type: string }>;
}

function inferFieldType(value: unknown): string {
  if (value === null || value === undefined) return "UNKNOWN";
  if (value instanceof Date) return "TIMESTAMP";
  if (Array.isArray(value)) return "JSON";
  switch (typeof value) {
    case "number":
      return Number.isInteger(value) ? "INTEGER" : "DOUBLE";
    case "boolean":
      return "BOOLEAN";
    case "string":
      return "VARCHAR";
    case "object":
      return "JSON";
    default:
      return "UNKNOWN";
  }
}

function inferFields(rows: Record<string, unknown>[]) {
  const sample = rows[0] || {};
  return Object.keys(sample).map(name => ({
    name,
    type: inferFieldType(sample[name]),
  }));
}

export async function generateSnapshotsForDataSource(options: {
  dashboard: {
    widgets: Array<{
      id: string;
      dataSourceId: string;
      localSql: string;
    }>;
  };
  dataSource: {
    id: string;
    tableRef: string;
  };
  version: string;
  parquetFilePath: string;
}): Promise<Record<string, DashboardWidgetSnapshot>> {
  const relevantWidgets = options.dashboard.widgets.filter(
    widget => widget.dataSourceId === options.dataSource.id,
  );
  if (relevantWidgets.length === 0) {
    return {};
  }

  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();

  try {
    await connection.run(
      `CREATE VIEW "${options.dataSource.tableRef}" AS SELECT * FROM read_parquet('${options.parquetFilePath.replace(/'/g, "''")}')`,
    );

    const MAX_SNAPSHOT_ROWS = 500;
    const snapshots: Record<string, DashboardWidgetSnapshot> = {};
    for (const widget of relevantWidgets) {
      try {
        const cappedSql = `SELECT * FROM (${widget.localSql}) AS _snap LIMIT ${MAX_SNAPSHOT_ROWS}`;
        const result = await connection.run(cappedSql);
        const rowObjects = (await result.getRowObjectsJson()) as Array<
          Record<string, unknown>
        >;
        snapshots[widget.id] = {
          version: options.version,
          generatedAt: new Date(),
          rowCount: rowObjects.length,
          rows: rowObjects,
          fields: inferFields(rowObjects),
        };
      } catch (error) {
        logger.warn("Dashboard widget snapshot generation failed", {
          error,
          widgetId: widget.id,
          dataSourceId: options.dataSource.id,
        });
      }
    }

    return snapshots;
  } finally {
    connection.closeSync();
  }
}
