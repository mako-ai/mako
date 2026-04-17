import { BigQuery } from "@google-cloud/bigquery";
import { BigQueryReadClient } from "@google-cloud/bigquery-storage";
import { GoogleAuth } from "google-auth-library";
import avro from "avsc";
import type {
  IDatabaseConnection,
  IIncrementalConfig,
} from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { substituteTemplates } from "../../utils/template-substitution";
import { loggers } from "../../logging";
import type {
  BulkExtraction,
  BulkExtractor,
  BulkLogFn,
  BulkSlice,
} from "./registry";

const log = loggers.sync("bulk-extractor.bigquery");

/**
 * Avro logical-type handlers for BigQuery Storage Read decoding.
 *
 * Without these, avsc returns raw underlying primitives (int days for DATE,
 * long micros for TIMESTAMP, etc.) which ClickHouse's JSONEachRow parser then
 * rejects when the staging column is Nullable(String) because the numbers
 * serialize without JSON quotes. Decoding to ISO strings here makes the row
 * stream uniformly string-friendly and preserves semantic meaning.
 *
 * Reference:
 *   https://cloud.google.com/bigquery/docs/reference/storage#avro_schema_details
 *   https://avro.apache.org/docs/1.11.1/specification/#logical-types
 */
class DateLogicalType extends (avro as any).types.LogicalType {
  _fromValue(daysSinceEpoch: number): string {
    return new Date(daysSinceEpoch * 86_400_000).toISOString().slice(0, 10);
  }
  _toValue(iso: string): number {
    return Math.floor(new Date(iso).getTime() / 86_400_000);
  }
}

class TimestampMillisLogicalType extends (avro as any).types.LogicalType {
  _fromValue(ms: number): string {
    return new Date(ms).toISOString();
  }
  _toValue(iso: string): number {
    return new Date(iso).getTime();
  }
}

class TimestampMicrosLogicalType extends (avro as any).types.LogicalType {
  _fromValue(micros: number | bigint): string {
    const ms =
      typeof micros === "bigint"
        ? Number(micros / 1000n)
        : Math.trunc(micros / 1000);
    return new Date(ms).toISOString();
  }
  _toValue(iso: string): number {
    return new Date(iso).getTime() * 1000;
  }
}

class TimeMillisLogicalType extends (avro as any).types.LogicalType {
  _fromValue(ms: number): string {
    return new Date(ms).toISOString().slice(11, 23);
  }
  _toValue(iso: string): number {
    const [h, m, s] = iso.split(":").map(Number);
    return ((h * 3600 + m * 60 + s) * 1000) | 0;
  }
}

class TimeMicrosLogicalType extends (avro as any).types.LogicalType {
  _fromValue(micros: number | bigint): string {
    const ms =
      typeof micros === "bigint"
        ? Number(micros / 1000n)
        : Math.trunc(micros / 1000);
    return new Date(ms).toISOString().slice(11, 23);
  }
  _toValue(iso: string): number {
    const [h, m, s] = iso.split(":").map(Number);
    return (h * 3600 + m * 60 + s) * 1_000_000;
  }
}

class DecimalLogicalType extends (avro as any).types.LogicalType {
  _fromValue(buf: Buffer): string {
    // BigQuery encodes NUMERIC/BIGNUMERIC as two's-complement bytes with a
    // schema-provided scale. We don't have the scale here without threading
    // it in, so fall back to hex — callers needing exact decimal precision
    // should expose the column as STRING in their query.
    return buf.length === 0 ? "0" : `0x${buf.toString("hex")}`;
  }
  _toValue(): Buffer {
    throw new Error("DecimalLogicalType._toValue is read-only");
  }
}

const LIMIT_OFFSET_TAIL =
  /\s+LIMIT\s+\{\{\s*limit\s*\}\}(\s+OFFSET\s+\{\{\s*offset\s*\}\})?\s*$/i;

function prepareBulkQuery(
  sourceQuery: string,
  syncMode: "full" | "incremental",
  incrementalConfig?: IIncrementalConfig,
): string {
  let query = sourceQuery;

  let lastSyncValue: string | number | null = null;
  if (
    syncMode === "incremental" &&
    incrementalConfig?.trackingColumn &&
    incrementalConfig?.lastValue
  ) {
    lastSyncValue = incrementalConfig.lastValue;
  }

  query = substituteTemplates(
    query,
    { last_sync_value: lastSyncValue, keyset_value: null },
    { stripNullClauses: true },
  );

  query = query.replace(LIMIT_OFFSET_TAIL, "");
  query = query.replace(/;\s*$/, "");

  return query;
}

