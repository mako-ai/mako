/**
 * Destination row counts per CDC entity, batched into one driver query and
 * cached briefly (counting can be slow on BigQuery).
 */
import { databaseRegistry } from "../databases/registry";
import { loggers } from "../logging";
import { cdcLiveTableName } from "../sync-cdc/normalization";

const logger = loggers.inngest("flow");

const DESTINATION_COUNT_CACHE_TTL_MS = 60_000;
const destinationCountBatchCache = new Map<
  string,
  { value: Record<string, number | null>; expiresAt: number }
>();

function isTableMissingError(errorMessage?: string): boolean {
  const value = String(errorMessage || "").toLowerCase();
  const isPostgresMissingRelation =
    value.includes("relation") && value.includes("does not exist");
  return (
    value.includes("not found") ||
    value.includes("does not exist") ||
    value.includes("unknown table") ||
    isPostgresMissingRelation ||
    value.includes("no such table")
  );
}

export async function getDestinationEntityRowCountsBatch(params: {
  workspaceId: string;
  flowId: string;
  entities: string[];
  destinationType?: string;
  destination: any;
  schema: string;
  baseTablePrefix?: string;
}): Promise<Record<string, number | null>> {
  const sortedEntities = [...params.entities].sort();
  const cacheKey = [
    params.workspaceId,
    params.flowId,
    params.destinationType || "",
    params.schema,
    params.baseTablePrefix || "",
    String((params.destination as any)?.connection?.project_id || ""),
    sortedEntities.join("|"),
  ].join(":");
  const cached = destinationCountBatchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const empty: Record<string, number | null> = {};
  for (const entity of params.entities) empty[entity] = null;

  if (params.entities.length === 0) {
    destinationCountBatchCache.set(cacheKey, {
      value: empty,
      expiresAt: Date.now() + DESTINATION_COUNT_CACHE_TTL_MS,
    });
    return empty;
  }

  // Map each entity to its destination table name, keep both directions.
  const tableToEntity = new Map<string, string>();
  const tableNames: string[] = [];
  for (const entity of params.entities) {
    const tableName = cdcLiveTableName(
      params.baseTablePrefix,
      entity,
      params.flowId,
    );
    tableToEntity.set(tableName, entity);
    tableNames.push(tableName);
  }

  const driver = databaseRegistry.getDriver(params.destination.type);
  const query = driver?.buildRowCountBatchQuery?.(params.schema, tableNames, {
    projectId: (params.destination as any)?.connection?.project_id,
  });
  if (!driver?.executeQuery || !query) {
    destinationCountBatchCache.set(cacheKey, {
      value: empty,
      expiresAt: Date.now() + DESTINATION_COUNT_CACHE_TTL_MS,
    });
    return empty;
  }

  // Default everything to 0 — if a table doesn't appear in __TABLES__/pg_class,
  // it doesn't exist yet, which is semantically the same as "0 rows".
  const result: Record<string, number | null> = {};
  for (const entity of params.entities) result[entity] = 0;

  // For MongoDB the tableDestination "schema" IS the target database name and
  // the count expression runs against the connection's active db, so it must
  // be routed explicitly. SQL engines fully qualify inside the query instead.
  const isMongoDestination =
    String(params.destination.type || "").toLowerCase() === "mongodb";

  try {
    const queryResult = await driver.executeQuery(
      params.destination,
      query,
      isMongoDestination ? { databaseName: params.schema } : undefined,
    );
    if (!queryResult.success) {
      if (isTableMissingError(queryResult.error)) {
        destinationCountBatchCache.set(cacheKey, {
          value: result,
          expiresAt: Date.now() + DESTINATION_COUNT_CACHE_TTL_MS,
        });
        return result;
      }
      logger.warn("Failed to count destination rows for CDC flow", {
        flowId: params.flowId,
        destinationType: params.destinationType,
        error: queryResult.error,
      });
      destinationCountBatchCache.set(cacheKey, {
        value: empty,
        expiresAt: Date.now() + DESTINATION_COUNT_CACHE_TTL_MS,
      });
      return empty;
    }

    if (Array.isArray(queryResult.data)) {
      for (const row of queryResult.data as Array<Record<string, unknown>>) {
        const tableId = String(row.table_id ?? row.tableId ?? "");
        const entity = tableToEntity.get(tableId);
        if (!entity) continue;
        const raw = row.row_count ?? row.rowCount ?? row.total_count;
        const parsed = Number(raw);
        result[entity] = Number.isFinite(parsed) ? parsed : null;
      }
    }

    destinationCountBatchCache.set(cacheKey, {
      value: result,
      expiresAt: Date.now() + DESTINATION_COUNT_CACHE_TTL_MS,
    });
    return result;
  } catch (error) {
    logger.warn("Destination row count batch query errored", {
      flowId: params.flowId,
      destinationType: params.destinationType,
      error: error instanceof Error ? error.message : String(error),
    });
    destinationCountBatchCache.set(cacheKey, {
      value: empty,
      expiresAt: Date.now() + DESTINATION_COUNT_CACHE_TTL_MS,
    });
    return empty;
  }
}

/**
 * Drop every cached count for one flow. The cache keys one entry per
 * (workspace, flow, sorted entity list), so a reset entity table must clear
 * them all for the next read to see the truncation.
 */
export function invalidateDestinationCounts(
  workspaceId: string,
  flowId: string,
): void {
  for (const key of destinationCountBatchCache.keys()) {
    if (key.startsWith(`${workspaceId}:${flowId}:`)) {
      destinationCountBatchCache.delete(key);
    }
  }
}
