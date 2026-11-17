/**
 * The parity queries, BigQuery dialect: pure builders and readers, so they
 * are tested without a warehouse.
 *
 * One entity is one live table and one shadow table with the same name in
 * two datasets. Both sides are reduced to their latest non-deleted row per
 * key, joined on the key, and compared:
 *
 * - **keys**: on both sides, live only, shadow only;
 * - **fields**: one checksum per row over every column both tables have,
 *   minus Mako's own bookkeeping columns, so the key and the updated-at
 *   (`_mako_source_ts`) are in it; a count of differing rows per column;
 * - **live updates**: live rows changed in the window, whether the shadow
 *   has the same version, and how much later the shadow wrote it.
 *
 * A key either side changed at or after the cutoff is still in flight and
 * is not compared.
 */
import { escId } from "../../sync-cdc/adapters/bigquery-sql";

/** Mako's columns: set by the write, not by the source, so never compared. */
export const PARITY_IGNORED_COLUMNS: ReadonlySet<string> = new Set([
  "_syncedAt",
  "_mako_ingest_seq",
  "_mako_deleted_at",
  "_dataSourceId",
  "is_deleted",
  "deleted_at",
]);

const SOURCE_TS = "_mako_source_ts";
const SYNCED_AT = "_syncedAt";

export interface ParityTables {
  /** `project`.`dataset`.`table`, quoted, for each side. */
  live: string;
  shadow: string;
  keyColumns: string[];
  /** Columns both sides have, compared field by field. */
  columns: string[];
  cutoff: Date;
  windowStart: Date;
  /** Both tables carry `_mako_ingest_seq`, the tie-break between versions. */
  hasIngestSeq?: boolean;
}

export function bqTable(project: string, dataset: string, table: string) {
  return `${escId(project)}.${escId(dataset)}.${escId(table)}`;
}

function ts(date: Date): string {
  return `TIMESTAMP('${date.toISOString()}')`;
}

/** A column's value as text, the same on both sides for the same value. */
function asText(rowAlias: string, column: string): string {
  return `TO_JSON_STRING(${rowAlias}.${escId(column)})`;
}

/** Columns both sides compare: common, sorted, bookkeeping removed. */
export function comparableColumns(
  liveColumns: string[],
  shadowColumns: string[],
): { common: string[]; liveOnly: string[]; shadowOnly: string[] } {
  const keep = (c: string) => !PARITY_IGNORED_COLUMNS.has(c);
  const live = new Set(liveColumns.filter(keep));
  const shadow = new Set(shadowColumns.filter(keep));
  return {
    common: [...live].filter(c => shadow.has(c)).sort(),
    liveOnly: [...live].filter(c => !shadow.has(c)).sort(),
    shadowOnly: [...shadow].filter(c => !live.has(c)).sort(),
  };
}

function sideCte(table: string, keyColumns: string[], hasSeq: boolean) {
  const key = `TO_JSON_STRING(STRUCT(${keyColumns
    .map(k => `t.${escId(k)}`)
    .join(", ")}))`;
  const order = [
    `t.${escId(SOURCE_TS)} DESC`,
    ...(hasSeq ? [`t.${escId("_mako_ingest_seq")} DESC`] : []),
  ].join(", ");
  return `SELECT ${key} AS __k, t FROM ${table} t
  WHERE t.${escId("_mako_deleted_at")} IS NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY ${key} ORDER BY ${order}) = 1`;
}

/** The two sides joined on the key, each row as a STRUCT (`l`, `s`). */
function joined(input: ParityTables): string {
  const hashOf = (alias: string) =>
    `FARM_FINGERPRINT(TO_JSON_STRING(STRUCT(${input.columns
      .map(c => `${alias}.t.${escId(c)} AS ${escId(c)}`)
      .join(", ")})))`;
  const seq = input.hasIngestSeq !== false;
  return `WITH l AS (${sideCte(input.live, input.keyColumns, seq)}),
s AS (${sideCte(input.shadow, input.keyColumns, seq)}),
j AS (
  SELECT
    COALESCE(l.__k, s.__k) AS k,
    l.__k IS NOT NULL AS lp,
    s.__k IS NOT NULL AS sp,
    l.t.${escId(SOURCE_TS)} AS lts,
    s.t.${escId(SOURCE_TS)} AS sts,
    l.t.${escId(SYNCED_AT)} AS lsy,
    s.t.${escId(SYNCED_AT)} AS ssy,
    IF(l.__k IS NULL, NULL, ${hashOf("l")}) AS lh,
    IF(s.__k IS NULL, NULL, ${hashOf("s")}) AS sh,
    l.t AS lr,
    s.t AS sr
  FROM l FULL OUTER JOIN s ON l.__k = s.__k
),
c AS (
  SELECT *,
    (COALESCE(lts >= ${ts(input.cutoff)}, FALSE)
      OR COALESCE(sts >= ${ts(input.cutoff)}, FALSE)) AS recent
  FROM j
)`;
}

