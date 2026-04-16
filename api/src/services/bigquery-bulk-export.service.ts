import { BigQueryReadClient } from "@google-cloud/bigquery-storage";
import { GoogleAuth } from "google-auth-library";
import avro from "avsc";
import { createClient } from "@clickhouse/client";
import type {
  IDatabaseConnection,
  IIncrementalConfig,
} from "../database/workspace-schema";
import { databaseConnectionService } from "./database-connection.service";
import { substituteTemplates } from "../utils/template-substitution";
import { loggers } from "../logging";

const log = loggers.sync("bulk-export");

const LIMIT_OFFSET_TAIL =
  /\s+LIMIT\s+\{\{\s*limit\s*\}\}(\s+OFFSET\s+\{\{\s*offset\s*\}\})?\s*$/i;

export interface BulkStreamOptions {
  sourceConnection: IDatabaseConnection;
  sourceQuery: string;
  syncMode: "full" | "incremental";
  incrementalConfig?: IIncrementalConfig;
  batchSize?: number;
  onBatch: (rows: Record<string, unknown>[]) => Promise<void>;
  onProgress?: (rowsRead: number) => void;
}

export interface BulkStreamResult {
  totalRows: number;
}

/**
 * Prepare the source query for bulk read by substituting
 * {{last_sync_value}} and stripping {{limit}}/{{offset}}.
 */
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

/**
 * Run the user's SQL query via the existing BigQuery Jobs API and write
 * results to a temp table. Returns the temp table reference for the
 * Storage Read API to consume.
 */
async function materializeToTempTable(
  sourceConnection: IDatabaseConnection,
  query: string,
): Promise<{
  projectId: string;
  datasetId: string;
  tableId: string;
}> {
  const conn = sourceConnection.connection as any;
  const projectId = conn.project_id;
  const location = conn.location;

  const tempDataset = "_mako_temp";
  const tempTable = `bulk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const ensureDatasetSql = `CREATE SCHEMA IF NOT EXISTS \`${projectId}.${tempDataset}\` OPTIONS(location="${location || "US"}")`;
  await databaseConnectionService.executeQuery(
    sourceConnection,
    ensureDatasetSql,
    {
      bigQueryJobMaxWaitMs: 60_000,
      location,
    },
  );

  const createTableSql = `CREATE OR REPLACE TABLE \`${projectId}.${tempDataset}.${tempTable}\`
OPTIONS(expiration_timestamp=TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR))
AS
${query}`;

  log.info("Materializing query to temp table", {
    projectId,
    dataset: tempDataset,
    table: tempTable,
  });

  const result = await databaseConnectionService.executeQuery(
    sourceConnection,
    createTableSql,
    {
      bigQueryJobMaxWaitMs: 30 * 60 * 1000,
      location,
    },
  );

  if (!result.success) {
    throw new Error(`Failed to materialize temp table: ${result.error}`);
  }

  return { projectId, datasetId: tempDataset, tableId: tempTable };
}

/**
 * Stream rows from a BigQuery table using the Storage Read API.
 * Uses Avro format for efficient binary deserialization.
 */
async function streamFromStorageApi(
  serviceAccountJson: string | object,
  projectId: string,
  datasetId: string,
  tableId: string,
  batchSize: number,
  onBatch: (rows: Record<string, unknown>[]) => Promise<void>,
  onProgress?: (rowsRead: number) => void,
): Promise<number> {
  const credentials = parseServiceAccountJson(serviceAccountJson);

  const auth = new GoogleAuth({
    credentials: {
      client_email: credentials.client_email as string,
      private_key: credentials.private_key as string,
    },
    scopes: ["https://www.googleapis.com/auth/bigquery.readonly"],
  });

  const readClient = new BigQueryReadClient({ auth: auth as any });

  const table = `projects/${projectId}/datasets/${datasetId}/tables/${tableId}`;
  const parent = `projects/${projectId}`;

  log.info("Creating BigQuery Storage Read session", {
    table,
    parent,
  });

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
    return 0;
  }

  const avroSchema = JSON.parse(session.avroSchema!.schema!);
  const avroType = avro.Type.forSchema(avroSchema);

  let totalRows = 0;
  let buffer: Record<string, unknown>[] = [];

  for (const stream of session.streams) {
    const readRowsStream = readClient.readRows({
      readStream: stream.name!,
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
        buffer.push(decoded.value as Record<string, unknown>);
        pos = decoded.offset;
        totalRows++;

        if (buffer.length >= batchSize) {
          await onBatch(buffer);
          onProgress?.(totalRows);
          buffer = [];
        }
      }
    }
  }

  if (buffer.length > 0) {
    await onBatch(buffer);
    onProgress?.(totalRows);
  }

  await readClient.close();

  return totalRows;
}

/**
 * Drop a BigQuery temp table (best-effort cleanup).
 */
