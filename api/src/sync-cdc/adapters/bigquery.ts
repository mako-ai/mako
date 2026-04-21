import { promises as fs } from "fs";
import { BigQuery } from "@google-cloud/bigquery";
import {
  DatabaseConnection,
  type IFlow,
  type IDatabaseConnection,
} from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { loggers } from "../../logging";
import {
  buildParquetFromBatches,
  type FieldMeta,
} from "../../utils/streaming-parquet-builder";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
  selectLatestChangePerRecord,
} from "../normalization";
import type { CdcStoredEvent } from "../events";
import type { CdcDestinationAdapter, CdcEntityLayout } from "./registry";
import { createHash } from "crypto";
import type {
  ConnectorEntitySchema,
  ConnectorLogicalType,
} from "../../connectors/base/BaseConnector";

// ---------------------------------------------------------------------------
// Schema cache — avoids redundant INFORMATION_SCHEMA queries across runs.
//
// Key: "projectId.dataset.tableName", Value: column→type map + timestamp.
// TTL default 5 min (same as scheduler interval). Entries auto-evict on read.
// ---------------------------------------------------------------------------

const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000;

interface SchemaCacheEntry {
  columns: Map<string, string>;
  fetchedAt: number;
  schemaHash?: string;
}

const schemaCache = new Map<string, SchemaCacheEntry>();

function getSchemaCacheKey(
  projectId: string,
  dataset: string,
  table: string,
): string {
  return `${projectId}.${dataset}.${table}`;
}

function getCachedSchema(key: string): SchemaCacheEntry | undefined {
  const entry = schemaCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > SCHEMA_CACHE_TTL_MS) {
    schemaCache.delete(key);
    return undefined;
  }
  return entry;
}

function setCachedSchema(
  key: string,
  columns: Map<string, string>,
  schemaHash?: string,
): void {
  schemaCache.set(key, { columns, fetchedAt: Date.now(), schemaHash });
}

function invalidateCachedSchema(key: string): void {
  schemaCache.delete(key);
}

function hashEntitySchema(schema: ConnectorEntitySchema): string {
  const sorted = Object.entries(schema.fields)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, f]) => `${name}:${f.type}`)
    .join("|");
  return createHash("md5").update(sorted).digest("hex");
}

// ---------------------------------------------------------------------------
// Retry helper for BigQuery quota / rate-limit errors (HTTP 403 rateLimitExceeded,
// 429 quotaExceeded, or error messages mentioning "quota").
// ---------------------------------------------------------------------------

function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("ratelimitexceeded") ||
    msg.includes("exceeded") ||
    /exceeded.*quota|quota.*exceeded/i.test(err.message)
  );
}

async function retryOnQuota<T>(
  fn: () => Promise<T>,
  opts: { label: string; maxRetries?: number } = { label: "BigQuery op" },
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isQuotaError(err)) throw err;
      const backoffMs = Math.min(30_000, 5_000 * 2 ** attempt);
      log.warn(`${opts.label}: quota error, retrying in ${backoffMs}ms`, {
        attempt: attempt + 1,
        maxRetries,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}

// ---------------------------------------------------------------------------
// Schema contract: one source of truth for BigQuery column types.
// Staging is always VARCHAR (from Parquet). Live table uses these types.
// INSERT SELECT casts VARCHAR staging → typed live columns.
// ---------------------------------------------------------------------------

export function mapLogicalTypeToBigQuery(
  logicalType: ConnectorLogicalType,
): string {
  switch (logicalType) {
    case "string":
      return "STRING";
    case "number":
      return "FLOAT64";
    case "integer":
      return "INT64";
    case "boolean":
      return "BOOL";
    case "timestamp":
      return "TIMESTAMP";
    case "json":
      return "JSON";
    default:
      return "STRING";
  }
}

const SYSTEM_COLUMN_TYPES: Record<string, string> = {
  _mako_ingest_seq: "INT64",
  _mako_source_ts: "TIMESTAMP",
  _mako_deleted_at: "TIMESTAMP",
  is_deleted: "BOOL",
  deleted_at: "TIMESTAMP",
};

function resolveTargetBqType(
  column: string,
  entitySchema: ConnectorEntitySchema | undefined,
  liveType: string | undefined,
): string {
  // After evolveSchemaIfNeeded(), liveType already reflects the corrected type.
  if (liveType) return liveType;
  const schemaField = entitySchema?.fields[column];
  if (schemaField) return mapLogicalTypeToBigQuery(schemaField.type);
  if (SYSTEM_COLUMN_TYPES[column]) return SYSTEM_COLUMN_TYPES[column];
  return "STRING";
}

function buildCastExpression(colRef: string, targetType: string): string {
  switch (targetType.toUpperCase()) {
    case "JSON":
      return `SAFE.PARSE_JSON(${colRef})`;
    case "TIMESTAMP":
      return `SAFE_CAST(${colRef} AS TIMESTAMP)`;
    case "BOOL":
      return `SAFE_CAST(${colRef} AS BOOL)`;
    case "INT64":
      return `SAFE_CAST(${colRef} AS INT64)`;
    case "FLOAT64":
      return `SAFE_CAST(${colRef} AS FLOAT64)`;
    case "STRING":
      return `SAFE_CAST(${colRef} AS STRING)`;
    default:
      return colRef;
  }
}

function buildColumnSelectExpr(
  column: string,
  escId: (id: string) => string,
  entitySchema: ConnectorEntitySchema | undefined,
  liveType: string | undefined,
): string {
  const colRef = escId(column);
  const targetType = resolveTargetBqType(column, entitySchema, liveType);
  return `${buildCastExpression(colRef, targetType)} AS ${colRef}`;
}

const log = loggers.sync("cdc.adapter.bigquery");

const escId = (id: string) => `\`${id.replace(/`/g, "\\`")}\``;

