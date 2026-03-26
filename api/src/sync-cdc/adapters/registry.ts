import type { IFlow } from "../../database/workspace-schema";
import type { CdcStoredEvent } from "../events";
import { BigQueryDestinationAdapter } from "./bigquery";
import { PostgreSqlDestinationAdapter } from "./postgresql";

export interface CdcEntityLayout {
  entity: string;
  tableName: string;
  keyColumns: string[];
  deleteMode?: "hard" | "soft";
  partitioning?: {
    type?: "time" | "ingestion";
    field: string;
    granularity?: "day" | "hour" | "month" | "year";
    requirePartitionFilter?: boolean;
  };
  clustering?: {
    fields: string[];
  };
}

export interface CdcDestinationAdapter {
  destinationType: string;
  ensureLiveTable(layout: CdcEntityLayout): Promise<void>;
  applyEvents(params: {
    events: CdcStoredEvent[];
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
  }): Promise<{ applied: number }>;
  applyBatch(params: {
    records: Array<Record<string, unknown>>;
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
  }): Promise<{ written: number }>;

  /**
   * Return the BQ column types of the live table (if it exists).
   * Used by the bulk-flush path to match Parquet types to the existing table.
   */
  getLiveTableColumnTypes?(
    layout: CdcEntityLayout,
  ): Promise<Map<string, string> | undefined>;

  loadStagingFromParquet?(
    parquetPath: string,
    layout: CdcEntityLayout,
    flowId: string,
  ): Promise<{ loaded: number }>;
  mergeFromStaging?(
    layout: CdcEntityLayout,
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">,
    flowId: string,
  ): Promise<{ written: number }>;
  cleanupStaging?(layout: CdcEntityLayout, flowId: string): Promise<void>;
}

export function resolveCdcDestinationAdapter(params: {
  destinationType: string;
  destinationDatabaseId: string;
  destinationDatabaseName?: string;
  tableDestination: {
    connectionId: string;
    schema: string;
    tableName: string;
  };
}): CdcDestinationAdapter {
  const normalizedType = params.destinationType.toLowerCase();

  if (normalizedType === "bigquery") {
    return new BigQueryDestinationAdapter({
      destinationDatabaseId: params.destinationDatabaseId,
      destinationDatabaseName: params.destinationDatabaseName,
      tableDestination: params.tableDestination,
    });
  }

  if (normalizedType === "postgresql") {
    return new PostgreSqlDestinationAdapter({
      destinationDatabaseId: params.destinationDatabaseId,
      destinationDatabaseName: params.destinationDatabaseName,
      tableDestination: params.tableDestination,
    });
  }

  throw new Error(
    `No CDC destination adapter registered for type '${params.destinationType}'`,
  );
}

export function hasCdcDestinationAdapter(destinationType?: string): boolean {
  if (!destinationType) return false;
  const normalizedType = destinationType.toLowerCase();
  return normalizedType === "bigquery" || normalizedType === "postgresql";
}

export function buildCdcEntityLayout(params: {
  entity: string;
  tableName: string;
  keyColumns?: string[];
  deleteMode?: "hard" | "soft";
  partitioning?: CdcEntityLayout["partitioning"];
  clustering?: CdcEntityLayout["clustering"];
}): CdcEntityLayout {
  return {
    entity: params.entity,
    tableName: params.tableName,
    keyColumns:
      params.keyColumns && params.keyColumns.length > 0
        ? params.keyColumns
        : ["id", "_dataSourceId"],
    deleteMode: params.deleteMode,
    partitioning: params.partitioning,
    clustering: params.clustering,
  };
}
