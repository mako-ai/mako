import { promises as fs } from "fs";
import { BigQuery } from "@google-cloud/bigquery";
import {
  DatabaseConnection,
  type IFlow,
  type IDatabaseConnection,
} from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { databaseRegistry } from "../../databases/registry";
import { loggers } from "../../logging";
import { buildParquetFromBatches } from "../../utils/streaming-parquet-builder";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
  selectLatestChangePerRecord,
} from "../normalization";
import type { CdcStoredEvent } from "../events";
import type { CdcDestinationAdapter, CdcEntityLayout } from "./registry";

const log = loggers.sync("cdc.adapter.bigquery");

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

  async ensureLiveTable(_layout: CdcEntityLayout): Promise<void> {
    await this.ensureDataset();
  }

  async ensureLiveTableFromSourceSchema(
    layout: CdcEntityLayout,
    sourceTable: string,
  ): Promise<void> {
    const destination = await this.resolveDestination();
    const dataset = this.config.tableDestination.schema;

    const driver = databaseRegistry.getDriver(destination.type);
    if (!driver?.createTableFromSource) {
      throw new Error(
        `Driver ${destination.type} does not support createTableFromSource`,
      );
    }

    const result = await driver.createTableFromSource(
      destination,
      sourceTable,
      layout.tableName,
      {
        schema: dataset,
        partitioning: layout.partitioning
          ? {
              type: layout.partitioning.type || "time",
              field: layout.partitioning.field,
              granularity: layout.partitioning.granularity,
              requirePartitionFilter:
                layout.partitioning.requirePartitionFilter,
            }
          : undefined,
        clustering: layout.clustering?.fields?.length
          ? { fields: layout.clustering.fields }
          : undefined,
      },
    );

    if (!result.success) {
      throw new Error(
        result.error || "Failed to create live table from source schema",
      );
    }

    log.info("Created live table from source schema", {
      liveTable: layout.tableName,
      sourceTable,
      dataset,
    });
  }

  async applyEvents(params: {
    events: CdcStoredEvent[];
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
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
        rows.push({
          ...payload,
          id: event.recordId,
          _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
          _mako_source_ts: sourceTs,
          _mako_ingest_seq: Number(event.ingestSeq),
          _mako_deleted_at: new Date(),
          is_deleted: true,
          deleted_at: new Date(),
        });
      }
    }

    if (rows.length > 0) {
      await this.writeViaParquet({
        records: rows,
        layout: params.layout,
        flow: params.flow,
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
  }): Promise<{ written: number }> {
    if (params.records.length === 0) {
      return { written: 0 };
    }

    const fallbackDataSourceId = params.flow.dataSourceId
      ? String(params.flow.dataSourceId)
      : undefined;

    const rows = params.records.map(record => {
      const payload = normalizePayloadKeys(record || {});
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

    return this.writeViaParquet({
      records: rows,
      layout: params.layout,
      flow: params.flow,
    });
  }

  async loadStagingFromParquet(
    parquetPath: string,
    layout: CdcEntityLayout,
    flowId: string,
  ): Promise<{ loaded: number }> {
    await this.ensureDataset();
    const stagingTable = this.getStagingTableName(layout.tableName, flowId);
    return this.loadParquetToStaging(parquetPath, stagingTable);
  }

  async mergeFromStaging(
    layout: CdcEntityLayout,
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">,
    flowId: string,
  ): Promise<{ written: number }> {
    const stagingTable = this.getStagingTableName(layout.tableName, flowId);
    return this.mergeStagingToLive(layout, stagingTable);
  }

  private async mergeStagingToLive(
    layout: CdcEntityLayout,
    stagingTable: string,
  ): Promise<{ written: number }> {
    const { projectId, dataset, destination, datasetLocation } =
      await this.resolveBqClient();
    const liveTable = layout.tableName;

    const escId = (id: string) => `\`${id.replace(/`/g, "\\`")}\``;
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
    const stagingTypes = new Map<string, string>();
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
        stagingTypes.set(col, dt);
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
      await this.ensureLiveTableFromSourceSchema(layout, stagingTable);
      for (const col of stagingCols) {
        liveCols.add(col);
      }
    }

    const missingInLive = [...stagingCols].filter(c => !liveCols.has(c));
    const skippedLiveAdds: string[] = [];
    const addedToLive: string[] = [];
    for (const col of missingInLive) {
      const colType = stagingTypes.get(col) || "STRING";
      const addToLive = await databaseConnectionService.executeQuery(
        destination,
        `ALTER TABLE ${fullLive} ADD COLUMN IF NOT EXISTS ${escId(col)} ${colType}`,
        { location: datasetLocation },
      );
      if (!addToLive.success) {
        skippedLiveAdds.push(col);
        log.warn(
          "Skipping live column add; column will be omitted from MERGE",
          {
            liveTable,
            column: col,
            error: addToLive.error,
          },
        );
        continue;
      }
      liveCols.add(col);
      addedToLive.push(col);
    }
    if (addedToLive.length > 0) {
      log.info("Added missing columns to live table from staging", {
        liveTable,
        addedColumns: addedToLive,
      });
    }

    const missingInStaging = [...liveCols].filter(c => !stagingCols.has(c));
    const skippedStagingAdds: string[] = [];
    const addedToStaging: string[] = [];
    for (const col of missingInStaging) {
      const colType = liveTypes.get(col) || "STRING";
      const addToStaging = await databaseConnectionService.executeQuery(
        destination,
        `ALTER TABLE ${fullStaging} ADD COLUMN IF NOT EXISTS ${escId(col)} ${colType}`,
        { location: datasetLocation },
      );
      if (!addToStaging.success) {
        skippedStagingAdds.push(col);
        log.warn(
          "Skipping staging column add; MERGE will project NULL for this column",
          {
            stagingTable,
            column: col,
            error: addToStaging.error,
          },
        );
        continue;
      }
      stagingCols.add(col);
      addedToStaging.push(col);
    }
    if (addedToStaging.length > 0) {
      log.info("Added missing columns to staging table from live", {
        stagingTable,
        addedColumns: addedToStaging,
      });
    }

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

    const joinCondition = keyColumns
      .map(k => `T.${escId(k)} = S.${escId(k)}`)
      .join(" AND ");
    const dedupKey = keyColumns.map(escId).join(", ");
    const normalizeBqType = (type: string | undefined): string =>
      (type || "").trim().toUpperCase();
    const isNumericBqType = (type: string): boolean =>
      [
        "INT64",
        "INTEGER",
        "NUMERIC",
        "BIGNUMERIC",
        "FLOAT64",
        "FLOAT",
        "DOUBLE",
        "DECIMAL",
        "BIGDECIMAL",
      ].includes(type);
    const isIntegerBqType = (type: string): boolean =>
      ["INT64", "INTEGER"].includes(type);
    const coerceSourceExpression = (column: string): string => {
      const sourceExpr = `S_RAW.${escId(column)}`;
      const targetType = normalizeBqType(liveTypes.get(column));
      const sourceType = normalizeBqType(stagingTypes.get(column));

      if (!targetType || targetType === sourceType || targetType === "JSON") {
        return `${sourceExpr} AS ${escId(column)}`;
      }

      if (targetType === "TIMESTAMP" && isNumericBqType(sourceType)) {
        // Handle numeric epoch values safely (ms/us/ns/s), defaulting to seconds.
        return `
          CASE
            WHEN SAFE_CAST(${sourceExpr} AS INT64) IS NULL THEN NULL
            WHEN ABS(SAFE_CAST(${sourceExpr} AS INT64)) >= 1000000000000000000 THEN TIMESTAMP_MILLIS(CAST(SAFE_CAST(${sourceExpr} AS INT64) / 1000000 AS INT64))
            WHEN ABS(SAFE_CAST(${sourceExpr} AS INT64)) >= 1000000000000000 THEN TIMESTAMP_MILLIS(CAST(SAFE_CAST(${sourceExpr} AS INT64) / 1000 AS INT64))
            WHEN ABS(SAFE_CAST(${sourceExpr} AS INT64)) >= 100000000000 THEN TIMESTAMP_MILLIS(SAFE_CAST(${sourceExpr} AS INT64))
            ELSE TIMESTAMP_SECONDS(SAFE_CAST(${sourceExpr} AS INT64))
          END AS ${escId(column)}
        `;
      }

      if (isIntegerBqType(targetType) && isNumericBqType(sourceType)) {
        return `SAFE_CAST(${sourceExpr} AS INT64) AS ${escId(column)}`;
      }

      return `SAFE_CAST(${sourceExpr} AS ${targetType}) AS ${escId(column)}`;
    };
    const buildMergeQuery = (columns: string[]): string => {
      const nonKeyColumns = columns.filter(c => !keyColumns.includes(c));
      const hasSourceTs = columns.includes("_mako_source_ts");
      const hasIngestSeq = columns.includes("_mako_ingest_seq");
      const matchedGuard = hasSourceTs
        ? ` AND COALESCE(S.\`_mako_source_ts\`, TIMESTAMP('1970-01-01 00:00:00 UTC')) >= COALESCE(T.\`_mako_source_ts\`, TIMESTAMP('1970-01-01 00:00:00 UTC'))`
        : hasIngestSeq
          ? ` AND COALESCE(S.\`_mako_ingest_seq\`, -1) >= COALESCE(T.\`_mako_ingest_seq\`, -1)`
          : "";
      const updateSet = nonKeyColumns
        .map(c => `${escId(c)} = S.${escId(c)}`)
        .join(", ");
      const insertCols = columns.map(escId).join(", ");
      const insertVals = columns.map(c => `S.${escId(c)}`).join(", ");
      const selectCols = columns
        .map(c =>
          stagingCols.has(c)
            ? coerceSourceExpression(c)
            : `NULL AS ${escId(c)}`,
        )
        .join(", ");
      const dedupSource = `(SELECT ${selectCols} FROM ${fullStaging} S_RAW QUALIFY ROW_NUMBER() OVER (PARTITION BY ${dedupKey} ORDER BY ${hasSourceTs ? `\`_mako_source_ts\` DESC` : "1"}) = 1)`;
      return `
      MERGE INTO ${fullLive} T
      USING ${dedupSource} S
      ON ${joinCondition}
      ${nonKeyColumns.length > 0 ? `WHEN MATCHED${matchedGuard} THEN UPDATE SET ${updateSet}` : ""}
      WHEN NOT MATCHED THEN INSERT (${insertCols}) VALUES (${insertVals})
    `;
    };

    const mergeMaxWaitEnv = Number.parseInt(
      process.env.BIGQUERY_MERGE_MAX_WAIT_MS || "",
      10,
    );
    const mergeMaxWaitMs =
      Number.isFinite(mergeMaxWaitEnv) && mergeMaxWaitEnv >= 10_000
        ? Math.min(mergeMaxWaitEnv, 60 * 60 * 1000)
        : 50 * 60 * 1000;

    const droppedMergeColumns: string[] = [];
    const retryAddedColumns: string[] = [];
    let mergeColumns = [...allColumns];
    let result: { success: boolean; error?: string } | null = null;
    const fallbackTypeForColumn = (column: string): string => {
      if (column === "_mako_ingest_seq") return "INT64";
      if (column === "is_deleted") return "BOOL";
      if (
        column === "_mako_source_ts" ||
        column === "_mako_deleted_at" ||
        column === "deleted_at"
      ) {
        return "TIMESTAMP";
      }
      return "STRING";
    };
    const ensureColumnOnTable = async (
      tableKind: "live" | "staging",
      column: string,
      dataType: string,
    ): Promise<boolean> => {
      const targetTable = tableKind === "live" ? fullLive : fullStaging;
      const alter = await databaseConnectionService.executeQuery(
        destination,
        `ALTER TABLE ${targetTable} ADD COLUMN IF NOT EXISTS ${escId(column)} ${dataType}`,
        { location: datasetLocation },
      );
      if (!alter.success) {
        log.warn("Failed to add missing MERGE column on retry", {
          tableKind,
          liveTable,
          stagingTable,
          column,
          dataType,
          error: alter.error,
        });
        return false;
      }
      if (tableKind === "live") {
        liveCols.add(column);
        liveTypes.set(column, dataType);
      } else {
        stagingCols.add(column);
        stagingTypes.set(column, dataType);
      }
      return true;
    };
    for (let attempt = 0; attempt < 6; attempt++) {
      const mergeQuery = buildMergeQuery(mergeColumns);
      result = await databaseConnectionService.executeQuery(
        destination,
        mergeQuery,
        { bigQueryJobMaxWaitMs: mergeMaxWaitMs, location: datasetLocation },
      );
      if (result.success) {
        break;
      }

      const errorText = result.error || "BigQuery staging MERGE failed";
      const unrecognized = errorText.match(
        /Unrecognized name:\s*([A-Za-z0-9_]+)/i,
      );
      const badColumn = unrecognized?.[1];
      if (
        !badColumn ||
        keyColumns.includes(badColumn) ||
        !mergeColumns.includes(badColumn)
      ) {
        throw new Error(errorText);
      }

      const targetType =
        liveTypes.get(badColumn) ||
        stagingTypes.get(badColumn) ||
        fallbackTypeForColumn(badColumn);
      const ensuredLive = liveCols.has(badColumn)
        ? true
        : await ensureColumnOnTable("live", badColumn, targetType);
      const ensuredStaging = stagingCols.has(badColumn)
        ? true
        : await ensureColumnOnTable("staging", badColumn, targetType);

      if (ensuredLive && ensuredStaging) {
        retryAddedColumns.push(badColumn);
        log.info("Retrying MERGE after adding missing column", {
          liveTable,
          stagingTable,
          column: badColumn,
          dataType: targetType,
          attempt: attempt + 1,
        });
        continue;
      }

      mergeColumns = mergeColumns.filter(col => col !== badColumn);
      droppedMergeColumns.push(badColumn);
      log.warn("Retrying MERGE without unrecognized column (auto-add failed)", {
        liveTable,
        stagingTable,
        column: badColumn,
        attempt: attempt + 1,
        error: errorText,
      });
    }
    if (!result?.success) {
      throw new Error(result?.error || "BigQuery staging MERGE failed");
    }

    log.info("Merged staging to live table", {
      liveTable,
      stagingTable,
      dataset,
      skippedLiveAdds,
      skippedStagingAdds,
      retryAddedColumns,
      droppedMergeColumns,
    });

    return { written: 0 };
  }

  async cleanupStaging(layout: CdcEntityLayout, flowId: string): Promise<void> {
    const stagingTable = this.getStagingTableName(layout.tableName, flowId);
    await this.dropStagingTable(stagingTable);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getStagingTableName(
    tableName: string,
    flowId: string,
    prefix?: string,
  ): string {
    const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
    const tag = prefix ? `${prefix}_${flowToken}` : flowToken;
    return `${tableName}__${tag}__staging`;
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
    const escId = (id: string) => `\`${id.replace(/`/g, "\\`")}\``;
    const fullStaging = `${escId(projectId)}.${escId(dataset)}.${escId(stagingTable)}`;

    await databaseConnectionService.executeQuery(
      destination,
      `DROP TABLE IF EXISTS ${fullStaging}`,
      { location: datasetLocation },
    );

    log.info("Cleaned up staging table", { stagingTable, dataset });
  }

  private async writeViaParquet(params: {
    records: Record<string, unknown>[];
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
  }): Promise<{ written: number }> {
    if (params.records.length === 0) return { written: 0 };

    const flowId = String(params.flow._id);
    const stagingTable = this.getStagingTableName(
      params.layout.tableName,
      flowId,
      `cdc_${Date.now().toString(36)}`,
    );

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
      stagingTable,
    });

    try {
      await this.loadParquetToStaging(parquet.filePath, stagingTable);
      await this.mergeStagingToLive(params.layout, stagingTable);
    } finally {
      await this.dropStagingTable(stagingTable).catch(err => {
        log.warn("Failed to cleanup CDC staging table", {
          stagingTable,
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
    const escId = (id: string) => `\`${id.replace(/`/g, "\\`")}\``;
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