// ---------------------------------------------------------------------------
// Pure MERGE statement builder.
// ---------------------------------------------------------------------------

interface BuildMergeStatementParams {
  fullLive: string;
  fullStaging: string;
  /** All columns on the live table. */
  columns: string[];
  keyColumns: string[];
  /** Columns physically present in the staging table. */
  stagingCols: Set<string>;
  /** Live-table column types from INFORMATION_SCHEMA. */
  liveTypes: Map<string, string>;
  entitySchema?: ConnectorEntitySchema;
}

function buildMergeStatement(p: BuildMergeStatementParams): string {
  const {
    fullLive,
    fullStaging,
    columns,
    keyColumns,
    stagingCols,
    liveTypes,
    entitySchema,
  } = p;

  // Only consider staging cols that also exist on live (an ALTER TABLE add may
  // have been skipped earlier). Referencing a non-live col in UPDATE SET would
  // make the MERGE fail with "unrecognized name".
  const liveColsSet = new Set(columns);
  const effectiveStagingCols = [...stagingCols].filter(c => liveColsSet.has(c));
  const effectiveStagingSet = new Set(effectiveStagingCols);

  const dedupKey = keyColumns.map(escId).join(", ");
  const hasStagingSourceTs = effectiveStagingSet.has("_mako_source_ts");
  const hasStagingIngestSeq = effectiveStagingSet.has("_mako_ingest_seq");
  const orderExpr = hasStagingSourceTs
    ? `${escId("_mako_source_ts")} DESC`
    : hasStagingIngestSeq
      ? `${escId("_mako_ingest_seq")} DESC`
      : "1";

  // USING subquery: SELECT staging columns (cast to live types) with dedup by
  // key keeping the newest record per ordering expression.
  const stagingSelectCols = effectiveStagingCols
    .map(c => buildColumnSelectExpr(c, escId, entitySchema, liveTypes.get(c)))
    .join(", ");

  const usingSubquery = `(SELECT ${stagingSelectCols} FROM ${fullStaging} QUALIFY ROW_NUMBER() OVER (PARTITION BY ${dedupKey} ORDER BY ${orderExpr}) = 1)`;

  // ON clause
  const keyJoin = keyColumns
    .map(k => `__live.${escId(k)} = __stg.${escId(k)}`)
    .join(" AND ");

  // WHEN MATCHED — only UPDATE columns present in staging (excluding keys).
  // Columns that exist on live but not in staging are left untouched.
  const updateColumns = effectiveStagingCols.filter(
    c => !keyColumns.includes(c),
  );

  // Ordering guard: don't let stale events overwrite newer live data.
  const hasSourceOrdering =
    hasStagingSourceTs && !keyColumns.includes("_mako_source_ts");
  const hasIngestOrdering =
    hasStagingIngestSeq && !keyColumns.includes("_mako_ingest_seq");
  const matchedGuard = hasSourceOrdering
    ? ` AND COALESCE(__stg.${escId("_mako_source_ts")}, TIMESTAMP('1970-01-01 00:00:00 UTC')) >= COALESCE(__live.${escId("_mako_source_ts")}, TIMESTAMP('1970-01-01 00:00:00 UTC'))`
    : hasIngestOrdering
      ? ` AND COALESCE(__stg.${escId("_mako_ingest_seq")}, -1) >= COALESCE(__live.${escId("_mako_ingest_seq")}, -1)`
      : "";

  const matchedClause =
    updateColumns.length > 0
      ? `WHEN MATCHED${matchedGuard} THEN UPDATE SET ${updateColumns.map(c => `${escId(c)} = __stg.${escId(c)}`).join(", ")}`
      : "";

  // WHEN NOT MATCHED — INSERT all live columns; columns missing from staging
  // get CAST(NULL AS T) (nothing to preserve for brand-new rows).
  const insertColList = columns.map(escId).join(", ");
  const insertValues = columns
    .map(c => {
      if (!effectiveStagingSet.has(c)) {
        const targetType = resolveTargetBqType(
          c,
          entitySchema,
          liveTypes.get(c),
        );
        return `CAST(NULL AS ${targetType})`;
      }
      return `__stg.${escId(c)}`;
    })
    .join(", ");

  return [
    `MERGE INTO ${fullLive} __live`,
    `USING ${usingSubquery} __stg`,
    `ON ${keyJoin}`,
    matchedClause,
    `WHEN NOT MATCHED THEN INSERT (${insertColList}) VALUES (${insertValues})`,
  ]
    .filter(Boolean)
    .join("\n");
}

