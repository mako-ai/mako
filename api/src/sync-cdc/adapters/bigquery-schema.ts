/**
 * BigQuery live-table schema: the column-type cache, INFORMATION_SCHEMA
 * discovery for a MERGE, live-table creation, missing-column adds, and
 * in-place type evolution when a column drifted from the connector schema.
 */
import { createHash } from "crypto";
import type { ConnectorEntitySchema } from "../../connectors/base/BaseConnector";
import type { CdcEntityLayout, LiveTableDescription } from "./registry";
import {
  buildCastExpression,
  buildCreateLiveTableStatement,
  escId,
  type LiveTablePartitioning,
  mapLogicalTypeToBigQuery,
  resolveTargetBqType,
  sqlString,
} from "./bigquery-sql";
import {
  bqLog as log,
  fullTableName,
  retryOnQuota,
  runBigQuery,
  runBigQueryWrite,
  type BigQueryTarget,
} from "./bigquery-target";

// ---------------------------------------------------------------------------
// Schema cache — avoids redundant INFORMATION_SCHEMA queries across runs.
//
// Key: "projectId.dataset.tableName", Value: column→type map + timestamp.
// TTL default 5 min (same as scheduler interval). Entries auto-evict on read.
// ---------------------------------------------------------------------------

const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;

export interface SchemaCacheEntry {
  columns: Map<string, string>;
  fetchedAt: number;
  schemaHash?: string;
}

const schemaCache = new Map<string, SchemaCacheEntry>();

export function getSchemaCacheKey(
  projectId: string,
  dataset: string,
  table: string,
): string {
  return `${projectId}.${dataset}.${table}`;
}

export function getCachedSchema(key: string): SchemaCacheEntry | undefined {
  const entry = schemaCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > SCHEMA_CACHE_TTL_MS) {
    schemaCache.delete(key);
    return undefined;
  }
  return entry;
}

export function setCachedSchema(
  key: string,
  columns: Map<string, string>,
  schemaHash?: string,
): void {
  schemaCache.set(key, { columns, fetchedAt: Date.now(), schemaHash });
}

export function invalidateCachedSchema(key: string): void {
  schemaCache.delete(key);
  partitioningCache.delete(key);
}

// The live table's metadata (time partitioning, clustering), cached like the
// column types. A table that does not exist is never cached: it may be
// created a moment later.
const partitioningCache = new Map<
  string,
  { value: LiveTableDescription; fetchedAt: number }
>();

/**
 * The live table's partitioning and clustering from the tables API (a
 * metadata read, never billed), cached. `{ exists: false }` when the table
 * does not exist; undefined when the read fails.
 */