/**
 * Wraps the user's prepared query with a range filter so we only materialize
 * the slice's portion of the dataset. Uses BigQuery named parameters (@start,
 * @end) rather than string interpolation to sidestep quoting + injection
 * concerns for date/numeric/string values alike.
 *
 * Semantics: `[rangeStart, rangeEnd)` — start inclusive, end exclusive —
 * matching Airbyte's stream-slice convention and our internal slice model.
 */
function wrapQueryWithSliceFilter(
  preparedQuery: string,
  trackingColumn: string,
  slice: BulkSlice,
): { query: string; params: Record<string, unknown> } {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (slice.rangeStart !== undefined && slice.rangeStart !== null) {
    conditions.push(`\`${trackingColumn}\` >= @__mako_slice_start`);
    params.__mako_slice_start = slice.rangeStart;
  }
  if (slice.rangeEnd !== undefined && slice.rangeEnd !== null) {
    conditions.push(`\`${trackingColumn}\` < @__mako_slice_end`);
    params.__mako_slice_end = slice.rangeEnd;
  }

  if (conditions.length === 0) {
    return { query: preparedQuery, params: {} };
  }

  const wrapped = `SELECT * FROM (\n${preparedQuery}\n) AS __mako_src WHERE ${conditions.join(" AND ")}`;
  return { query: wrapped, params };
}

function parseServiceAccountJson(
  raw: string | object,
): Record<string, unknown> {
  if (typeof raw === "string") return JSON.parse(raw);
  return raw as Record<string, unknown>;
}

interface AnonTableRef {
  projectId: string;
  datasetId: string;
  tableId: string;
  location: string;
}

/**
 * Runs the query as a standard BigQuery job and returns a reference to the
 * anonymous destination table BigQuery auto-creates for every query result.
 *
 * We deliberately don't manage a named `_mako_temp` dataset: that path needed
 * IAM to create a dataset in every customer project, and was flaky across
 * regions (CREATE SCHEMA DDL location semantics). Anonymous result tables are:
 *   - free, invisible to the customer, and auto-expire in ~24h
 *   - always created in the job's processing location
 *   - readable via the Storage Read API with the caller's existing credentials
 */
