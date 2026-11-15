/**
 * Pure pieces of the database-to-database flow form: pre-save validation,
 * the generated flow name and the save payload.
 */
import type { FormData } from "./db-flow-config";

/** The first reason the form cannot be saved, or null when it can be. */
export function validateDbFlow(data: FormData): string | null {
  if (!data.databaseSource.query.trim()) {
    return "SQL query is required";
  }
  if (!data.tableDestination.tableName.trim()) {
    return "Destination table name is required";
  }
  if (
    data.syncMode === "incremental" &&
    !data.incrementalConfig?.trackingColumn?.trim()
  ) {
    return "Tracking column is required for incremental sync";
  }
  return null;
}

interface NamedConnection {
  id: string;
  name: string;
}

/** "source[/db] → dest[/db]:table", from the selected connections. */
export function dbFlowName(
  data: FormData,
  source: NamedConnection | undefined,
  dest: NamedConnection | undefined,
): string {
  const sourceName = data.databaseSource.database
    ? `${source?.name}/${data.databaseSource.database}`
    : source?.name || "Source";
  const destName = data.tableDestination.database
    ? `${dest?.name}/${data.tableDestination.database}`
    : dest?.name || "Destination";
  return `${sourceName} → ${destName}:${data.tableDestination.tableName}`;
}

/** The create/update body; the form's nested shape matches the API's. */
export function buildDbFlowPayload(data: FormData, name: string) {
  const payload: Record<string, unknown> = {
    name,
    type: "scheduled",
    sourceType: "database",
    databaseSource: {
      connectionId: data.databaseSource.connectionId,
      database: data.databaseSource.database || undefined,
      query: data.databaseSource.query.trim(),
    },
    tableDestination: {
      connectionId: data.tableDestination.connectionId,
      database: data.tableDestination.database || undefined,
      schema: data.tableDestination.schema || undefined,
      tableName: data.tableDestination.tableName.trim(),
      createIfNotExists: data.tableDestination.createIfNotExists,
    },
    schedule: {
      enabled: data.schedule.enabled,
      cron: data.schedule.enabled ? data.schedule.cron : undefined,
      timezone: data.schedule.enabled ? data.schedule.timezone : undefined,
    },
    syncMode: data.syncMode,
    batchSize: data.batchSize,
  };

  if (
    data.syncMode === "incremental" &&
    data.incrementalConfig?.trackingColumn
  ) {
    payload.incrementalConfig = {
      trackingColumn: data.incrementalConfig.trackingColumn.trim(),
      trackingType: data.incrementalConfig.trackingType || "timestamp",
    };
  }

  if (data.conflictConfig && data.conflictConfig.keyColumns.length > 0) {
    payload.conflictConfig = {
      keyColumns: data.conflictConfig.keyColumns,
      strategy: data.conflictConfig.strategy,
    };
  }

  if (data.paginationConfig) {
    payload.paginationConfig =
      data.paginationConfig.mode === "keyset" &&
      data.paginationConfig.keysetColumn
        ? {
            mode: "keyset",
            keysetColumn: data.paginationConfig.keysetColumn.trim(),
            keysetDirection: data.paginationConfig.keysetDirection || "asc",
          }
        : { mode: "offset" };
  }

  if (data.typeCoercions && data.typeCoercions.length > 0) {
    payload.typeCoercions = data.typeCoercions;
  }

  return payload;
}
