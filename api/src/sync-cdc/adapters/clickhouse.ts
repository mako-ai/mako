import { promises as fs, createReadStream } from "fs";
import { createClient } from "@clickhouse/client";
import {
  DatabaseConnection,
  type IFlow,
  type IDatabaseConnection,
} from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { loggers } from "../../logging";
import { buildParquetFromBatches } from "../../utils/streaming-parquet-builder";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
  selectLatestChangePerRecord,
} from "../normalization";
import type { CdcStoredEvent } from "../events";
import type { CdcDestinationAdapter, CdcEntityLayout } from "./registry";
import type {
  ConnectorEntitySchema,
  ConnectorLogicalType,
} from "../../connectors/base/BaseConnector";

function mapLogicalTypeToClickHouse(logicalType: ConnectorLogicalType): string {
  switch (logicalType) {
    case "string":
      return "String";
    case "number":
      return "Float64";
    case "integer":
      return "Int64";
    case "boolean":
      return "Bool";
    case "timestamp":
      return "DateTime64(3)";
    case "json":
      return "String";
    default:
      return "String";
  }
}

const SYSTEM_COLUMN_TYPES: Record<string, string> = {
  _mako_ingest_seq: "Int64",
  _mako_source_ts: "DateTime64(3)",
  _mako_deleted_at: "Nullable(DateTime64(3))",
  is_deleted: "Bool",
  deleted_at: "Nullable(DateTime64(3))",
};

function resolveTargetChType(
  column: string,
  entitySchema: ConnectorEntitySchema | undefined,
  liveType: string | undefined,
): string {
  if (liveType) return liveType;
  const schemaField = entitySchema?.fields[column];
  if (schemaField) return mapLogicalTypeToClickHouse(schemaField.type);
  if (SYSTEM_COLUMN_TYPES[column]) return SYSTEM_COLUMN_TYPES[column];
  return "String";
}

const log = loggers.sync("cdc.adapter.clickhouse");

const escId = (id: string) => `\`${id.replace(/`/g, "``")}\``;