export async function getLiveTableMeta(
  target: BigQueryTarget,
  liveTable: string,
): Promise<LiveTableDescription | undefined> {
  const key = getSchemaCacheKey(target.projectId, target.dataset, liveTable);
  const cached = partitioningCache.get(key);
  if (cached && Date.now() - cached.fetchedAt <= SCHEMA_CACHE_TTL_MS) {
    return cached.value;
  }
  try {
    const [metadata] = await target.bq
      .dataset(target.dataset, { location: target.datasetLocation })
      .table(liveTable)
      .getMetadata();
    const m = metadata as {
      timePartitioning?: { field?: string; type?: string };
      rangePartitioning?: { field?: string };
      clustering?: { fields?: string[] };
    };
    const value: LiveTableDescription = {
      exists: true,
      timePartitioning: m.timePartitioning
        ? { field: m.timePartitioning.field, type: m.timePartitioning.type }
        : undefined,
      rangePartitionField: m.rangePartitioning?.field,
      clusterFields: m.clustering?.fields ?? [],
    };
    partitioningCache.set(key, { value, fetchedAt: Date.now() });
    return value;
  } catch (err) {
    if ((err as { code?: number } | null)?.code === 404) {
      return { exists: false, clusterFields: [] };
    }
    log.warn("Could not read the live table metadata", {
      liveTable,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * The live table's `timePartitioning` column. Returns null when the table is
 * not partitioned on a column, and undefined when the read fails or the table
 * does not exist.
 */
export async function getLiveTablePartitioning(
  target: BigQueryTarget,
  liveTable: string,
): Promise<LiveTablePartitioning | null | undefined> {
  const meta = await getLiveTableMeta(target, liveTable);
  if (!meta?.exists) return undefined;
  const tp = meta.timePartitioning;
  return tp?.field ? { field: tp.field, type: tp.type } : null;
}

export function hashEntitySchema(schema: ConnectorEntitySchema): string {
  const sorted = Object.entries(schema.fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, f]) => `${name}:${f.type}`)
    .join("|");
  return createHash("md5").update(sorted).digest("hex");
}

type InformationSchemaRow = {
  table_name?: string;
  column_name: string;
  data_type?: string;
};

const informationSchema = (target: BigQueryTarget) =>
  `${escId(target.projectId)}.${escId(target.dataset)}.INFORMATION_SCHEMA.COLUMNS`;

export interface MergeSchemas {
  stagingCols: Set<string>;
  liveCols: Set<string>;
  liveTypes: Map<string, string>;
  /** Live types came from the cache (no live INFORMATION_SCHEMA read). */
  schemaCacheHit: boolean;
  cachedLive: SchemaCacheEntry | undefined;
}

/**
 * Columns of the staging table (always read: it is ephemeral) and columns +
 * types of the live table (from the cache when fresh, else read with the
 * staging columns in one INFORMATION_SCHEMA query and cached).
 */
export async function discoverMergeSchemas(
  target: BigQueryTarget,
  liveTable: string,
  stagingTable: string,
): Promise<MergeSchemas> {
  const liveCacheKey = getSchemaCacheKey(
    target.projectId,
    target.dataset,
    liveTable,
  );
  const cachedLive = getCachedSchema(liveCacheKey);
  const stagingCols = new Set<string>();

  if (cachedLive && cachedLive.columns.size > 0) {
    const liveCols = new Set(cachedLive.columns.keys());
    const liveTypes = new Map(cachedLive.columns);

    const stagingResult = await runBigQuery(
      target,
      `SELECT column_name FROM ${informationSchema(target)} WHERE table_name = ${sqlString(stagingTable)}`,
    );
    if (!stagingResult.success) {
      throw new Error(
        `Staging schema discovery failed: ${stagingResult.error}`,
      );
    }
    for (const r of (stagingResult.data as InformationSchemaRow[]) || []) {
      stagingCols.add(r.column_name);
    }

    log.info("Schema cache hit for live table", {
      liveTable,
      stagingTable,
      liveCols: liveCols.size,
      stagingCols: stagingCols.size,
    });
    return {
      stagingCols,
      liveCols,
      liveTypes,
      schemaCacheHit: true,
      cachedLive,
    };
  }

  const liveCols = new Set<string>();
  const liveTypes = new Map<string, string>();

  const schemaResult = await runBigQuery(
    target,
    `SELECT table_name, column_name, data_type FROM ${informationSchema(target)} WHERE table_name IN (${sqlString(stagingTable)}, ${sqlString(liveTable)})`,
  );

  if (!schemaResult.success) {
    log.error("INFORMATION_SCHEMA query failed in mergeStagingToLive", {
      stagingTable,
      liveTable,
      dataset: target.dataset,
      error: schemaResult.error,
    });
    throw new Error(`Schema discovery failed: ${schemaResult.error}`);
  }

  for (const r of (schemaResult.data as InformationSchemaRow[]) || []) {
    const tbl = r.table_name as string;
    const col = r.column_name;
    const dt = r.data_type as string;
    if (tbl === liveTable) {
      liveCols.add(col);
      liveTypes.set(col, dt);
    } else if (tbl === stagingTable) {
      stagingCols.add(col);
    }
  }

  if (liveCols.size > 0) {
    setCachedSchema(liveCacheKey, new Map(liveTypes));
  }
  return {
    stagingCols,
    liveCols,
    liveTypes,
    schemaCacheHit: false,
    cachedLive,
  };
}

/**
 * Create the live table from the staging columns, typed by the schema
 * contract, then read its actual types back into `liveCols`/`liveTypes`.
 */
export async function createLiveTableFromStaging(
  target: BigQueryTarget,
  layout: CdcEntityLayout,
  stagingColumnNames: string[],
  entitySchema: ConnectorEntitySchema | undefined,
  live: { liveCols: Set<string>; liveTypes: Map<string, string> },
): Promise<void> {
  const liveTable = layout.tableName;
  const createResult = await runBigQuery(
    target,
    buildCreateLiveTableStatement({
      fullLive: fullTableName(target, liveTable),
      columns: stagingColumnNames,
      layout,
      entitySchema,
    }),
  );
  if (!createResult.success) {
    throw new Error(
      createResult.error || "Failed to create live table with schema",
    );
  }

  log.info("Created live table from schema", {
    liveTable,
    dataset: target.dataset,
    columnCount: stagingColumnNames.length,
  });

  const refreshResult = await runBigQuery(
    target,
    `SELECT column_name, data_type FROM ${informationSchema(target)} WHERE table_name = ${sqlString(liveTable)}`,
  );
  if (!refreshResult.success) {
    throw new Error(
      refreshResult.error ||
        "INFORMATION_SCHEMA refresh failed after creating live table",
    );
  }
  for (const r of (refreshResult.data as InformationSchemaRow[]) || []) {
    live.liveCols.add(r.column_name);
    live.liveTypes.set(r.column_name, r.data_type as string);
  }
  setCachedSchema(
    getSchemaCacheKey(target.projectId, target.dataset, liveTable),
    new Map(live.liveTypes),
  );
  log.info("Live table types loaded from INFORMATION_SCHEMA after CREATE", {
    liveTable,
    columnCount: live.liveCols.size,
  });
}

/**
 * `ADD COLUMN IF NOT EXISTS` every staging column the live table lacks.
 * A column that cannot be added is skipped (and so left out of the MERGE).
 * Returns the columns added and the ones skipped.
 */
export async function addMissingLiveColumns(
  target: BigQueryTarget,
  p: {
    fullLive: string;
    liveTable: string;
    missing: string[];
    entitySchema: ConnectorEntitySchema | undefined;
    liveCols: Set<string>;
    liveTypes: Map<string, string>;
  },
): Promise<{ added: string[]; skipped: string[] }> {
  const added: string[] = [];
  const skipped: string[] = [];
  for (const col of p.missing) {
    const colType = resolveTargetBqType(col, p.entitySchema, undefined);
    const addToLive = await runBigQuery(
      target,
      `ALTER TABLE ${p.fullLive} ADD COLUMN IF NOT EXISTS ${escId(col)} ${colType}`,
    );
    if (!addToLive.success) {
      skipped.push(col);
      log.warn("Skipping live column add; column will be omitted from MERGE", {
        liveTable: p.liveTable,
        column: col,
        error: addToLive.error,
      });
      continue;
    }
    p.liveCols.add(col);
    p.liveTypes.set(col, colType);
    added.push(col);
  }
  return { added, skipped };
}

// ---------------------------------------------------------------------------
// Schema evolution — correct drifted live-table column types before merge.
//
// Follows Airbyte's BigqueryDirectLoadNativeTableOperations pattern:
//   1. ADD a temp column with the correct type
//   2. UPDATE to SAFE_CAST existing data into the temp column
//   3. Atomically RENAME the old column to a backup and the temp to the real name
//   4. DROP the backup column
//
// If any step fails for a column, that column is skipped and the merge
// proceeds using the existing (drifted) live type for that column only.
// ---------------------------------------------------------------------------

export async function evolveSchemaIfNeeded(
  target: BigQueryTarget,
  params: {
    fullLive: string;
    liveTable: string;
    liveCols: Set<string>;
    liveTypes: Map<string, string>;
    entitySchema: ConnectorEntitySchema | undefined;
  },
): Promise<void> {
  const { fullLive, liveTable, liveCols, liveTypes, entitySchema } = params;
  if (!entitySchema) return;

  const drifted: Array<{
    column: string;
    actualType: string;
    expectedType: string;
  }> = [];

  for (const col of liveCols) {
    const schemaField = entitySchema.fields[col];
    if (!schemaField) continue;
    const expectedType = mapLogicalTypeToBigQuery(schemaField.type);
    const actualType = liveTypes.get(col);
    if (!actualType) continue;
    if (actualType.toUpperCase() === expectedType.toUpperCase()) continue;
    drifted.push({ column: col, actualType, expectedType });
  }

  if (drifted.length === 0) return;

  log.info("Schema drift detected, attempting live-table evolution", {
    liveTable,
    drifted: drifted.map(
      d => `${d.column}: ${d.actualType} -> ${d.expectedType}`,
    ),
  });

  /** One evolution step, retried on quota errors. */
  const step = (
    label: string,
    sql: string,
    failure: string,
    run: typeof runBigQuery = runBigQuery,
  ) =>
    retryOnQuota(
      async () => {
        const r = await run(target, sql);
        if (!r.success) throw new Error(r.error || failure);
      },
      { label },
    );

  const evolved: string[] = [];
  const skipped: string[] = [];

  for (const { column, actualType, expectedType } of drifted) {
    const tmpCol = `${column}_mako_tmp`;
    const bakCol = `${column}_mako_bak`;

    try {
      await step(
        `evolveSchema:ADD(${column})`,
        `ALTER TABLE ${fullLive} ADD COLUMN IF NOT EXISTS ${escId(tmpCol)} ${expectedType}`,
        "ADD COLUMN failed",
      );
      await step(
        `evolveSchema:UPDATE(${column})`,
        `UPDATE ${fullLive} SET ${escId(tmpCol)} = ${buildCastExpression(escId(column), expectedType)} WHERE 1=1`,
        "UPDATE cast failed",
        runBigQueryWrite,
      );
      await step(
        `evolveSchema:RENAME(${column})`,
        `ALTER TABLE ${fullLive} RENAME COLUMN ${escId(column)} TO ${escId(bakCol)}, RENAME COLUMN ${escId(tmpCol)} TO ${escId(column)}`,
        "RENAME COLUMN failed",
      );
      await step(
        `evolveSchema:DROP(${column})`,
        `ALTER TABLE ${fullLive} DROP COLUMN IF EXISTS ${escId(bakCol)}`,
        "DROP COLUMN failed",
      );

      liveTypes.set(column, expectedType);
      evolved.push(column);
      log.info("Schema evolution applied", {
        liveTable,
        column,
        from: actualType,
        to: expectedType,
      });
    } catch (err) {
      skipped.push(column);
      log.warn(
        "Schema evolution failed for column; merge will use existing live type",
        {
          liveTable,
          column,
          from: actualType,
          to: expectedType,
          error: err instanceof Error ? err.message : String(err),
        },
      );

      // Best-effort cleanup of leftover temp/backup columns
      for (const leftover of [tmpCol, bakCol]) {
        try {
          await runBigQuery(
            target,
            `ALTER TABLE ${fullLive} DROP COLUMN IF EXISTS ${escId(leftover)}`,
          );
        } catch {
          // ignore cleanup failures
        }
      }
    }
  }

  if (evolved.length > 0 || skipped.length > 0) {
    log.info("Schema evolution summary", {
      liveTable,
      evolved,
      skipped,
      total: drifted.length,
    });
  }
}