async function runQueryAndGetDestination(
  sourceConnection: IDatabaseConnection,
  query: string,
  queryParams: Record<string, unknown> | undefined,
  onLog: BulkLogFn | undefined,
  sliceLabel?: string,
): Promise<AnonTableRef> {
  const conn = sourceConnection.connection as any;
  const projectId: string = conn.project_id;
  const location: string | undefined = conn.location;
  const credentials = parseServiceAccountJson(conn.service_account_json);

  const bq = new BigQuery({ projectId, credentials, location });

  log.info("Submitting BigQuery query job", {
    projectId,
    location,
    sliceLabel,
  });
  onLog?.(
    "info",
    sliceLabel
      ? `Submitting BigQuery query job for slice ${sliceLabel}...`
      : "Submitting BigQuery query job (materializing results)...",
    { projectId, location, sliceLabel },
  );

  const startedAt = Date.now();
  const [job] = await bq.createQueryJob({
    query,
    params:
      queryParams && Object.keys(queryParams).length > 0
        ? queryParams
        : undefined,
    useLegacySql: false,
    location,
    jobTimeoutMs: 30 * 60 * 1000,
  });

  await job.promise();

  const [metadata] = await job.getMetadata();

  const destTable = metadata?.configuration?.query?.destinationTable;
  if (!destTable?.projectId || !destTable?.datasetId || !destTable?.tableId) {
    throw new Error(
      "BigQuery did not return a destination table for the query job",
    );
  }

  const jobLocation: string =
    metadata?.jobReference?.location || location || "US";

  const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
  const stats = metadata?.statistics?.query;
  const bytesProcessed = stats?.totalBytesProcessed;
  const slotMs = stats?.totalSlotMs;

  log.info("Query materialized to anonymous table", {
    projectId: destTable.projectId,
    dataset: destTable.datasetId,
    table: destTable.tableId,
    location: jobLocation,
    elapsedSec,
    sliceLabel,
  });
  onLog?.(
    "info",
    `Query materialized in ${elapsedSec}s${bytesProcessed ? ` (${formatBytes(Number(bytesProcessed))} processed)` : ""}${sliceLabel ? ` [${sliceLabel}]` : ""}`,
    { elapsedSec, bytesProcessed, slotMs, sliceLabel },
  );

  return {
    projectId: destTable.projectId,
    datasetId: destTable.datasetId,
    tableId: destTable.tableId,
    location: jobLocation,
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function queryMaxTrackingValue(
  sourceConnection: IDatabaseConnection,
  tableRef: AnonTableRef,
  trackingColumn: string,
): Promise<string | null> {
  const fullTable = `\`${tableRef.projectId}.${tableRef.datasetId}.${tableRef.tableId}\``;
  const sql = `SELECT CAST(MAX(\`${trackingColumn}\`) AS STRING) AS max_val FROM ${fullTable}`;

  const result = await databaseConnectionService.executeQuery(
    sourceConnection,
    sql,
    {
      bigQueryJobMaxWaitMs: 60_000,
      location: tableRef.location,
    },
  );

  if (!result.success || !result.data?.length) return null;
  const maxVal = result.data[0]?.max_val;
  return maxVal && maxVal !== "null" ? String(maxVal) : null;
}

// ---------------------------------------------------------------------------
// Slicing
// ---------------------------------------------------------------------------

interface TrackingStats {
  minVal: string | null;
  maxVal: string | null;
  totalRows: number;
}

/**
 * Probes MIN/MAX/COUNT on the prepared query so we can plan slices without
 * materializing rows. One metadata query — bounded dollar cost.
 */
async function probeTrackingStats(
  sourceConnection: IDatabaseConnection,
  preparedQuery: string,
  trackingColumn: string,
  location: string | undefined,
): Promise<TrackingStats | null> {
  const probeSql = `SELECT
      CAST(MIN(\`${trackingColumn}\`) AS STRING) AS min_val,
      CAST(MAX(\`${trackingColumn}\`) AS STRING) AS max_val,
      COUNT(*) AS total_rows
    FROM (
${preparedQuery}
    ) AS __mako_probe`;

  try {
    const result = await databaseConnectionService.executeQuery(
      sourceConnection,
      probeSql,
      {
        bigQueryJobMaxWaitMs: 120_000,
        location,
      },
    );
    if (!result.success || !result.data?.length) return null;
    const row = result.data[0] as Record<string, unknown>;
    const minVal = row.min_val == null ? null : String(row.min_val);
    const maxVal = row.max_val == null ? null : String(row.max_val);
    const totalRows = Number(row.total_rows ?? 0);
    return { minVal, maxVal, totalRows };
  } catch (err) {
    log.warn("Slice probe failed; will fall back to single slice", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateOnly(s: string): Date | null {
  if (!DATE_ONLY_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysUtc(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/** Monday of the UTC week containing `d`. */
function weekStartUtc(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const offset = day === 0 ? -6 : 1 - day; // back to Monday
  return addDaysUtc(d, offset);
}

const SAFETY_NET_ROWS_PER_SLICE = 10_000_000;

/**
 * Partition the closed interval [minDate, maxDate] into slices on the tracking
 * column. Default cadence is weekly (Monday-anchored); if a week's estimated
 * row count exceeds the safety net, that week is subdivided to daily slices.
 *
 * Returns half-open ranges `[rangeStart, rangeEnd)` matching BulkSlice contract.
 */
function planDateSlices(
  minDate: Date,
  maxDate: Date,
  totalRows: number,
): BulkSlice[] {
  const totalDays = Math.max(
    1,
    Math.round((maxDate.getTime() - minDate.getTime()) / 86_400_000) + 1,
  );
  const rowsPerDay = totalRows / totalDays;
  const rowsPerWeek = rowsPerDay * 7;
  const subdivideWeek = rowsPerWeek > SAFETY_NET_ROWS_PER_SLICE;

  const slices: BulkSlice[] = [];
  let cursor = weekStartUtc(minDate);
  const end = addDaysUtc(maxDate, 1); // convert inclusive max -> exclusive end

  while (cursor < end) {
    const nextWeek = addDaysUtc(cursor, 7);

    if (!subdivideWeek) {
      const sliceEnd = nextWeek < end ? nextWeek : end;
      const startStr = formatDateOnly(cursor);
      const endStr = formatDateOnly(sliceEnd);
      slices.push({
        id: `w-${startStr}`,
        label: `${startStr} → ${endStr}`,
        rangeStart: startStr,
        rangeEnd: endStr,
        estimatedRows: Math.round(rowsPerWeek),
      });
      cursor = nextWeek;
      continue;
    }

    // Subdivide this week into days
    let day = cursor;
    while (day < nextWeek && day < end) {
      const nextDay = addDaysUtc(day, 1);
      const sliceEnd = nextDay < end ? nextDay : end;
      const startStr = formatDateOnly(day);
      const endStr = formatDateOnly(sliceEnd);
      slices.push({
        id: `d-${startStr}`,
        label: `${startStr} → ${endStr}`,
        rangeStart: startStr,
        rangeEnd: endStr,
        estimatedRows: Math.round(rowsPerDay),
      });
      day = nextDay;
    }
    cursor = nextWeek;
  }

  return slices;
}

// ---------------------------------------------------------------------------
// Storage Read streaming
// ---------------------------------------------------------------------------

async function* streamFromStorageApi(
  serviceAccountJson: string | object,
  tableRef: AnonTableRef,
  onLog?: BulkLogFn,
): AsyncGenerator<Record<string, unknown>> {
  const credentials = parseServiceAccountJson(serviceAccountJson);

  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/bigquery.readonly"],
  });

  const readClient = new BigQueryReadClient({ auth: auth as any });

  const table = `projects/${tableRef.projectId}/datasets/${tableRef.datasetId}/tables/${tableRef.tableId}`;
  const parent = `projects/${tableRef.projectId}`;

  log.info("Creating BigQuery Storage Read session", { table });
  onLog?.("info", "Opening BigQuery Storage Read session...");

  const [session] = await readClient.createReadSession({
    parent,
    readSession: {
      table,
      dataFormat: "AVRO",
    },
    maxStreamCount: 1,
  });

  if (!session.streams || session.streams.length === 0) {
    log.info("No streams returned — table is empty");
    onLog?.("info", "Result table is empty — nothing to stream");
    await readClient.close();
    return;
  }

  onLog?.(
    "info",
    `Streaming rows via ${session.streams.length} Avro stream(s)`,
  );

  const rawSchema = session.avroSchema?.schema;
  if (!rawSchema) {
    await readClient.close();
    throw new Error("BigQuery Storage Read session missing Avro schema");
  }
  const avroSchema = JSON.parse(rawSchema);
  const avroType = avro.Type.forSchema(avroSchema, {
    logicalTypes: {
      date: DateLogicalType,
      "timestamp-millis": TimestampMillisLogicalType,
      "timestamp-micros": TimestampMicrosLogicalType,
      "local-timestamp-millis": TimestampMillisLogicalType,
      "local-timestamp-micros": TimestampMicrosLogicalType,
      "time-millis": TimeMillisLogicalType,
      "time-micros": TimeMicrosLogicalType,
      decimal: DecimalLogicalType,
    } as any,
  });

  try {
    for (const stream of session.streams) {
      if (!stream.name) continue;
      const readRowsStream = readClient.readRows({
        readStream: stream.name,
        offset: 0,
      });

      for await (const response of readRowsStream) {
        if (!response.avroRows?.serializedBinaryRows) continue;

        const binaryData = response.avroRows.serializedBinaryRows;
        const data =
          binaryData instanceof Uint8Array
            ? Buffer.from(binaryData)
            : Buffer.from(binaryData as any);

        let pos = 0;
        while (pos < data.length) {
          const decoded = avroType.decode(data, pos);
          if (!decoded || decoded.offset === undefined) break;
          yield decoded.value as Record<string, unknown>;
          pos = decoded.offset;
        }
      }
    }
  } finally {
    await readClient.close();
  }
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export class BigQueryBulkExtractor implements BulkExtractor {
  async plan(params: {
    connection: IDatabaseConnection;
    query: string;
    syncMode: "full" | "incremental";
    incrementalConfig?: IIncrementalConfig;
    trackingColumn?: string;
    onLog?: BulkLogFn;
  }): Promise<BulkSlice[]> {
    const singleSlice: BulkSlice[] = [{ id: "all", label: "whole dataset" }];

    // Only partition on full backfills with a tracking column. Incremental
    // syncs already carry a high-water mark, so a single slice is simpler
    // (and Inngest-step-memoization is less valuable since the cursor advances
    // the next run anyway).
    if (params.syncMode !== "full" || !params.trackingColumn) {
      return singleSlice;
    }

    const preparedQuery = prepareBulkQuery(
      params.query,
      params.syncMode,
      params.incrementalConfig,
    );

    const conn = params.connection.connection as any;
    const location: string | undefined = conn.location;

    params.onLog?.(
      "info",
      `Probing tracking column range for slicing (column: ${params.trackingColumn})...`,
    );

    const stats = await probeTrackingStats(
      params.connection,
      preparedQuery,
      params.trackingColumn,
      location,
    );

    if (!stats || stats.totalRows === 0) {
      params.onLog?.(
        "info",
        "Probe returned no rows — proceeding with a single slice",
      );
      return singleSlice;
    }

    if (!stats.minVal || !stats.maxVal) {
      params.onLog?.(
        "info",
        `Probe reported ${stats.totalRows} rows but no min/max — single slice`,
      );
      return singleSlice;
    }

    const minDate = parseDateOnly(stats.minVal);
    const maxDate = parseDateOnly(stats.maxVal);

    if (!minDate || !maxDate) {
      params.onLog?.(
        "info",
        `Tracking column '${params.trackingColumn}' is not date-like (min=${stats.minVal}, max=${stats.maxVal}) — single slice`,
      );
      return singleSlice;
    }

    const slices = planDateSlices(minDate, maxDate, stats.totalRows);

    params.onLog?.(
      "info",
      `Planned ${slices.length} slice(s) over ${stats.totalRows.toLocaleString()} rows (${formatDateOnly(minDate)} → ${formatDateOnly(maxDate)})`,
      {
        totalRows: stats.totalRows,
        sliceCount: slices.length,
        minVal: stats.minVal,
        maxVal: stats.maxVal,
      },
    );

    return slices;
  }

  async extract(params: {
    connection: IDatabaseConnection;
    query: string;
    syncMode: "full" | "incremental";
    incrementalConfig?: IIncrementalConfig;
    trackingColumn?: string;
    slice?: BulkSlice;
    onLog?: BulkLogFn;
  }): Promise<BulkExtraction> {
    const conn = params.connection.connection as any;
    if (!conn.project_id || !conn.service_account_json) {
      throw new Error(
        "BigQuery connection requires project_id and service_account_json",
      );
    }

    const preparedQuery = prepareBulkQuery(
      params.query,
      params.syncMode,
      params.incrementalConfig,
    );

    let query = preparedQuery;
    let queryParams: Record<string, unknown> = {};
    if (params.slice && params.trackingColumn) {
      const wrapped = wrapQueryWithSliceFilter(
        preparedQuery,
        params.trackingColumn,
        params.slice,
      );
      query = wrapped.query;
      queryParams = wrapped.params;
    }

    log.info("Starting BigQuery bulk extraction", {
      syncMode: params.syncMode,
      hasIncremental: !!params.incrementalConfig?.lastValue,
      sliceId: params.slice?.id,
      sliceLabel: params.slice?.label,
    });
    params.onLog?.(
      "info",
      params.slice?.label
        ? `Starting extraction for slice ${params.slice.label}`
        : params.syncMode === "incremental" &&
            params.incrementalConfig?.lastValue
          ? `Starting incremental extraction (from ${params.incrementalConfig.trackingColumn} > ${params.incrementalConfig.lastValue})`
          : "Starting full extraction",
    );

    const tableRef = await runQueryAndGetDestination(
      params.connection,
      query,
      queryParams,
      params.onLog,
      params.slice?.label,
    );

    let maxTrackingValue: string | null = null;
    if (params.trackingColumn) {
      maxTrackingValue = await queryMaxTrackingValue(
        params.connection,
        tableRef,
        params.trackingColumn,
      );
      log.info("Max tracking value from result table", {
        trackingColumn: params.trackingColumn,
        maxTrackingValue,
        sliceId: params.slice?.id,
      });
      params.onLog?.(
        "info",
        `Slice max ${params.trackingColumn} = ${maxTrackingValue ?? "(empty slice)"}`,
        {
          trackingColumn: params.trackingColumn,
          maxTrackingValue,
          sliceId: params.slice?.id,
        },
      );
    }

    const rows = streamFromStorageApi(
      conn.service_account_json,
      tableRef,
      params.onLog,
    );

    return {
      rows,
      maxTrackingValue,
      // Anonymous result tables auto-expire (~24h), so no cleanup is required.
      cleanup: async () => {},
    };
  }
}
