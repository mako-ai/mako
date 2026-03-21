import type {
  CdcDestinationAdapter,
  CdcEntityLayout,
} from "../contracts/destination-adapter";
import { BigQueryDestinationAdapter } from "./bigquery.adapter";

type DestinationAdapterFactory = (params: {
  destinationDatabaseId: string;
  destinationDatabaseName?: string;
  tableDestination: {
    connectionId: string;
    schema: string;
    tableName: string;
  };
}) => CdcDestinationAdapter;

const destinationAdapterFactories = new Map<
  string,
  DestinationAdapterFactory
>();

export function registerCdcDestinationAdapter(
  destinationType: string,
  factory: DestinationAdapterFactory,
) {
  destinationAdapterFactories.set(destinationType, factory);
}

registerCdcDestinationAdapter("bigquery", params => {
  return new BigQueryDestinationAdapter({
    destinationDatabaseId: params.destinationDatabaseId,
    destinationDatabaseName: params.destinationDatabaseName,
    tableDestination: params.tableDestination,
  });
});

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
  const factory = destinationAdapterFactories.get(params.destinationType);
  if (!factory) {
    throw new Error(
      `No CDC destination adapter registered for type '${params.destinationType}'`,
    );
  }

  return factory({
    destinationDatabaseId: params.destinationDatabaseId,
    destinationDatabaseName: params.destinationDatabaseName,
    tableDestination: params.tableDestination,
  });
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