interface BigQueryAdapterConfig {
  destinationDatabaseId: string;
  destinationDatabaseName?: string;
  tableDestination: {
    connectionId: string;
    schema: string;
    tableName: string;
  };
}

export class BigQueryDestinationAdapter implements CdcDestinationAdapter {
  readonly destinationType = "bigquery";

  constructor(private readonly config: BigQueryAdapterConfig) {}

  private coerceToDate(value: unknown): Date | null {
    if (value == null) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const epochMs = value > 1e12 ? value : value * 1000;
      const parsed = new Date(epochMs);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    const parsed = new Date(String(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  async ensureLiveTable(_layout: CdcEntityLayout): Promise<void> {
    await this.ensureDataset();
  }

  private async ensureLiveTableFromSchema(
    layout: CdcEntityLayout,
    stagingColumnNames: string[],
    entitySchema?: ConnectorEntitySchema,
  ): Promise<void> {
    const { projectId, dataset, destination, datasetLocation } =
      await this.resolveBqClient();
    const fullLive = `${escId(projectId)}.${escId(dataset)}.${escId(layout.tableName)}`;

    const colDefs = stagingColumnNames
      .map(col => {
        const bqType = resolveTargetBqType(col, entitySchema, undefined);
        return `${escId(col)} ${bqType}`;
      })
      .join(", ");

    let partitionClause = "";
    if (layout.partitioning?.field) {
      const gran = layout.partitioning.granularity?.toUpperCase() || "DAY";
      partitionClause = `PARTITION BY TIMESTAMP_TRUNC(${escId(layout.partitioning.field)}, ${gran})`;
    }
    let clusterClause = "";
    if (layout.clustering?.fields?.length) {
      clusterClause = `CLUSTER BY ${layout.clustering.fields.map(escId).join(", ")}`;
    }

    const ddl = `CREATE TABLE IF NOT EXISTS ${fullLive} (${colDefs}) ${partitionClause} ${clusterClause}`;
    const createResult = await databaseConnectionService.executeQuery(
      destination,
      ddl,
      { location: datasetLocation },
    );
    if (!createResult.success) {
      throw new Error(
        createResult.error || "Failed to create live table with schema",
      );
    }

    log.info("Created live table from schema", {
      liveTable: layout.tableName,
      dataset,
      columnCount: stagingColumnNames.length,
    });
  }

  async applyEvents(params: {
    events: CdcStoredEvent[];
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
    entitySchema?: ConnectorEntitySchema;
  }): Promise<{ applied: number }> {
    if (params.events.length === 0) {
      return { applied: 0 };
    }

    const latest = selectLatestChangePerRecord(params.events);
    const fallbackDataSourceId = params.flow.dataSourceId
      ? String(params.flow.dataSourceId)
      : undefined;
    const upserts = latest.filter(event => event.operation === "upsert");
    const deletes = latest.filter(event => event.operation === "delete");
    const deleteMode =
      params.flow.deleteMode || params.layout.deleteMode || "hard";

    const rows: Record<string, unknown>[] = [];

    for (const event of upserts) {
      const payload = normalizePayloadKeys(event.payload || {});
      const sourceTs = resolveSourceTimestamp(
        payload,
        new Date(event.sourceTs),
      );
      rows.push({
        ...payload,
        id: event.recordId,
        _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
        _mako_source_ts: sourceTs,
        _mako_ingest_seq: Number(event.ingestSeq),
        _mako_deleted_at: null,
        is_deleted: false,
        deleted_at: null,
      });
    }

    if (deleteMode === "soft") {
      for (const event of deletes) {
        const payload = normalizePayloadKeys(event.payload || {});
        const sourceTs = resolveSourceTimestamp(
          payload,
          new Date(event.sourceTs),
        );
        const deletedAt = new Date();
        rows.push({
          ...payload,
          id: event.recordId,
          _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
          _mako_source_ts: sourceTs,
          _mako_ingest_seq: Number(event.ingestSeq),
          _mako_deleted_at: deletedAt,
          is_deleted: true,
          deleted_at: deletedAt,
        });
      }
    }

    if (rows.length > 0) {
      await this.writeViaParquet({
        records: rows,
        layout: params.layout,
        flow: params.flow,
        entitySchema: params.entitySchema,
      });
    }

    if (deleteMode === "hard" && deletes.length > 0) {
      await this.hardDeleteBatch(params.layout, deletes, fallbackDataSourceId);
    }

    return { applied: latest.length };
  }

  async applyBatch(params: {
    records: Array<Record<string, unknown>>;
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
    entitySchema?: ConnectorEntitySchema;
  }): Promise<{ written: number }> {
    if (params.records.length === 0) {
      return { written: 0 };
    }

    const fallbackDataSourceId = params.flow.dataSourceId
      ? String(params.flow.dataSourceId)
      : undefined;

    const rows = params.records.map(record => {
      const payload = normalizePayloadKeys(record || {});
      const {
        deleted_at: _ignoredDeletedAt,
        deletedAt: _ignoredDeletedAtCamel,
        date_deleted: _ignoredDateDeleted,
        ...payloadWithoutDeletedAt
      } = payload as Record<string, unknown> & {
        deletedAt?: unknown;
        date_deleted?: unknown;
      };
      const makoDeletedAt = this.coerceToDate(payload._mako_deleted_at);
      return {
        ...payloadWithoutDeletedAt,
        _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
        _mako_source_ts: resolveSourceTimestamp(payload),
        _mako_ingest_seq:
          typeof payload._mako_ingest_seq === "number"
            ? payload._mako_ingest_seq
            : undefined,
        _mako_deleted_at: makoDeletedAt,
        deleted_at: makoDeletedAt,
      };
    });

    return this.writeViaParquet({
      records: rows,
      layout: params.layout,
      flow: params.flow,
      entitySchema: params.entitySchema,
    });
  }

  async loadStagingFromParquet(
    parquetPath: string,
    layout: CdcEntityLayout,
    flowId: string,
    options?: {
      stagingSuffix?: string;
      skipDrop?: boolean;
      skipParquetCleanup?: boolean;
    },
  ): Promise<{ loaded: number }> {
    await this.ensureDataset();
    const stagingTable = this.getStagingTableName(
      layout.tableName,
      flowId,
      options?.stagingSuffix,
    );
    if (!options?.skipDrop) {
      await this.dropStagingTable(stagingTable).catch(() => undefined);
    }
    return this.loadParquetToStaging(parquetPath, stagingTable, {
      skipParquetCleanup: options?.skipParquetCleanup,
    });
  }

  async mergeFromStaging(
    layout: CdcEntityLayout,
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">,
    flowId: string,
    entitySchema?: ConnectorEntitySchema,
    options?: { stagingSuffix?: string; knownStagingRowCount?: number },
  ): Promise<{ written: number }> {
    const stagingTable = this.getStagingTableName(
      layout.tableName,
      flowId,
      options?.stagingSuffix,
    );
    return this.mergeStagingToLive(layout, stagingTable, entitySchema, {
      knownStagingRowCount: options?.knownStagingRowCount,
    });
  }

  private async mergeStagingToLive(
    layout: CdcEntityLayout,
    stagingTable: string,
    entitySchema?: ConnectorEntitySchema,
    options?: { knownStagingRowCount?: number },
  ): Promise<{ written: number }> {
    const { projectId, dataset, destination, datasetLocation } =
      await this.resolveBqClient();
    const liveTable = layout.tableName;

    const fullLive = `${escId(projectId)}.${escId(dataset)}.${escId(liveTable)}`;
    const fullStaging = `${escId(projectId)}.${escId(dataset)}.${escId(stagingTable)}`;

    const liveCacheKey = getSchemaCacheKey(projectId, dataset, liveTable);
    const cachedLive = getCachedSchema(liveCacheKey);

    // Always query staging schema (ephemeral table, not cacheable) but try
    // to reuse cached live schema to avoid the INFORMATION_SCHEMA round-trip.
    const stagingCols = new Set<string>();
    let liveCols: Set<string>;
    let liveTypes: Map<string, string>;
    let schemaCacheHit = false;

    if (cachedLive && cachedLive.columns.size > 0) {
      schemaCacheHit = true;
      liveCols = new Set(cachedLive.columns.keys());
      liveTypes = new Map(cachedLive.columns);

      const stagingSchemaQuery = `SELECT column_name FROM ${escId(projectId)}.${escId(dataset)}.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${stagingTable.replace(/'/g, "''")}'`;
      const stagingResult = await databaseConnectionService.executeQuery(
        destination,
        stagingSchemaQuery,
        { location: datasetLocation },
      );
      if (!stagingResult.success) {
        throw new Error(
          `Staging schema discovery failed: ${stagingResult.error}`,
        );
      }
      for (const r of (stagingResult.data as any[]) || []) {
        stagingCols.add(r.column_name as string);
      }

      log.info("Schema cache hit for live table", {
        liveTable,
        stagingTable,
        liveCols: liveCols.size,
        stagingCols: stagingCols.size,
      });
    } else {
      liveCols = new Set<string>();
      liveTypes = new Map<string, string>();

      const infoSchemaQuery = `SELECT table_name, column_name, data_type FROM ${escId(projectId)}.${escId(dataset)}.INFORMATION_SCHEMA.COLUMNS WHERE table_name IN ('${stagingTable.replace(/'/g, "''")}', '${liveTable.replace(/'/g, "''")}')`;
      const schemaResult = await databaseConnectionService.executeQuery(
        destination,
        infoSchemaQuery,
        { location: datasetLocation },
      );

      if (!schemaResult.success) {
        log.error("INFORMATION_SCHEMA query failed in mergeStagingToLive", {
          stagingTable,
          liveTable,
          dataset,
          error: schemaResult.error,
        });
        throw new Error(`Schema discovery failed: ${schemaResult.error}`);
      }

      for (const r of (schemaResult.data as any[]) || []) {
        const tbl = r.table_name as string;
        const col = r.column_name as string;
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
    }

    if (stagingCols.size === 0) {
      log.info("Staging table not found or empty, nothing to merge", {
        stagingTable,
        liveTable,
        dataset,
      });
      return { written: 0 };
    }

    if (liveCols.size === 0) {
      await this.ensureLiveTableFromSchema(
        layout,
        Array.from(stagingCols),
        entitySchema,
      );

      const refreshQuery = `SELECT column_name, data_type FROM ${escId(projectId)}.${escId(dataset)}.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${liveTable.replace(/'/g, "''")}'`;
      const refreshResult = await databaseConnectionService.executeQuery(
        destination,
        refreshQuery,
        { location: datasetLocation },
      );
      if (!refreshResult.success) {
        throw new Error(
          refreshResult.error ||
            "INFORMATION_SCHEMA refresh failed after creating live table",
        );
      }
      for (const r of (refreshResult.data as any[]) || []) {
        const col = r.column_name as string;
        const dt = r.data_type as string;
        liveCols.add(col);
        liveTypes.set(col, dt);
      }
      setCachedSchema(liveCacheKey, new Map(liveTypes));
      log.info("Live table types loaded from INFORMATION_SCHEMA after CREATE", {
        liveTable,
        columnCount: liveCols.size,
      });
    }

    // --- Schema evolution: skip when connector schema hash hasn't changed ---
    const currentSchemaHash = entitySchema
      ? hashEntitySchema(entitySchema)
      : undefined;
    const skipEvolution =
      schemaCacheHit &&
      currentSchemaHash != null &&
      cachedLive?.schemaHash === currentSchemaHash;

    if (skipEvolution) {
      log.debug?.("Skipping schema evolution — connector schema unchanged", {
        liveTable,
        schemaHash: currentSchemaHash,
      });
    } else {
      await this.evolveSchemaIfNeeded({
        fullLive,
        liveTable,
        liveCols,
        liveTypes,
        entitySchema,
        destination,
        datasetLocation,
      });
      if (currentSchemaHash) {
        setCachedSchema(liveCacheKey, new Map(liveTypes), currentSchemaHash);
      }
    }

    const missingInLive = [...stagingCols].filter(c => !liveCols.has(c));
    const skippedLiveAdds: string[] = [];
    const addedToLive: string[] = [];
    for (const col of missingInLive) {
      const colType = resolveTargetBqType(col, entitySchema, undefined);
      const addToLive = await databaseConnectionService.executeQuery(
        destination,
        `ALTER TABLE ${fullLive} ADD COLUMN IF NOT EXISTS ${escId(col)} ${colType}`,
        { location: datasetLocation },
      );
      if (!addToLive.success) {
        skippedLiveAdds.push(col);
        log.warn(
          "Skipping live column add; column will be omitted from MERGE",
          { liveTable, column: col, error: addToLive.error },
        );
        continue;
      }
      liveCols.add(col);
      liveTypes.set(col, colType);
      addedToLive.push(col);
    }
    if (addedToLive.length > 0) {
      invalidateCachedSchema(liveCacheKey);
      setCachedSchema(liveCacheKey, new Map(liveTypes), currentSchemaHash);
      log.info("Added missing columns to live table from staging", {
        liveTable,
        addedColumns: addedToLive,
      });
    }

    const allColumns = Array.from(liveCols);

    const keyColumns = layout.keyColumns;
    const missingKeyInLive = keyColumns.filter(k => !liveCols.has(k));
    const missingKeyInStaging = keyColumns.filter(k => !stagingCols.has(k));
    if (missingKeyInLive.length > 0 || missingKeyInStaging.length > 0) {
      throw new Error(
        `Missing key columns for MERGE (live: [${missingKeyInLive.join(", ")}], staging: [${missingKeyInStaging.join(", ")}])`,
      );
    }

    const mergeMaxWaitEnv = Number.parseInt(
      process.env.BIGQUERY_MERGE_MAX_WAIT_MS || "",
      10,
    );
    const mergeMaxWaitMs =
      Number.isFinite(mergeMaxWaitEnv) && mergeMaxWaitEnv >= 10_000
        ? Math.min(mergeMaxWaitEnv, 60 * 60 * 1000)
        : 15 * 60 * 1000;

    const stagingRowCount = options?.knownStagingRowCount ?? 0;

    const mergeStmt = buildMergeStatement({
      fullLive,
      fullStaging,
      columns: allColumns,
      keyColumns,
      stagingCols,
      liveTypes,
      entitySchema,
    });

    log.info("Starting staging-to-live MERGE", {
      liveTable,
      stagingTable,
      dataset,
      stagingRowCount,
      columnCount: allColumns.length,
      schemaCacheHit,
    });

    await retryOnQuota(
      async () => {
        const mergeResult = await databaseConnectionService.executeQuery(
          destination,
          mergeStmt,
          { bigQueryJobMaxWaitMs: mergeMaxWaitMs, location: datasetLocation },
        );
        if (!mergeResult.success) {
          invalidateCachedSchema(liveCacheKey);
          log.error("BigQuery MERGE failed", {
            liveTable,
            stagingTable,
            error: mergeResult.error,
            mergePreview: mergeStmt.slice(0, 900),
          });
          throw new Error(mergeResult.error || "BigQuery MERGE failed");
        }
      },
      { label: `mergeStagingToLive:MERGE(${liveTable})` },
    );

    log.info("Merged staging to live via MERGE", {
      liveTable,
      stagingTable,
      dataset,
      stagingRowCount,
      skippedLiveAdds,
    });

    return { written: stagingRowCount };
  }

  async cleanupStaging(
    layout: CdcEntityLayout,
    flowId: string,
    options?: { stagingSuffix?: string },
  ): Promise<void> {
    const stagingTable = this.getStagingTableName(
      layout.tableName,
      flowId,
      options?.stagingSuffix,
    );
    await this.dropStagingTable(stagingTable);
  }

  async prepareStaging(
    layout: CdcEntityLayout,
    flowId: string,
    options?: { stagingSuffix?: string },
  ): Promise<void> {
    await this.ensureDataset();
    const stagingTable = this.getStagingTableName(
      layout.tableName,
      flowId,
      options?.stagingSuffix,
    );
    await this.dropStagingTable(stagingTable).catch(() => undefined);
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

  private async evolveSchemaIfNeeded(params: {
    fullLive: string;
    liveTable: string;
    liveCols: Set<string>;
    liveTypes: Map<string, string>;
    entitySchema: ConnectorEntitySchema | undefined;
    destination: IDatabaseConnection;
    datasetLocation: string | undefined;
  }): Promise<void> {
    const {
      fullLive,
      liveTable,
      liveCols,
      liveTypes,
      entitySchema,
      destination,
      datasetLocation,
    } = params;
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

    const evolved: string[] = [];
    const skipped: string[] = [];

    for (const { column, actualType, expectedType } of drifted) {
      const tmpCol = `${column}_mako_tmp`;
      const bakCol = `${column}_mako_bak`;

      try {
        await retryOnQuota(
          async () => {
            const r = await databaseConnectionService.executeQuery(
              destination,
              `ALTER TABLE ${fullLive} ADD COLUMN IF NOT EXISTS ${escId(tmpCol)} ${expectedType}`,
              { location: datasetLocation },
            );
            if (!r.success) throw new Error(r.error || "ADD COLUMN failed");
          },
          { label: `evolveSchema:ADD(${column})` },
        );

        await retryOnQuota(
          async () => {
            const castExpr = buildCastExpression(escId(column), expectedType);
            const r = await databaseConnectionService.executeQuery(
              destination,
              `UPDATE ${fullLive} SET ${escId(tmpCol)} = ${castExpr} WHERE 1=1`,
              { location: datasetLocation },
            );
            if (!r.success) throw new Error(r.error || "UPDATE cast failed");
          },
          { label: `evolveSchema:UPDATE(${column})` },
        );

        await retryOnQuota(
          async () => {
            const r = await databaseConnectionService.executeQuery(
              destination,
              `ALTER TABLE ${fullLive} RENAME COLUMN ${escId(column)} TO ${escId(bakCol)}, RENAME COLUMN ${escId(tmpCol)} TO ${escId(column)}`,
              { location: datasetLocation },
            );
            if (!r.success) throw new Error(r.error || "RENAME COLUMN failed");
          },
          { label: `evolveSchema:RENAME(${column})` },
        );

        await retryOnQuota(
          async () => {
            const r = await databaseConnectionService.executeQuery(
              destination,
              `ALTER TABLE ${fullLive} DROP COLUMN IF EXISTS ${escId(bakCol)}`,
              { location: datasetLocation },
            );
            if (!r.success) throw new Error(r.error || "DROP COLUMN failed");
          },
          { label: `evolveSchema:DROP(${column})` },
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
            await databaseConnectionService.executeQuery(
              destination,
              `ALTER TABLE ${fullLive} DROP COLUMN IF EXISTS ${escId(leftover)}`,
              { location: datasetLocation },
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

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getStagingTableName(
    tableName: string,
    flowId: string,
    suffix?: string,
  ): string {
    const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
    return `${tableName}__${flowToken}__${suffix || "staging"}`;
  }

  private async resolveDestination(): Promise<IDatabaseConnection> {
    const doc = await DatabaseConnection.findById(
      this.config.destinationDatabaseId,
    );
    if (!doc) {
      throw new Error(
        `Destination connection ${this.config.destinationDatabaseId} not found`,
      );
    }
    return doc;
  }

  private _datasetLocation: string | undefined;
  private _resolvedClient?: {
    bq: InstanceType<typeof BigQuery>;
    projectId: string;
    dataset: string;
    destination: IDatabaseConnection;
    datasetLocation: string | undefined;
  };

  private async resolveBqClient(): Promise<{
    bq: InstanceType<typeof BigQuery>;
    projectId: string;
    dataset: string;
    destination: IDatabaseConnection;
    datasetLocation: string | undefined;
  }> {
    if (this._resolvedClient) return this._resolvedClient;

    const destination = await this.resolveDestination();
    const conn = destination.connection as any;
    const credentials =
      typeof conn.service_account_json === "string"
        ? JSON.parse(conn.service_account_json)
        : conn.service_account_json;
    const projectId = conn.project_id;
    const dataset = this.config.tableDestination.schema;
    const connLocation: string | undefined = conn.location;
    const bq = new BigQuery({ projectId, credentials, location: connLocation });

    if (!this._datasetLocation) {
      try {
        const [meta] = await bq.dataset(dataset).getMetadata();
        this._datasetLocation = meta.location;
      } catch {
        this._datasetLocation = connLocation;
      }
      log.info("Resolved dataset location", {
        dataset,
        location: this._datasetLocation,
        connLocation,
      });
    }

    this._resolvedClient = {
      bq,
      projectId,
      dataset,
      destination,
      datasetLocation: this._datasetLocation,
    };
    return this._resolvedClient;
  }

  private async ensureDataset(): Promise<void> {
    const { bq, dataset } = await this.resolveBqClient();
    await bq.dataset(dataset).get({ autoCreate: true });
  }

  private async loadParquetToStaging(
    parquetPath: string,
    stagingTable: string,
    options?: { skipParquetCleanup?: boolean },
  ): Promise<{ loaded: number }> {
    const { bq, dataset, datasetLocation } = await this.resolveBqClient();

    const jobMeta = await retryOnQuota(
      async () => {
        const [metadata] = await bq
          .dataset(dataset, { location: datasetLocation })
          .table(stagingTable)
          .load(parquetPath, {
            sourceFormat: "PARQUET",
            writeDisposition: "WRITE_APPEND",
            schemaUpdateOptions: ["ALLOW_FIELD_ADDITION"],
          });

        const meta = metadata as Record<string, any>;
        if (meta?.status?.errorResult) {
          throw new Error(
            meta.status.errorResult.message || "BigQuery load job failed",
          );
        }
        return meta;
      },
      { label: `loadParquetToStaging(${stagingTable})` },
    );

    const loaded = Number(jobMeta?.statistics?.load?.outputRows || 0);

    if (!options?.skipParquetCleanup) {
      await fs.rm(parquetPath, { force: true }).catch(() => undefined);
    }

    log.info("Loaded Parquet to BigQuery staging table", {
      stagingTable,
      dataset,
      loaded,
    });

    return { loaded };
  }

  private async dropStagingTable(stagingTable: string): Promise<void> {
    const { projectId, dataset, destination, datasetLocation } =
      await this.resolveBqClient();
    const fqStaging = `${escId(projectId)}.${escId(dataset)}.${escId(stagingTable)}`;

    await databaseConnectionService.executeQuery(
      destination,
      `DROP TABLE IF EXISTS ${fqStaging}`,
      { location: datasetLocation },
    );

    log.info("Cleaned up staging table", { stagingTable, dataset });
  }

  private async writeViaParquet(params: {
    records: Record<string, unknown>[];
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
    entitySchema?: ConnectorEntitySchema;
  }): Promise<{ written: number }> {
    if (params.records.length === 0) return { written: 0 };

    const flowId = String(params.flow._id);
    const stagingSuffix = `stg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    await this.ensureDataset();

    // Pass schema fields so the Parquet builder types columns correctly
    // (timestamp/number/bool/json). Without this, every column defaults to
    // VARCHAR and Date values get JSON.stringify'd with extra quotes, which
    // then SAFE_CAST to NULL on the live side — wiping timestamps on update.
    const schemaFields: FieldMeta[] | undefined = params.entitySchema
      ? Object.entries(params.entitySchema.fields).map(([name, f]) => ({
          name,
          type: f.type,
        }))
      : undefined;

    const parquet = await buildParquetFromBatches({
      filenameBase: `cdc-${params.layout.entity}`,
      fields: schemaFields,
      streamBatches: async insertBatch => {
        await insertBatch(params.records);
      },
    });

    log.info("writeViaParquet: built Parquet for CDC batch", {
      table: params.layout.tableName,
      rows: params.records.length,
      parquetBytes: parquet.byteSize,
      flowId,
      stagingSuffix,
    });

    try {
      const loadResult = await this.loadStagingFromParquet(
        parquet.filePath,
        params.layout,
        flowId,
        { stagingSuffix },
      );
      await this.mergeFromStaging(
        params.layout,
        params.flow,
        flowId,
        params.entitySchema,
        { stagingSuffix, knownStagingRowCount: loadResult.loaded },
      );
    } finally {
      await this.cleanupStaging(params.layout, flowId, { stagingSuffix }).catch(
        err => {
          log.warn("Failed to cleanup CDC staging table", {
            flowId,
            table: params.layout.tableName,
            stagingSuffix,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    }

    return { written: params.records.length };
  }

  private async hardDeleteBatch(
    layout: CdcEntityLayout,
    deletes: CdcStoredEvent[],
    fallbackDataSourceId: string | undefined,
  ): Promise<void> {
    const { projectId, dataset, destination, datasetLocation } =
      await this.resolveBqClient();
    const fullLive = `${escId(projectId)}.${escId(dataset)}.${escId(layout.tableName)}`;

    const ids = deletes.map(e => `'${String(e.recordId).replace(/'/g, "''")}'`);
    const CHUNK = 10_000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      let where = `\`id\` IN (${chunk.join(", ")})`;
      if (fallbackDataSourceId) {
        where += ` AND \`_dataSourceId\` = '${fallbackDataSourceId.replace(/'/g, "''")}'`;
      }
      await retryOnQuota(
        async () => {
          const result = await databaseConnectionService.executeQuery(
            destination,
            `DELETE FROM ${fullLive} WHERE ${where}`,
            { location: datasetLocation },
          );
          if (!result.success) {
            const notFound =
              result.error && /not found|does not exist/i.test(result.error);
            if (notFound) {
              log.info("Skipping hard delete — live table does not exist yet", {
                table: layout.tableName,
              });
              return;
            }
            throw new Error(result.error || "BigQuery hard delete failed");
          }
        },
        { label: `hardDeleteBatch(${layout.tableName})` },
      );
    }

    log.info("Hard-deleted records from live table", {
      table: layout.tableName,
      count: deletes.length,
    });
  }
}
