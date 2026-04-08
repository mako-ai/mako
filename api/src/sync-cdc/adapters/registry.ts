import type {
  IFlow,
  ITablePartitioning,
  ITableClustering,
} from "../../database/workspace-schema";
import type { CdcStoredEvent } from "../events";
import type { ConnectorEntitySchema } from "../../connectors/base/BaseConnector";
import { BigQueryDestinationAdapter } from "./bigquery";
import { ClickHouseDestinationAdapter } from "./clickhouse";
import { MongoDbDestinationAdapter } from "./mongodb";
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
    entitySchema?: ConnectorEntitySchema;
  }): Promise<{ applied: number }>;
  applyBatch(params: {
    records: Array<Record<string, unknown>>;
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
    entitySchema?: ConnectorEntitySchema;
  }): Promise<{ written: number }>;

  loadStagingFromParquet?(
    parquetPath: string,
    layout: CdcEntityLayout,
    flowId: string,
    options?: { stagingSuffix?: string; skipDrop?: boolean },
  ): Promise<{ loaded: number }>;
  mergeFromStaging?(
    layout: CdcEntityLayout,
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">,
    flowId: string,
    entitySchema?: ConnectorEntitySchema,
    options?: { stagingSuffix?: string },
  ): Promise<{ written: number }>;
  cleanupStaging?(
    layout: CdcEntityLayout,
    flowId: string,
    options?: { stagingSuffix?: string },
  ): Promise<void>;
  prepareStaging?(
    layout: CdcEntityLayout,
    flowId: string,
    options?: { stagingSuffix?: string },
  ): Promise<void>;
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

  if (normalizedType === "clickhouse") {
    return new ClickHouseDestinationAdapter({
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

  if (normalizedType === "mongodb") {
    return new MongoDbDestinationAdapter({
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
  return (
    normalizedType === "bigquery" ||
    normalizedType === "clickhouse" ||
    normalizedType === "postgresql" ||
    normalizedType === "mongodb"
  );
}

export function hasStagingSupport(
  adapter?: CdcDestinationAdapter,
): adapter is CdcDestinationAdapter & {
  loadStagingFromParquet: NonNullable<
    CdcDestinationAdapter["loadStagingFromParquet"]
  >;
  mergeFromStaging: NonNullable<CdcDestinationAdapter["mergeFromStaging"]>;
  cleanupStaging: NonNullable<CdcDestinationAdapter["cleanupStaging"]>;
  prepareStaging: NonNullable<CdcDestinationAdapter["prepareStaging"]>;
} {
  return Boolean(
    adapter?.loadStagingFromParquet &&
      adapter?.mergeFromStaging &&
      adapter?.cleanupStaging &&
      adapter?.prepareStaging,
  );
}

export function resolveEntityPartitioning(
  entityLayout?: { partitionField?: string; partitionGranularity?: string },
  tableDestination?: ITablePartitioning,
): CdcEntityLayout["partitioning"] {
  if (entityLayout?.partitionField) {
    return {
      type: "time",
      field: entityLayout.partitionField,
      granularity:
        (entityLayout.partitionGranularity as
          | "day"
          | "hour"
          | "month"
          | "year") || "day",
      requirePartitionFilter: tableDestination?.requirePartitionFilter,
    };
  }
  if (tableDestination?.enabled) {
    return {
      type: tableDestination.type || "time",
      field:
        tableDestination.type === "ingestion"
          ? "_syncedAt"
          : tableDestination.field || "_syncedAt",
      granularity: tableDestination.granularity || "day",
      requirePartitionFilter: tableDestination.requirePartitionFilter,
    };
  }
  return undefined;
}

export function resolveEntityClustering(
  entityLayout?: { clusterFields?: string[] },
  tableDestination?: ITableClustering,
): CdcEntityLayout["clustering"] {
  if (entityLayout?.clusterFields?.length) {
    return { fields: entityLayout.clusterFields };
  }
  if (tableDestination?.enabled && tableDestination.fields?.length) {
    return { fields: tableDestination.fields };
  }
  return undefined;
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
