/**
 * Pure SQL generation for the BigQuery CDC adapter: the column-type contract
 * (staging VARCHAR → typed live columns), the deduplicating MERGE, MERGE
 * partition pruning, and the partition/cluster/repartition DDL. Nothing here
 * talks to BigQuery, so every statement shape is contract-testable.
 */
import type {
  ConnectorEntitySchema,
  ConnectorLogicalType,
} from "../../connectors/base/BaseConnector";
import type { CdcEntityLayout } from "./registry";

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
  _syncedAt: "TIMESTAMP",
  _mako_ingest_seq: "INT64",
  _mako_source_ts: "TIMESTAMP",
  _mako_deleted_at: "TIMESTAMP",
  is_deleted: "BOOL",
  deleted_at: "TIMESTAMP",
};

export function resolveTargetBqType(
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

export function buildCastExpression(
  colRef: string,
  targetType: string,
): string {
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

/**
 * A backtick-quoted BigQuery identifier. Backslashes are escaped before
 * backticks: BigQuery reads `\` inside a quoted identifier as an escape,
 * so a name ending in `\` would otherwise escape the closing backtick.
 */
export const escId = (id: string) =>
  `\`${id.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``;

// ---------------------------------------------------------------------------
// Pure MERGE statement builder.
// ---------------------------------------------------------------------------

export interface BuildMergeStatementParams {
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
  /**
   * Extra predicate on `__live` ANDed into the ON clause, built by
   * {@link buildLivePartitionFilter}. It must hold for every live row whose
   * key is in staging, or the MERGE would insert duplicates.
   */
  livePartitionFilter?: string;
}

/**
 * Build the BigQuery CDC MERGE statement that materializes a deduplicated
 * staging table into the live table. Exported for contract testing — the exact
 * SQL shape (QUALIFY dedup, ordering guards, typed NULL inserts) is
 * correctness-critical for the CDC pipeline.
 */
export function buildMergeStatement(p: BuildMergeStatementParams): string {
  const {
    fullLive,
    fullStaging,
    columns,
    keyColumns,
    stagingCols,
    liveTypes,
    entitySchema,
    livePartitionFilter,
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
  const keyJoin =
    keyColumns
      .map(k => `__live.${escId(k)} = __stg.${escId(k)}`)
      .join(" AND ") +
    (livePartitionFilter ? ` AND (${livePartitionFilter})` : "");

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

// ---------------------------------------------------------------------------
// MERGE partition pruning.
//
// `MERGE ... ON __live.id = __stg.id` reads every partition of the live table:
// BigQuery prunes only on constant predicates, never through the join. On the
// Close activity tables (thousands of daily partitions) that cost ~200k
// slot-ms per merge for batches of ~10-40 rows. The fix is two queries:
//   1. a narrow probe (key + partition column only) that lists the partitions
//      holding live rows whose key is in staging;
//   2. the MERGE with those partitions as literal ranges in the ON clause.
// Correct by construction: every live row that can match a staged key lies in
// a probed partition, so MATCHED/NOT MATCHED decisions are unchanged. Staging
// rows whose key is absent from live still fall to NOT MATCHED and insert.
// ---------------------------------------------------------------------------

/** Above this many distinct live partitions the MERGE runs unfiltered. */
export const MERGE_PRUNE_MAX_PARTITIONS = 400;

type PartitionGranularity = "hour" | "day" | "month" | "year";

function normalizeGranularity(g: string | undefined): PartitionGranularity {
  const v = (g || "day").toLowerCase();
  return v === "hour" || v === "month" || v === "year" ? v : "day";
}

/**
 * Probe query listing the distinct partition buckets (UTC, `%FT%T`) of live
 * rows whose key appears in staging. Staging keys are cast exactly as the
 * MERGE casts them, so the probe joins the same pairs the MERGE would.
 */
export function buildLivePartitionProbeQuery(p: {
  fullLive: string;
  fullStaging: string;
  keyColumns: string[];
  partitionField: string;
  granularity?: string;
  liveTypes: Map<string, string>;
  entitySchema?: ConnectorEntitySchema;
  limit: number;
}): string {
  const gran = normalizeGranularity(p.granularity).toUpperCase();
  const stgKeys = p.keyColumns
    .map(k =>
      buildColumnSelectExpr(k, escId, p.entitySchema, p.liveTypes.get(k)),
    )
    .join(", ");
  const join = p.keyColumns
    .map(k => `__live.${escId(k)} = __stg.${escId(k)}`)
    .join(" AND ");
  return (
    `SELECT DISTINCT FORMAT_TIMESTAMP('%FT%T', TIMESTAMP_TRUNC(__live.${escId(p.partitionField)}, ${gran}), 'UTC') AS p ` +
    `FROM ${p.fullLive} __live JOIN (SELECT DISTINCT ${stgKeys} FROM ${p.fullStaging}) __stg ON ${join} ` +
    `LIMIT ${p.limit + 1}`
  );
}

function addGranularity(d: Date, g: PartitionGranularity): Date {
  const n = new Date(d.getTime());
  if (g === "hour") n.setUTCHours(n.getUTCHours() + 1);
  else if (g === "day") n.setUTCDate(n.getUTCDate() + 1);
  else if (g === "month") n.setUTCMonth(n.getUTCMonth() + 1);
  else n.setUTCFullYear(n.getUTCFullYear() + 1);
  return n;
}

const bqTs = (d: Date) =>
  `TIMESTAMP '${d.toISOString().slice(0, 19).replace("T", " ")} UTC'`;

/**
 * Turn probed buckets into a constant predicate on `__live.<field>`: one
 * half-open range per run of adjacent buckets, plus `IS NULL` when a live row
 * sits in the NULL partition. Literal ranges prune whatever granularity the
 * table was actually created with. Returns `FALSE` when no live row matches
 * (every staged row is new), and `undefined` when a bucket cannot be parsed
 * (caller runs the MERGE unfiltered).
 */
export function buildLivePartitionFilter(p: {
  partitionField: string;
  granularity?: string;
  buckets: Array<string | null>;
}): string | undefined {
  const gran = normalizeGranularity(p.granularity);
  const col = `__live.${escId(p.partitionField)}`;
  let hasNull = false;
  const starts: Date[] = [];
  for (const b of p.buckets) {
    if (b == null) {
      hasNull = true;
      continue;
    }
    const d = new Date(`${b}Z`);
    if (Number.isNaN(d.getTime())) return undefined;
    starts.push(d);
  }
  starts.sort((a, b) => a.getTime() - b.getTime());
  const ranges: Array<[Date, Date]> = [];
  for (const s of starts) {
    const e = addGranularity(s, gran);
    const last = ranges[ranges.length - 1];
    if (last && last[1].getTime() >= s.getTime()) {
      if (e.getTime() > last[1].getTime()) last[1] = e;
    } else {
      ranges.push([s, e]);
    }
  }
  const parts = ranges.map(
    ([s, e]) => `(${col} >= ${bqTs(s)} AND ${col} < ${bqTs(e)})`,
  );
  if (hasNull) parts.push(`${col} IS NULL`);
  return parts.length > 0 ? parts.join(" OR ") : "FALSE";
}

/**
 * BigQuery `PARTITION BY` clause for a CDC layout (empty when unpartitioned).
 * Exported for contract testing.
 */
export function bigQueryPartitionClause(layout: CdcEntityLayout): string {
  if (!layout.partitioning?.field) return "";
  const gran = layout.partitioning.granularity?.toUpperCase() || "DAY";
  return `PARTITION BY TIMESTAMP_TRUNC(${escId(layout.partitioning.field)}, ${gran})`;
}

export function bigQueryClusterClause(layout: CdcEntityLayout): string {
  if (!layout.clustering?.fields?.length) return "";
  return `CLUSTER BY ${layout.clustering.fields.map(escId).join(", ")}`;
}

export interface BigQueryRepartitionStatements {
  createTmp: string;
  dropLive: string;
  rename: string;
}

/**
 * Build the statements that rewrite a live table's partition/cluster layout in
 * place: `CREATE OR REPLACE` a new-layout table from the current rows, drop the
 * old table, then rename the new one into place. This is the swap BigQuery
 * actually supports (no atomic EXCHANGE); the caller pauses the stream so the
 * brief window where `live` is renamed is safe. Exported for contract testing +
 * reuse by the gated integration suite.
 */
export function buildBigQueryRepartitionStatements(params: {
  fullLive: string;
  fullTmp: string;
  liveName: string;
  layout: CdcEntityLayout;
}): BigQueryRepartitionStatements {
  const partitionClause = bigQueryPartitionClause(params.layout);
  const clusterClause = bigQueryClusterClause(params.layout);
  return {
    createTmp:
      `CREATE OR REPLACE TABLE ${params.fullTmp} ${partitionClause} ${clusterClause} AS SELECT * FROM ${params.fullLive}`.replace(
        /\s+/g,
        " ",
      ),
    dropLive: `DROP TABLE ${params.fullLive}`,
    rename: `ALTER TABLE ${params.fullTmp} RENAME TO ${escId(params.liveName)}`,
  };
}

/** `CREATE TABLE IF NOT EXISTS` for a live table typed by the schema contract. */
export function buildCreateLiveTableStatement(p: {
  fullLive: string;
  columns: string[];
  layout: CdcEntityLayout;
  entitySchema?: ConnectorEntitySchema;
}): string {
  const colDefs = p.columns
    .map(col => {
      const bqType = resolveTargetBqType(col, p.entitySchema, undefined);
      return `${escId(col)} ${bqType}`;
    })
    .join(", ");
  return `CREATE TABLE IF NOT EXISTS ${p.fullLive} (${colDefs}) ${bigQueryPartitionClause(p.layout)} ${bigQueryClusterClause(p.layout)}`;
}

/** A single-quoted BigQuery string literal. */
export const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Name of the staging table one flow uses for one live table. */
export function bigQueryStagingTableName(
  tableName: string,
  flowId: string,
  suffix?: string,
): string {
  const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
  return `${tableName}__${flowToken}__${suffix || "staging"}`;
}
