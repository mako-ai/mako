import { promises as fs } from "fs";
import { BigQuery } from "@google-cloud/bigquery";
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

// ---------------------------------------------------------------------------
// Schema contract: one source of truth for BigQuery column types.
// Staging is always VARCHAR (from Parquet). Live table uses these types.
// INSERT SELECT casts VARCHAR staging → typed live columns.
// ---------------------------------------------------------------------------

function mapLogicalTypeToBigQuery(logicalType: ConnectorLogicalType): string {
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
  // When the live table already existed, its types win so INSERT ... SELECT
  // matches BigQuery (e.g. legacy STRING vs schema TIMESTAMP — avoids cast errors).
  // When the table was just CREATE/ALTER'd from our schema, liveType comes from
  // INFORMATION_SCHEMA after create (see mergeStagingToLive refresh) and matches schema.
  if (liveType) return liveType;
  const schemaField = entitySchema?.fields[column];
  if (schemaField) {
    const schemaType = mapLogicalTypeToBigQuery(schemaField.type);
    if (liveType && liveType.toUpperCase() !== schemaType.toUpperCase()) {
      log.warn(
        "Live table column type differs from connector schema; using live type to avoid INSERT failure. " +
          "Recreate the destination table to adopt the correct schema type.",
        { column, schemaType, liveType },
      );
      return liveType;
    }
    return schemaType;
  }
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
    options?: { stagingSuffix?: string; skipDrop?: boolean },
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
    return this.loadParquetToStaging(parquetPath, stagingTable);
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

  private async mergeStagingToLive(
    layout: CdcEntityLayout,
    stagingTable: string,
    entitySchema?: ConnectorEntitySchema,
  ): Promise<{ written: number }> {
    const { projectId, dataset, destination, datasetLocation } =
      await this.resolveBqClient();
    const liveTable = layout.tableName;

    const fullLive = `${escId(projectId)}.${escId(dataset)}.${escId(liveTable)}`;
    const fullStaging = `${escId(projectId)}.${escId(dataset)}.${escId(stagingTable)}`;

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

    log.info("INFORMATION_SCHEMA result", {
      stagingTable,
      liveTable,
      dataset,
      rowCount: Array.isArray(schemaResult.data) ? schemaResult.data.length : 0,
    });

    const stagingCols = new Set<string>();
    const liveCols = new Set<string>();
    const liveTypes = new Map<string, string>();
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
      // Re-read live columns from BigQuery so types match the created table (connector
      // schema). Do not infer types only in JS — reset-entity + fresh CREATE must use
      // TIMESTAMP etc. as actually defined in BQ, same as ongoing merges use live types.
      const refreshResult = await databaseConnectionService.executeQuery(
        destination,
        infoSchemaQuery,
        { location: datasetLocation },
      );
      if (!refreshResult.success) {
        throw new Error(
          refreshResult.error ||
            "INFORMATION_SCHEMA refresh failed after creating live table",
        );
      }
      for (const r of (refreshResult.data as any[]) || []) {
        const tbl = r.table_name as string;
        const col = r.column_name as string;
        const dt = r.data_type as string;
        if (tbl === liveTable) {
          liveCols.add(col);
          liveTypes.set(col, dt);
        }
      }
      log.info("Live table types loaded from INFORMATION_SCHEMA after CREATE", {
        liveTable,
        columnCount: liveCols.size,
      });
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
      log.info("Added missing columns to live table from staging", {
        liveTable,
        addedColumns: addedToLive,
      });
    }

    // Staging columns come from Parquet only — no ALTER TABLE needed.
    // Missing columns in staging are projected as NULL in the INSERT SELECT.

    // Target columns must exist on live table.
    const allColumns = Array.from(liveCols);

    const keyColumns = layout.keyColumns;
    const missingKeyInLive = keyColumns.filter(k => !liveCols.has(k));
    const missingKeyInStaging = keyColumns.filter(k => !stagingCols.has(k));
    if (missingKeyInLive.length > 0 || missingKeyInStaging.length > 0) {
      throw new Error(
        `Missing key columns for MERGE (live: [${missingKeyInLive.join(", ")}], staging: [${missingKeyInStaging.join(", ")}])`,
      );
    }

    const dedupKey = keyColumns.map(escId).join(", ");
    const buildMergeStatements = (columns: string[]): string[] => {
      const hasSourceTs = columns.includes("_mako_source_ts");
      const orderExpr = hasSourceTs ? `\`_mako_source_ts\` DESC` : "1";

      const selectCols = columns
        .map(c => {
          if (!stagingCols.has(c)) {
            const targetType = resolveTargetBqType(
              c,
              entitySchema,
              liveTypes.get(c),
            );
            return `CAST(NULL AS ${targetType}) AS ${escId(c)}`;
          }
          return buildColumnSelectExpr(
            c,
            escId,
            entitySchema,
            liveTypes.get(c),
          );
        })
        .join(", ");

      const colList = columns.map(escId).join(", ");

      const keyJoin = keyColumns
        .map(k => `__live.${escId(k)} = __stg.${escId(k)}`)
        .join(" AND ");

      const deleteStmt = `DELETE FROM ${fullLive} __live WHERE EXISTS (SELECT 1 FROM ${fullStaging} __stg WHERE ${keyJoin})`;

      const insertStmt = `INSERT INTO ${fullLive} (${colList}) SELECT ${selectCols} FROM ${fullStaging} QUALIFY ROW_NUMBER() OVER (PARTITION BY ${dedupKey} ORDER BY ${orderExpr}) = 1`;

      return [deleteStmt, insertStmt];
    };

    const mergeMaxWaitEnv = Number.parseInt(
      process.env.BIGQUERY_MERGE_MAX_WAIT_MS || "",
      10,
    );
    const mergeMaxWaitMs =
      Number.isFinite(mergeMaxWaitEnv) && mergeMaxWaitEnv >= 10_000
        ? Math.min(mergeMaxWaitEnv, 60 * 60 * 1000)
        : 50 * 60 * 1000;

    const [deleteStmt, insertStmt] = buildMergeStatements(allColumns);

    const deleteResult = await databaseConnectionService.executeQuery(
      destination,
      deleteStmt,
      { bigQueryJobMaxWaitMs: mergeMaxWaitMs, location: datasetLocation },
    );
    if (!deleteResult.success) {
      const notFound =
        deleteResult.error &&
        /not found|does not exist/i.test(deleteResult.error);
      if (!notFound) {
        log.error("BigQuery DELETE before INSERT failed", {
          liveTable,
          stagingTable,
          error: deleteResult.error,
        });
        throw new Error(deleteResult.error || "BigQuery DELETE failed");
      }
    }

    const insertResult = await databaseConnectionService.executeQuery(
      destination,
      insertStmt,
      { bigQueryJobMaxWaitMs: mergeMaxWaitMs, location: datasetLocation },
    );
    if (!insertResult.success) {
      log.error("BigQuery INSERT from staging failed", {
        liveTable,
        stagingTable,
        error: insertResult.error,
        insertPreview: insertStmt.slice(0, 900),
      });
      throw new Error(insertResult.error || "BigQuery INSERT failed");
    }

    log.info("Merged staging to live table via DELETE+INSERT", {
      liveTable,
      stagingTable,
      dataset,
      skippedLiveAdds,
    });

    return { written: 0 };
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

  private async resolveBqClient(): Promise<{
    bq: InstanceType<typeof BigQuery>;
    projectId: string;
    dataset: string;
    destination: IDatabaseConnection;
    datasetLocation: string | undefined;
  }> {
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

    return {
      bq,
      projectId,
      dataset,
      destination,
      datasetLocation: this._datasetLocation,
    };
  }

  private async ensureDataset(): Promise<void> {
    const { bq, dataset } = await this.resolveBqClient();
    await bq.dataset(dataset).get({ autoCreate: true });
  }

  private async loadParquetToStaging(
    parquetPath: string,
    stagingTable: string,
  ): Promise<{ loaded: number }> {
    const { bq, dataset } = await this.resolveBqClient();

    const [metadata] = await bq
      .dataset(dataset)
      .table(stagingTable)
      .load(parquetPath, {
        sourceFormat: "PARQUET",
        writeDisposition: "WRITE_APPEND",
        schemaUpdateOptions: ["ALLOW_FIELD_ADDITION"],
      });

    const jobMeta = metadata as Record<string, any>;
    if (jobMeta?.status?.errorResult) {
      throw new Error(
        jobMeta.status.errorResult.message || "BigQuery load job failed",
      );
    }

    const loaded = Number(jobMeta?.statistics?.load?.outputRows || 0);

    await fs.rm(parquetPath, { force: true }).catch(() => undefined);

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

    await this.ensureDataset();

    const parquet = await buildParquetFromBatches({
      filenameBase: `cdc-${params.layout.entity}`,
      streamBatches: async insertBatch => {
        await insertBatch(params.records);
      },
    });

    log.info("writeViaParquet: built Parquet for CDC batch", {
      table: params.layout.tableName,
      rows: params.records.length,
      parquetBytes: parquet.byteSize,
      flowId,
    });

    try {
      await this.loadStagingFromParquet(
        parquet.filePath,
        params.layout,
        flowId,
      );
      await this.mergeFromStaging(
        params.layout,
        params.flow,
        flowId,
        params.entitySchema,
      );
    } finally {
      await this.cleanupStaging(params.layout, flowId).catch(err => {
        log.warn("Failed to cleanup CDC staging table", {
          flowId,
          table: params.layout.tableName,
          error: err instanceof Error ? err.message : String(err),
        });
      });
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
    }

    log.info("Hard-deleted records from live table", {
      table: layout.tableName,
      count: deletes.length,
    });
  }
}
