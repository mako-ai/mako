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
import type { BulkExtraction, BulkExtractor } from "./registry";

const log = loggers.sync("bulk-extractor.bigquery");

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

interface TempTableRef {
  projectId: string;
  datasetId: string;
  tableId: string;
  location: string;
}

async function materializeToTempTable(
  sourceConnection: IDatabaseConnection,
  query: string,
): Promise<TempTableRef> {
  const conn = sourceConnection.connection as any;
  const projectId: string = conn.project_id;
  const location: string = conn.location || "US";

  const tempDataset = "_mako_temp";
  const tempTable = `bulk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const ensureDatasetSql = `CREATE SCHEMA IF NOT EXISTS \`${projectId}.${tempDataset}\` OPTIONS(location="${location}")`;
  await databaseConnectionService.executeQuery(
    sourceConnection,
    ensureDatasetSql,
    { bigQueryJobMaxWaitMs: 60_000, location },
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
    { bigQueryJobMaxWaitMs: 30 * 60 * 1000, location },
  );

  if (!result.success) {
    throw new Error(`Failed to materialize temp table: ${result.error}`);
  }

  return { projectId, datasetId: tempDataset, tableId: tempTable, location };
}

async function queryMaxTrackingValue(
  sourceConnection: IDatabaseConnection,
  tempRef: TempTableRef,
  trackingColumn: string,
): Promise<string | null> {
  const fullTable = `\`${tempRef.projectId}.${tempRef.datasetId}.${tempRef.tableId}\``;
  const sql = `SELECT CAST(MAX(\`${trackingColumn}\`) AS STRING) AS max_val FROM ${fullTable}`;

  const result = await databaseConnectionService.executeQuery(
    sourceConnection,
    sql,
    {
      bigQueryJobMaxWaitMs: 60_000,
      location: tempRef.location,
    },
  );

  if (!result.success || !result.data?.length) return null;
  const maxVal = result.data[0]?.max_val;
  return maxVal && maxVal !== "null" ? String(maxVal) : null;
}

async function dropTempTable(
  sourceConnection: IDatabaseConnection,
  tempRef: TempTableRef,
): Promise<void> {
  try {
    await databaseConnectionService.executeQuery(
      sourceConnection,
      `DROP TABLE IF EXISTS \`${tempRef.projectId}.${tempRef.datasetId}.${tempRef.tableId}\``,
      {
        bigQueryJobMaxWaitMs: 30_000,
        location: tempRef.location,
      },
    );
    log.info("Dropped temp table", { ...tempRef });
  } catch (err) {
    log.warn("Failed to drop temp table (will auto-expire in 24h)", {
      ...tempRef,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function* streamFromStorageApi(
  serviceAccountJson: string | object,
  tempRef: TempTableRef,
): AsyncGenerator<Record<string, unknown>> {
  const credentials = parseServiceAccountJson(serviceAccountJson);

  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/bigquery.readonly"],
  });

  const readClient = new BigQueryReadClient({ auth: auth as any });

  const table = `projects/${tempRef.projectId}/datasets/${tempRef.datasetId}/tables/${tempRef.tableId}`;
  const parent = `projects/${tempRef.projectId}`;

  log.info("Creating BigQuery Storage Read session", { table });

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
    await readClient.close();
    return;
  }

  const rawSchema = session.avroSchema?.schema;
  if (!rawSchema) {
    await readClient.close();
    throw new Error("BigQuery Storage Read session missing Avro schema");
  }
  const avroSchema = JSON.parse(rawSchema);
  const avroType = avro.Type.forSchema(avroSchema);

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

    const tempRef = await materializeToTempTable(params.connection, query);

    let maxTrackingValue: string | null = null;
    if (params.syncMode === "incremental" && params.trackingColumn) {
      maxTrackingValue = await queryMaxTrackingValue(
        params.connection,
        tempRef,
        params.trackingColumn,
      );
      log.info("Max tracking value from temp table", {
        trackingColumn: params.trackingColumn,
        maxTrackingValue,
      });
    }

    const rows = streamFromStorageApi(conn.service_account_json, tempRef);

    return {
      rows,
      maxTrackingValue,
      cleanup: () => dropTempTable(params.connection, tempRef),
    };
  }
}