async function dropTempTable(
  sourceConnection: IDatabaseConnection,
  projectId: string,
  datasetId: string,
  tableId: string,
): Promise<void> {
  try {
    await databaseConnectionService.executeQuery(
      sourceConnection,
      `DROP TABLE IF EXISTS \`${projectId}.${datasetId}.${tableId}\``,
      {
        bigQueryJobMaxWaitMs: 30_000,
        location: (sourceConnection.connection as any)?.location,
      },
    );
    log.info("Dropped temp table", { projectId, datasetId, tableId });
  } catch (err) {
    log.warn("Failed to drop temp table (will auto-expire in 24h)", {
      projectId,
      datasetId,
      tableId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Stream BigQuery query results to a callback via the Storage Read API.
 *
 * Flow: Run query → materialize to temp table → stream via gRPC →
 * call onBatch for each chunk → drop temp table.
 */
export async function streamBigQueryViaStorageApi(
  options: BulkStreamOptions,
): Promise<BulkStreamResult> {
  const {
    sourceConnection,
    syncMode,
    incrementalConfig,
    batchSize = 50_000,
    onBatch,
    onProgress,
  } = options;

  const conn = sourceConnection.connection as any;
  if (!conn.project_id || !conn.service_account_json) {
    throw new Error(
      "BigQuery connection requires project_id and service_account_json",
    );
  }

  const query = prepareBulkQuery(
    options.sourceQuery,
    syncMode,
    incrementalConfig,
  );

  log.info("Starting BigQuery Storage Read API bulk stream", {
    syncMode,
    hasIncremental: !!incrementalConfig?.lastValue,
  });

  const tempRef = await materializeToTempTable(sourceConnection, query);

  try {
    const totalRows = await streamFromStorageApi(
      conn.service_account_json,
      tempRef.projectId,
      tempRef.datasetId,
      tempRef.tableId,
      batchSize,
      onBatch,
      onProgress,
    );

    log.info("BigQuery Storage Read API stream complete", { totalRows });
    return { totalRows };
  } finally {
    await dropTempTable(
      sourceConnection,
      tempRef.projectId,
      tempRef.datasetId,
      tempRef.tableId,
    );
  }
}

/**
 * Check if a flow can use the bulk read path.
 * Only requires a BigQuery source — no external infra needed.
 */
export function canUseBulkRead(
  sourceType?: string,
  bulkExportConfig?: { enabled?: boolean },
): boolean {
  if (bulkExportConfig?.enabled === false) return false;
  return sourceType === "bigquery";
}

// ── ClickHouse helpers (kept from prior implementation) ──

function buildClickHouseClientConfig(conn: any): {
  url: string;
  username: string;
  password: string;
  database: string;
  request_timeout: number;
  keep_alive: { enabled: boolean; idle_socket_ttl: number };
} {
  const baseConfig = {
    request_timeout: 600_000,
    keep_alive: { enabled: true, idle_socket_ttl: 2500 },
  };

  if (conn.connectionString) {
    let normalized = conn.connectionString.trim();
    if (normalized.startsWith("jdbc:clickhouse://")) {
      normalized = normalized.replace("jdbc:clickhouse://", "https://");
    } else if (normalized.startsWith("clickhouse://")) {
      normalized = normalized.replace("clickhouse://", "https://");
    }

    const url = new URL(normalized);
    const protocol = url.protocol === "https:" ? "https" : "http";
    const host = url.hostname;
    const port = url.port || (protocol === "https" ? "8443" : "8123");
    const user =
      url.searchParams.get("user") ||
      url.searchParams.get("username") ||
      url.username ||
      "default";
    const password = url.searchParams.get("password") || url.password || "";
    const database =
      url.searchParams.get("database") ||
      url.pathname.replace(/^\//, "") ||
      "default";

    return {
      url: `${protocol}://${host}:${port}`,
      username: decodeURIComponent(user),
      password: decodeURIComponent(password),
      database,
      ...baseConfig,
    };
  }

  let host = conn.host || "http://localhost";
  if (!host.startsWith("http://") && !host.startsWith("https://")) {
    host = (conn.ssl ? "https://" : "http://") + host;
  }

  const port = conn.port || (conn.ssl ? 8443 : 8123);
  const url = new URL(host);
  url.port = String(port);

  return {
    url: url.toString().replace(/\/$/, ""),
    username: conn.username || conn.user || "default",
    password: conn.password || "",
    database: conn.database || "default",
    ...baseConfig,
  };
}

const escId = (id: string) => `\`${id.replace(/`/g, "``")}\``;

/**
 * Get the max value of the tracking column from the ClickHouse destination.
 * Used after bulk load to update incrementalConfig.lastValue.
 */
export async function getClickHouseMaxTrackingValue(
  clickhouseConnection: IDatabaseConnection,
  targetDatabase: string,
  targetTable: string,
  trackingColumn: string,
): Promise<string | null> {
  const conn = clickhouseConnection.connection as any;
  const config = buildClickHouseClientConfig(conn);
  const client = createClient(config);

  const fullTable = `${escId(targetDatabase)}.${escId(targetTable)}`;

  try {
    const result = await client.query({
      query: `SELECT max(${escId(trackingColumn)}) as max_val FROM ${fullTable}`,
      format: "JSONEachRow",
    });
    const rows = await result.json<{ max_val: string }>();
    const maxVal = rows[0]?.max_val;
    return maxVal && maxVal !== "0000-00-00" && maxVal !== "1970-01-01"
      ? String(maxVal)
      : null;
  } finally {
    await client.close();
  }
}