/** Column `i`'s differing-row count is `d<i>` in the summary row. */
export function buildSummarySql(input: ParityTables): string {
  const both = "NOT recent AND lp AND sp";
  const inWindow = `lp AND lts >= ${ts(input.windowStart)} AND lts < ${ts(input.cutoff)}`;
  const matched = `${inWindow} AND sp AND sts = lts`;
  const fieldCounts = input.columns.map(
    (c, i) =>
      `COUNTIF(${both} AND ${asText("lr", c)} IS DISTINCT FROM ${asText("sr", c)}) AS d${i}`,
  );
  return `${joined(input)}
SELECT
  COUNTIF(lp) AS live_rows,
  COUNTIF(sp) AS shadow_rows,
  COUNTIF(recent) AS recent,
  COUNTIF(NOT recent) AS compared,
  COUNTIF(${both}) AS both_keys,
  COUNTIF(NOT recent AND lp AND NOT sp) AS live_only,
  COUNTIF(NOT recent AND sp AND NOT lp) AS shadow_only,
  COUNTIF(${both} AND lh != sh) AS rows_differing,
  CAST(BIT_XOR(IF(NOT recent AND lp, lh, 0)) AS STRING) AS live_checksum,
  CAST(BIT_XOR(IF(NOT recent AND sp, sh, 0)) AS STRING) AS shadow_checksum,
  COUNTIF(${inWindow}) AS w_live,
  COUNTIF(${matched}) AS w_matched,
  APPROX_QUANTILES(IF(${matched}, TIMESTAMP_DIFF(ssy, lsy, SECOND), NULL), 100)[SAFE_OFFSET(50)] AS w_lag_p50,
  APPROX_QUANTILES(IF(${matched}, TIMESTAMP_DIFF(ssy, lsy, SECOND), NULL), 100)[SAFE_OFFSET(95)] AS w_lag_p95${
    fieldCounts.length ? ",\n  " + fieldCounts.join(",\n  ") : ""
  }
FROM c`;
}

/** Up to `perField` differing rows for each named column, in one scan. */
export function buildSamplesSql(
  input: ParityTables,
  fields: string[],
  perField: number,
): string {
  const cells = fields
    .map(
      c =>
        `STRUCT(${sqlString(c)} AS field, ${asText("lr", c)} AS lv, ${asText("sr", c)} AS sv)`,
    )
    .join(",\n      ");
  return `${joined(input)}
SELECT f.field, ARRAY_AGG(STRUCT(k AS key, SUBSTR(f.lv, 1, 200) AS live, SUBSTR(f.sv, 1, 200) AS shadow) LIMIT ${Math.max(1, Math.floor(perField))}) AS samples
FROM c, UNNEST([
      ${cells}
    ]) AS f
WHERE NOT recent AND lp AND sp AND f.lv IS DISTINCT FROM f.sv
GROUP BY f.field`;
}

/** The columns of the given tables in one dataset. */
export function buildColumnsSql(
  project: string,
  dataset: string,
  tables: string[],
): string {
  return `SELECT table_name, column_name
FROM ${escId(project)}.${escId(dataset)}.INFORMATION_SCHEMA.COLUMNS
WHERE table_name IN (${tables.map(sqlString).join(", ")})`;
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** A BigQuery cell as a number (INT64 may arrive as string or `{ value }`). */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const raw =
    typeof value === "object" && value && "value" in (value as object)
      ? (value as { value: unknown }).value
      : value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

export interface SummaryRow {
  liveRows: number;
  shadowRows: number;
  recent: number;
  compared: number;
  bothKeys: number;
  liveOnly: number;
  shadowOnly: number;
  rowsDiffering: number;
  liveChecksum: string | null;
  shadowChecksum: string | null;
  window: {
    liveRows: number;
    matched: number;
    missingOrBehind: number;
    lagP50Seconds: number | null;
    lagP95Seconds: number | null;
  };
  /** Differing rows per column, largest first, zeros left out. */
  fieldDiffs: Array<{ field: string; rows: number }>;
}

export function readSummaryRow(
  row: Record<string, unknown>,
  columns: string[],
): SummaryRow {
  const wLive = num(row.w_live);
  const wMatched = num(row.w_matched);
  const str = (v: unknown) =>
    v === null || v === undefined ? null : String((v as any)?.value ?? v);
  return {
    liveRows: num(row.live_rows),
    shadowRows: num(row.shadow_rows),
    recent: num(row.recent),
    compared: num(row.compared),
    bothKeys: num(row.both_keys),
    liveOnly: num(row.live_only),
    shadowOnly: num(row.shadow_only),
    rowsDiffering: num(row.rows_differing),
    liveChecksum: str(row.live_checksum),
    shadowChecksum: str(row.shadow_checksum),
    window: {
      liveRows: wLive,
      matched: wMatched,
      missingOrBehind: wLive - wMatched,
      lagP50Seconds: numOrNull(row.w_lag_p50),
      lagP95Seconds: numOrNull(row.w_lag_p95),
    },
    fieldDiffs: columns
      .map((field, i) => ({ field, rows: num(row[`d${i}`]) }))
      .filter(d => d.rows > 0)
      .sort((a, b) => b.rows - a.rows || a.field.localeCompare(b.field)),
  };
}