const escStr = (val: string) => val.replace(/'/g, "''");

interface ClickHouseAdapterConfig {
  destinationDatabaseId: string;
  destinationDatabaseName?: string;
  tableDestination: {
    connectionId: string;
    schema: string;
    tableName: string;
  };
}

export class ClickHouseDestinationAdapter implements CdcDestinationAdapter {
  readonly destinationType = "clickhouse";

  constructor(private readonly config: ClickHouseAdapterConfig) {}

  private _resolvedDestination?: IDatabaseConnection;

  private async resolveDestination(): Promise<IDatabaseConnection> {
    if (this._resolvedDestination) return this._resolvedDestination;
    const doc = await DatabaseConnection.findById(
      this.config.destinationDatabaseId,
    );
    if (!doc) {
      throw new Error(
        `Destination connection ${this.config.destinationDatabaseId} not found`,
      );
    }
    this._resolvedDestination = doc;
    return doc;
  }

  private getDatabase(): string {
    return this.config.tableDestination.schema || "default";
  }

  private getStagingTableName(
    tableName: string,
    flowId: string,
    suffix?: string,
  ): string {
    const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
    return `${tableName}__${flowToken}__${suffix || "staging"}`;
  }

  private async executeQuery(query: string): Promise<any> {
    const destination = await this.resolveDestination();
    return databaseConnectionService.executeQuery(destination, query);
  }

  async ensureLiveTable(_layout: CdcEntityLayout): Promise<void> {
    const db = this.getDatabase();
    await this.executeQuery(`CREATE DATABASE IF NOT EXISTS ${escId(db)}`);
  }

  private async ensureLiveTableFromSchema(
    layout: CdcEntityLayout,
    stagingColumnNames: string[],
    entitySchema?: ConnectorEntitySchema,
  ): Promise<void> {
    const db = this.getDatabase();
    const fullLive = `${escId(db)}.${escId(layout.tableName)}`;

    const colDefs = stagingColumnNames
      .map(col => {
        const chType = resolveTargetChType(col, entitySchema, undefined);
        const nullable =
          chType.startsWith("Nullable") ||
          SYSTEM_COLUMN_TYPES[col]?.startsWith("Nullable");
        return `${escId(col)} ${nullable ? chType : `Nullable(${chType})`}`;
      })
      .join(", ");

    const keyColumns = layout.keyColumns.map(escId).join(", ");

    let partitionClause = "";
    if (layout.partitioning?.field) {
      const field = escId(layout.partitioning.field);
      const gran = (layout.partitioning.granularity || "day").toLowerCase();
      switch (gran) {
        case "hour":
          partitionClause = `PARTITION BY toStartOfHour(${field})`;
          break;
        case "month":
          partitionClause = `PARTITION BY toYYYYMM(${field})`;
          break;
        case "year":
          partitionClause = `PARTITION BY toYear(${field})`;
          break;
        default:
          partitionClause = `PARTITION BY toYYYYMMDD(${field})`;
          break;
      }
    }

    const ddl = `CREATE TABLE IF NOT EXISTS ${fullLive} (${colDefs}) ENGINE = ReplacingMergeTree(_mako_source_ts) ${partitionClause} ORDER BY (${keyColumns})`;
    await this.executeQuery(ddl);
  }

  async applyEvents(params: {
    events: CdcStoredEvent[];
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
    entitySchema?: ConnectorEntitySchema;
  }): Promise<{ applied: number }> {
    if (params.events.length === 0) return { applied: 0 };

    const latest = selectLatestChangePerRecord(params.events);
    const fallbackDataSourceId = params.flow.dataSourceId
      ? String(params.flow.dataSourceId)
      : undefined;
    const upserts = latest.filter(e => e.operation === "upsert");
    const deletes = latest.filter(e => e.operation === "delete");
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
    if (params.records.length === 0) return { written: 0 };

    const fallbackDataSourceId = params.flow.dataSourceId
      ? String(params.flow.dataSourceId)
      : undefined;

    const rows = params.records.map(record => {
      const payload = normalizePayloadKeys(record);
      return {
        ...payload,
        _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
        _mako_source_ts: resolveSourceTimestamp(payload),
        _mako_ingest_seq:
          typeof payload._mako_ingest_seq === "number"
            ? payload._mako_ingest_seq
            : undefined,
      };
    });

    await this.writeViaParquet({
      records: rows,
      layout: params.layout,
      flow: params.flow,
      entitySchema: params.entitySchema,
    });

    return { written: rows.length };
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
    const db = this.getDatabase();
    await this.executeQuery(`CREATE DATABASE IF NOT EXISTS ${escId(db)}`);

    const stagingTable = this.getStagingTableName(
      layout.tableName,
      flowId,
      options?.stagingSuffix,
    );

    if (!options?.skipDrop) {
      await this.dropTable(stagingTable).catch(() => undefined);
    }

    return this.loadParquetToStaging(parquetPath, stagingTable, {
      skipDrop: options?.skipDrop,
      skipParquetCleanup: options?.skipParquetCleanup,
    });
  }

  async mergeFromStaging(
    layout: CdcEntityLayout,
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">,
    flowId: string,
    entitySchema?: ConnectorEntitySchema,
    options?: { stagingSuffix?: string },
  ): Promise<{ written: number }> {
    const stagingTable = this.getStagingTableName(
      layout.tableName,
      flowId,
      options?.stagingSuffix,
    );
    return this.mergeStagingToLive(layout, stagingTable, entitySchema);
  }

  async prepareStaging(
    layout: CdcEntityLayout,
    flowId: string,
    options?: { stagingSuffix?: string },
  ): Promise<void> {
    const db = this.getDatabase();
    await this.executeQuery(`CREATE DATABASE IF NOT EXISTS ${escId(db)}`);
    const stagingTable = this.getStagingTableName(
      layout.tableName,
      flowId,
      options?.stagingSuffix,
    );
    await this.dropTable(stagingTable).catch(() => undefined);
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
    await this.dropTable(stagingTable).catch(() => undefined);
  }

  private async loadParquetToStaging(
    parquetPath: string,
    stagingTable: string,
    options?: { skipDrop?: boolean; skipParquetCleanup?: boolean },
  ): Promise<{ loaded: number }> {
    const destination = await this.resolveDestination();
    const conn = destination.connection as any;
    const db = this.getDatabase();
    const fullStaging = `${escId(db)}.${escId(stagingTable)}`;

    const config = this.buildClientConfig(conn);
    const client = createClient(config);

    try {
      if (!options?.skipDrop) {
        await client.command({
          query: `DROP TABLE IF EXISTS ${fullStaging}`,
        });
      }

      const liveTable = this.config.tableDestination.tableName;
      const fullLive = `${escId(db)}.${escId(liveTable)}`;
      try {
        const createVerb = options?.skipDrop
          ? "CREATE TABLE IF NOT EXISTS"
          : "CREATE TABLE";
        await client.command({
          query: `${createVerb} ${fullStaging} AS ${fullLive} ENGINE = MergeTree() ORDER BY tuple()`,
        });
      } catch (err) {
        if (!options?.skipDrop) {
          log.info(
            "Live table not found, creating staging from Parquet insert",
            { stagingTable, liveTable },
          );
        } else {
          throw err;
        }
      }

      const parquetStream = createReadStream(parquetPath);
      await client.insert({
        table: `${db}.${stagingTable}`,
        values: parquetStream as any,
        format: "Parquet",
      });

      const countResult = await client.query({
        query: `SELECT count() as cnt FROM ${fullStaging}`,
        format: "JSONEachRow",
      });
      const countRows = await countResult.json<{ cnt: string }>();
      const loaded = Number(countRows[0]?.cnt || 0);

      log.info("Loaded Parquet to ClickHouse staging", {
        stagingTable,
        loaded,
        parquetPath,
      });

      if (!options?.skipParquetCleanup) {
        await fs.rm(parquetPath, { force: true }).catch(() => undefined);
      }
      return { loaded };
    } finally {
      await client.close();
    }
  }

  private async mergeStagingToLive(
    layout: CdcEntityLayout,
    stagingTable: string,
    entitySchema?: ConnectorEntitySchema,
  ): Promise<{ written: number }> {
    const db = this.getDatabase();
    const fullLive = `${escId(db)}.${escId(layout.tableName)}`;
    const fullStaging = `${escId(db)}.${escId(stagingTable)}`;

    const stagingColsResult = await this.executeQuery(
      `SELECT name, type FROM system.columns WHERE database = '${escStr(db)}' AND table = '${escStr(stagingTable)}'`,
    );
    const stagingCols = new Map<string, string>();
    for (const row of stagingColsResult?.data || []) {
      stagingCols.set(row.name, row.type);
    }

    if (stagingCols.size === 0) {
      log.info("Staging table empty or missing, skipping merge", {
        stagingTable,
      });
      return { written: 0 };
    }

    const liveColsResult = await this.executeQuery(
      `SELECT name, type FROM system.columns WHERE database = '${escStr(db)}' AND table = '${escStr(layout.tableName)}'`,
    );
    const liveCols = new Map<string, string>();
    for (const row of liveColsResult?.data || []) {
      liveCols.set(row.name, row.type);
    }

    if (liveCols.size === 0) {
      await this.ensureLiveTableFromSchema(
        layout,
        [...stagingCols.keys()],
        entitySchema,
      );
      const refreshResult = await this.executeQuery(
        `SELECT name, type FROM system.columns WHERE database = '${escStr(db)}' AND table = '${escStr(layout.tableName)}'`,
      );
      for (const row of refreshResult?.data || []) {
        liveCols.set(row.name, row.type);
      }
    }

    const missingInLive = [...stagingCols.keys()].filter(c => !liveCols.has(c));
    for (const col of missingInLive) {
      const colType = resolveTargetChType(col, entitySchema, undefined);
      const nullableType = colType.startsWith("Nullable")
        ? colType
        : `Nullable(${colType})`;
      await this.executeQuery(
        `ALTER TABLE ${fullLive} ADD COLUMN IF NOT EXISTS ${escId(col)} ${nullableType}`,
      );
      liveCols.set(col, nullableType);
    }

    const keyColumns = layout.keyColumns.filter(k => stagingCols.has(k));
    if (keyColumns.length === 0) {
      throw new Error(
        `None of the key columns [${layout.keyColumns.join(", ")}] exist in staging table ${stagingTable}`,
      );
    }

    const allColumns = [
      ...new Set([...liveCols.keys(), ...stagingCols.keys()]),
    ];
    const dedupKey = keyColumns.map(escId).join(", ");
    const hasSourceTs = stagingCols.has("_mako_source_ts");
    const orderExpr = hasSourceTs ? `${escId("_mako_source_ts")} DESC` : "1";

    const selectCols = allColumns
      .map(c => {
        if (!stagingCols.has(c)) return `NULL AS ${escId(c)}`;
        return escId(c);
      })
      .join(", ");

    const colList = allColumns.map(escId).join(", ");

    const deleteStmt = `ALTER TABLE ${fullLive} DELETE WHERE (${keyColumns.map(escId).join(", ")}) IN (SELECT ${keyColumns.map(escId).join(", ")} FROM ${fullStaging})`;

    const insertStmt = `INSERT INTO ${fullLive} (${colList}) SELECT ${selectCols} FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY ${dedupKey} ORDER BY ${orderExpr}) AS __rn FROM ${fullStaging}) WHERE __rn = 1`;

    try {
      await this.executeQuery(deleteStmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("UNKNOWN_TABLE") && !msg.includes("TABLE_NOT_FOUND")) {
        log.warn("ClickHouse delete before merge failed", {
          error: msg,
          table: layout.tableName,
        });
      }
    }

    await this.executeQuery(insertStmt);

    log.info("ClickHouse merge complete", {
      live: layout.tableName,
      staging: stagingTable,
    });

    return { written: 0 };
  }

  private async writeViaParquet(params: {
    records: Record<string, unknown>[];
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
    entitySchema?: ConnectorEntitySchema;
  }): Promise<{ written: number }> {
    const flowId = String(params.flow._id);
    const stagingSuffix = `stg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const parquet = await buildParquetFromBatches({
      filenameBase: `cdc-${params.layout.entity}`,
      streamBatches: async insertBatch => {
        await insertBatch(params.records);
      },
    });

    try {
      await this.loadStagingFromParquet(
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
        { stagingSuffix },
      );
    } finally {
      await this.cleanupStaging(params.layout, flowId, { stagingSuffix }).catch(
        err => {
          log.warn("Failed to cleanup staging after writeViaParquet", {
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
    const db = this.getDatabase();
    const fullLive = `${escId(db)}.${escId(layout.tableName)}`;

    const ids = deletes.map(e => `'${escStr(String(e.recordId))}'`);
    const CHUNK = 10_000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      let where = `${escId("id")} IN (${chunk.join(", ")})`;
      if (fallbackDataSourceId) {
        where += ` AND ${escId("_dataSourceId")} = '${escStr(fallbackDataSourceId)}'`;
      }
      try {
        await this.executeQuery(
          `ALTER TABLE ${fullLive} DELETE WHERE ${where}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          !msg.includes("UNKNOWN_TABLE") &&
          !msg.includes("TABLE_NOT_FOUND")
        ) {
          throw err;
        }
      }
    }
  }

  private async dropTable(tableName: string): Promise<void> {
    const db = this.getDatabase();
    await this.executeQuery(
      `DROP TABLE IF EXISTS ${escId(db)}.${escId(tableName)}`,
    );
  }

  private buildClientConfig(conn: any): {
    url: string;
    username: string;
    password: string;
    database: string;
    request_timeout: number;
    keep_alive: { enabled: boolean; idle_socket_ttl: number };
  } {
    const baseConfig = {
      request_timeout: 120_000,
      keep_alive: { enabled: true, idle_socket_ttl: 2500 },
    };

    if (conn.connectionString) {
      const parsed = this.parseConnectionString(conn.connectionString);
      return { ...parsed, ...baseConfig };
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
      database: conn.database || this.getDatabase(),
      ...baseConfig,
    };
  }

  /**
   * Load Parquet files from GCS directly into a ClickHouse table using
   * the gcs() table function. Requires GCS HMAC keys for authentication.
   */
  async loadFromGcs(params: {
    gcsUri: string;
    targetTable: string;
    hmacAccessKey: string;
    hmacSecretKey: string;
    columns?: string[];
  }): Promise<{ loaded: number }> {
    const dest = await this.resolveDestination();
    const conn = dest.connection as any;
    const config = this.buildClientConfig(conn);
    const client = createClient(config);
    const db = this.getDatabase();
    const fullTable = `${escId(db)}.${escId(params.targetTable)}`;
    const httpsUri = params.gcsUri.replace(
      /^gs:\/\//,
      "https://storage.googleapis.com/",
    );
    const colExpr = params.columns ? params.columns.map(escId).join(", ") : "*";

    try {
      const insertSql = `INSERT INTO ${fullTable}
SELECT ${colExpr} FROM gcs(
  '${escStr(httpsUri)}',
  '${escStr(params.hmacAccessKey)}',
  '${escStr(params.hmacSecretKey)}',
  'Parquet'
)`;

      await client.command({
        query: insertSql,
        clickhouse_settings: { wait_end_of_query: 1 },
      });

      const countResult = await client.query({
        query: `SELECT count() as cnt FROM ${fullTable}`,
        format: "JSONEachRow",
      });
      const countRows = await countResult.json<{ cnt: string }>();
      return { loaded: Number(countRows[0]?.cnt || 0) };
    } finally {
      await client.close();
    }
  }

  private parseConnectionString(connectionString: string): {
    url: string;
    username: string;
    password: string;
    database: string;
  } {
    let normalized = connectionString.trim();
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
      this.getDatabase();

    return {
      url: `${protocol}://${host}:${port}`,
      username: decodeURIComponent(user),
      password: decodeURIComponent(password),
      database,
    };
  }
}
