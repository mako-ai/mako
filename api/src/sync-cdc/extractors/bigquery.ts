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
import type { BulkExtraction, BulkExtractor, BulkLogFn } from "./registry";

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
  onLog?: BulkLogFn,
): Promise<AnonTableRef> {
  const conn = sourceConnection.connection as any;
  const projectId: string = conn.project_id;
  const location: string | undefined = conn.location;
  const credentials = parseServiceAccountJson(conn.service_account_json);

  const bq = new BigQuery({ projectId, credentials, location });

  log.info("Submitting BigQuery query job", { projectId, location });
  onLog?.("info", "Submitting BigQuery query job (materializing results)...", {
    projectId,
    location,
  });

  const startedAt = Date.now();
  const [job] = await bq.createQueryJob({
    query,
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
  });
  onLog?.(
    "info",
    `Query materialized in ${elapsedSec}s${bytesProcessed ? ` (${formatBytes(Number(bytesProcessed))} processed)` : ""}`,
    { elapsedSec, bytesProcessed, slotMs },
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

export class BigQueryBulkExtractor implements BulkExtractor {
  async extract(params: {
    connection: IDatabaseConnection;
    query: string;
    syncMode: "full" | "incremental";
    incrementalConfig?: IIncrementalConfig;
    trackingColumn?: string;
    onLog?: BulkLogFn;
  }): Promise<BulkExtraction> {
    const conn = params.connection.connection as any;
    if (!conn.project_id || !conn.service_account_json) {
      throw new Error(
        "BigQuery connection requires project_id and service_account_json",
      );
    }

    const query = prepareBulkQuery(
      params.query,
      params.syncMode,
      params.incrementalConfig,
    );

    log.info("Starting BigQuery bulk extraction", {
      syncMode: params.syncMode,
      hasIncremental: !!params.incrementalConfig?.lastValue,
    });
    params.onLog?.(
      "info",
      params.syncMode === "incremental" && params.incrementalConfig?.lastValue
        ? `Starting incremental extraction (from ${params.incrementalConfig.trackingColumn} > ${params.incrementalConfig.lastValue})`
        : "Starting full extraction",
    );

    const tableRef = await runQueryAndGetDestination(
      params.connection,
      query,
      params.onLog,
    );

    let maxTrackingValue: string | null = null;
    if (params.syncMode === "incremental" && params.trackingColumn) {
      maxTrackingValue = await queryMaxTrackingValue(
        params.connection,
        tableRef,
        params.trackingColumn,
      );
      log.info("Max tracking value from result table", {
        trackingColumn: params.trackingColumn,
        maxTrackingValue,
      });
      params.onLog?.(
        "info",
        `Next checkpoint: ${params.trackingColumn} = ${maxTrackingValue ?? "(none — result empty)"}`,
        { trackingColumn: params.trackingColumn, maxTrackingValue },
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
