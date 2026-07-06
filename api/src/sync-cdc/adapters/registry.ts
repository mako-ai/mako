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
import { MySqlDestinationAdapter } from "./mysql";

/** Airbyte-style destination write mode. Default: "append_dedup" (upsert). */
export type CdcWriteMode = "append_dedup" | "append" | "overwrite";

export interface CdcEntityLayout {
  entity: string;
  tableName: string;
  keyColumns: string[];
  deleteMode?: "hard" | "soft";
  writeMode?: CdcWriteMode;
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
  /**
   * Clear the live table at the start of a Full Refresh | Overwrite run.
   * Must be a no-op when the table does not exist yet.
   */
  truncateLiveTable?(layout: CdcEntityLayout): Promise<void>;
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
    options?: {
      stagingSuffix?: string;
      skipDrop?: boolean;
      skipParquetCleanup?: boolean;
    },
  ): Promise<{ loaded: number }>;
  mergeFromStaging?(
    layout: CdcEntityLayout,
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">,
    flowId: string,
    entitySchema?: ConnectorEntitySchema,
    options?: { stagingSuffix?: string; knownStagingRowCount?: number },
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

  /**
   * Rewrite an existing live table's partitioning/clustering in place by
   * copying its current rows into a freshly-laid-out table and atomically
   * swapping it in — avoiding a full re-fetch from the source. Returns
   * `repartitioned: false` when the live table does not exist yet (the caller
   * should fall back to a backfill). Throws on failure (caller falls back).
   * Only implemented for warehouses where partitioning/clustering is fixed at
   * CREATE (BigQuery, ClickHouse).
   */
  repartitionLiveTable?(layout: CdcEntityLayout): Promise<{
    repartitioned: boolean;
  }>;
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

  if (normalizedType === "mysql") {
    return new MySqlDestinationAdapter({
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
    normalizedType === "mysql" ||
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
  writeMode?: CdcWriteMode;
  partitioning?: CdcEntityLayout["partitioning"];
  clustering?: CdcEntityLayout["clustering"];
}): CdcEntityLayout {
  return {
    entity: params.entity,
    tableName: params.tableName,
    keyColumns:
      params.keyColumns && params.keyColumns.length > 0
        ? params.keyColumns
        : ["id"],
    deleteMode: params.deleteMode,
    writeMode: params.writeMode,
    partitioning: params.partitioning,
    clustering: params.clustering,
  };
}

/**
 * Airbyte-style: destinations declare which write modes they support.
 * ClickHouse lives on ReplacingMergeTree, which dedups by the ORDER BY key
 * at merge time — plain "append" / "overwrite" semantics can't be honored.
 */
export function supportedCdcWriteModes(
  destinationType?: string,
): CdcWriteMode[] {
  const normalizedType = (destinationType || "").toLowerCase();
  if (!hasCdcDestinationAdapter(normalizedType)) return [];
  if (normalizedType === "clickhouse") return ["append_dedup"];
  return ["append_dedup", "append", "overwrite"];
}
