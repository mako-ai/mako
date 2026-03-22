import type {
  CdcDestinationAdapter,
  CdcEntityLayout,
} from "../contracts/adapters";
import { BigQueryDestinationAdapter } from "./bigquery.adapter";
import { PostgreSqlDestinationAdapter } from "./postgresql.adapter";

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
    return new BigQueryDestinationAdapter();
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
