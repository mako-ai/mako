import { Types } from "mongoose";
import { promises as fs } from "fs";
import { BigQuery } from "@google-cloud/bigquery";
import {
  DatabaseConnection,
  type IFlow,
  type IDatabaseConnection,
} from "../../database/workspace-schema";
import { createDestinationWriter } from "../../services/destination-writer.service";
import { databaseConnectionService } from "../../services/database-connection.service";
import { loggers } from "../../logging";
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
  private readonly writerCache = new Map<
    string,
    Awaited<ReturnType<typeof createDestinationWriter>>
  >();

  constructor(private readonly config: BigQueryAdapterConfig) {}

  async ensureLiveTable(layout: CdcEntityLayout): Promise<void> {
    await this.createWriter(layout);
  }

  async ensureLiveTableFromSourceSchema(
    layout: CdcEntityLayout,
    sourceTable: string,
  ): Promise<void> {
    const destination = await this.resolveDestination();
    const conn = destination.connection as any;
    const projectId = conn.project_id;
    const dataset = this.config.tableDestination.schema;
    const escId = (id: string) => `\`${id.replace(/`/g, "\\`")}\``;
    const fullLive = `${escId(projectId)}.${escId(dataset)}.${escId(layout.tableName)}`;

    const liveColumnsResult = await databaseConnectionService.executeQuery(
      destination,
      `SELECT column_name FROM ${escId(projectId)}.${escId(dataset)}.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${layout.tableName.replace(/'/g, "''")}'`,
    );
    const liveCols = ((liveColumnsResult.data as any[]) || []).map(
      (r: any) => r.column_name as string,
    );
    if (liveCols.length > 0) return;

    log.info(
      "Creating live table from source schema with partitioning/clustering",
      {
        liveTable: layout.tableName,
        sourceTable,
        dataset,
      },
    );

    const schemaResult = await databaseConnectionService.executeQuery(
      destination,
      `SELECT column_name, data_type FROM ${escId(projectId)}.${escId(dataset)}.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${sourceTable.replace(/'/g, "''")}' ORDER BY ordinal_position`,
    );
    const colDefs = ((schemaResult.data as any[]) || [])
      .map((r: any) => `${escId(r.column_name)} ${r.data_type}`)
      .join(",\n  ");

    if (!colDefs) {
      throw new Error(
        `Source table ${sourceTable} has no columns or does not exist`,
      );
    }

    let partitionClause = "";
    if (layout.partitioning?.field) {
      const partField = escId(layout.partitioning.field);
      const gran = (layout.partitioning.granularity || "day").toUpperCase();
      if (layout.partitioning.type === "ingestion") {
        partitionClause = `\nPARTITION BY DATE(_PARTITIONTIME)`;
      } else {
        partitionClause = `\nPARTITION BY DATE_TRUNC(${partField}, ${gran})`;
      }
    }

    let clusterClause = "";
    if (layout.clustering?.fields?.length) {
      clusterClause = `\nCLUSTER BY ${layout.clustering.fields.map(escId).join(", ")}`;
    }

    await databaseConnectionService.executeQuery(
      destination,
      `CREATE TABLE IF NOT EXISTS ${fullLive} (\n  ${colDefs}\n)${partitionClause}${clusterClause}`,
    );
  }

  async applyEvents(params: {
    events: CdcStoredEvent[];
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
  }): Promise<{ applied: number }> {
    if (params.events.length === 0) {
      return { applied: 0 };
    }

    const writer = await this.createWriter(params.layout);
    (writer as any).config.deleteMode = params.flow.deleteMode;

    const latest = selectLatestChangePerRecord(params.events);
    const fallbackDataSourceId = params.flow.dataSourceId
      ? String(params.flow.dataSourceId)
      : undefined;
    const upserts = latest.filter(event => event.operation === "upsert");
    const deletes = latest.filter(event => event.operation === "delete");

    if (upserts.length > 0) {
      const rows = upserts.map(event => {
        const payload = normalizePayloadKeys(event.payload || {});
        const sourceTs = resolveSourceTimestamp(
          payload,
          new Date(event.sourceTs),
        );
        return {
          ...payload,
          id: event.recordId,
          _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
          _mako_source_ts: sourceTs,
          _mako_ingest_seq: Number(event.ingestSeq),
          _mako_deleted_at: null,
          is_deleted: false,
          deleted_at: null,
        };
      });

      const write = await writer.writeBatch(rows, {
        keyColumns: params.layout.keyColumns,
        conflictStrategy: "update",
      });
      if (!write.success) {
        throw new Error(write.error || "Failed to apply BigQuery CDC upserts");
      }
    }

    if (deletes.length > 0) {
      const deleteMode =
        params.flow.deleteMode || params.layout.deleteMode || "hard";
      if (deleteMode === "soft") {
        const rows = deletes.map(event => {
          const payload = normalizePayloadKeys(event.payload || {});
          const sourceTs = resolveSourceTimestamp(
            payload,
            new Date(event.sourceTs),
          );
          return {
            ...payload,
            id: event.recordId,
            _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
            _mako_source_ts: sourceTs,
            _mako_ingest_seq: Number(event.ingestSeq),
            _mako_deleted_at: new Date(),
            is_deleted: true,
            deleted_at: new Date(),
          };
        });

        const write = await writer.writeBatch(rows, {
          keyColumns: params.layout.keyColumns,
          conflictStrategy: "update",
        });
        if (!write.success) {
          throw new Error(
            write.error || "Failed to apply BigQuery CDC soft deletes",
          );
        }
      } else {
        for (const event of deletes) {
          const payload = normalizePayloadKeys(event.payload || {});
          const dataSourceId =
            payload._dataSourceId ?? fallbackDataSourceId ?? undefined;
          const keyFilters: Record<string, unknown> = { id: event.recordId };
          if (dataSourceId !== undefined) {
            keyFilters._dataSourceId = dataSourceId;
          }
          const remove = await writer.deleteByKeys(keyFilters);
          if (!remove.success) {
            throw new Error(
              remove.error || "Failed to apply BigQuery CDC hard delete",
            );
          }
        }
      }
    }

    return {
      applied: latest.length,
    };
  }

  async applyBatch(params: {
    records: Array<Record<string, unknown>>;
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
  }): Promise<{ written: number }> {
    if (params.records.length === 0) {
      return { written: 0 };
    }

    const writer = await this.createWriter(params.layout);
    (writer as any).config.deleteMode = params.flow.deleteMode;
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

    const write = await writer.writeBatch(rows, {
      keyColumns: params.layout.keyColumns,
      conflictStrategy: "update",
    });
    if (!write.success) {
      log.error("BigQuery batch apply failed", {
        table: params.layout.tableName,
        rows: rows.length,
        error: write.error,
      });
      throw new Error(write.error || "Failed to apply BigQuery backfill batch");
    }

    return {
      written: write.rowsWritten,
    };
  }

  async loadStagingFromParquet(
    parquetPath: string,
    layout: CdcEntityLayout,
    flowId: string,
  ): Promise<{ loaded: number }> {
    await this.createWriter(layout);

    const destination = await this.resolveDestination();
    const conn = destination.connection as any;
    const credentials =
      typeof conn.service_account_json === "string"
        ? JSON.parse(conn.service_account_json)
        : conn.service_account_json;
    const projectId = conn.project_id;
    const dataset = this.config.tableDestination.schema;
    const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
    const stagingTable = `${layout.tableName}__${flowToken}__staging`;

    const bq = new BigQuery({ projectId, credentials });
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

  async mergeFromStaging(
    layout: CdcEntityLayout,
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">,
    flowId: string,
  ): Promise<{ written: number }> {
    const destination = await this.resolveDestination();
    const conn = destination.connection as any;
    const projectId = conn.project_id;
    const dataset = this.config.tableDestination.schema;
    const liveTable = layout.tableName;
    const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
    const stagingTable = `${layout.tableName}__${flowToken}__staging`;

    const escId = (id: string) => `\`${id.replace(/`/g, "\\`")}\``;
    const fullLive = `${escId(projectId)}.${escId(dataset)}.${escId(liveTable)}`;
    const fullStaging = `${escId(projectId)}.${escId(dataset)}.${escId(stagingTable)}`;

    const stagingColumnsResult = await databaseConnectionService.executeQuery(
      destination,
      `SELECT column_name FROM ${escId(projectId)}.${escId(dataset)}.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${stagingTable.replace(/'/g, "''")}'`,
    );
    const liveColumnsResult = await databaseConnectionService.executeQuery(
      destination,
      `SELECT column_name FROM ${escId(projectId)}.${escId(dataset)}.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${liveTable.replace(/'/g, "''")}'`,
    );

    const stagingCols = new Set(
      ((stagingColumnsResult.data as any[]) || []).map(
        (r: any) => r.column_name as string,
      ),
    );
    const liveCols = new Set(
      ((liveColumnsResult.data as any[]) || []).map(
        (r: any) => r.column_name as string,
      ),
    );

    if (liveCols.size === 0) {
      await this.ensureLiveTableFromSourceSchema(layout, stagingTable);
      for (const col of stagingCols) {
        liveCols.add(col);
      }
    }

    const missingInLive = [...stagingCols].filter(c => !liveCols.has(c));
    if (missingInLive.length > 0) {
      const stagingSchemaResult = await databaseConnectionService.executeQuery(
        destination,
        `SELECT column_name, data_type FROM ${escId(projectId)}.${escId(dataset)}.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${stagingTable.replace(/'/g, "''")}'`,
      );
      const stagingSchema = new Map(
        ((stagingSchemaResult.data as any[]) || []).map((r: any) => [
          r.column_name as string,
          r.data_type as string,
        ]),
      );
      for (const col of missingInLive) {
        const colType = stagingSchema.get(col) || "STRING";
        await databaseConnectionService.executeQuery(
          destination,
          `ALTER TABLE ${fullLive} ADD COLUMN IF NOT EXISTS ${escId(col)} ${colType}`,
        );
        liveCols.add(col);
      }
      log.info("Added missing columns to live table from staging", {
        liveTable,
        addedColumns: missingInLive,
      });
    }

    const allColumns = Array.from(new Set([...stagingCols, ...liveCols]));

    const keyColumns = layout.keyColumns;
    const joinCondition = keyColumns
      .map(k => `T.${escId(k)} = S.${escId(k)}`)
      .join(" AND ");
    const nonKeyColumns = allColumns.filter(c => !keyColumns.includes(c));

    const hasSourceTs = allColumns.includes("_mako_source_ts");
    const hasIngestSeq = allColumns.includes("_mako_ingest_seq");
    const matchedGuard = hasSourceTs
      ? ` AND COALESCE(S.\`_mako_source_ts\`, TIMESTAMP('1970-01-01 00:00:00 UTC')) >= COALESCE(T.\`_mako_source_ts\`, TIMESTAMP('1970-01-01 00:00:00 UTC'))`
      : hasIngestSeq
        ? ` AND COALESCE(S.\`_mako_ingest_seq\`, -1) >= COALESCE(T.\`_mako_ingest_seq\`, -1)`
        : "";

    const updateSet = nonKeyColumns
      .map(c => `${escId(c)} = S.${escId(c)}`)
      .join(", ");
    const insertCols = allColumns.map(escId).join(", ");
    const insertVals = allColumns.map(c => `S.${escId(c)}`).join(", ");

    const mergeQuery = `
      MERGE INTO ${fullLive} T
      USING ${fullStaging} S
      ON ${joinCondition}
      ${nonKeyColumns.length > 0 ? `WHEN MATCHED${matchedGuard} THEN UPDATE SET ${updateSet}` : ""}
      WHEN NOT MATCHED THEN INSERT (${insertCols}) VALUES (${insertVals})
    `;

    const result = await databaseConnectionService.executeQuery(
      destination,
      mergeQuery,
    );
    if (!result.success) {
      throw new Error(result.error || "BigQuery staging MERGE failed");
    }

    log.info("Merged staging to live table", {
      liveTable,
      stagingTable,
      dataset,
    });

    return { written: 0 };
  }

  async cleanupStaging(layout: CdcEntityLayout, flowId: string): Promise<void> {
    const destination = await this.resolveDestination();
    const conn = destination.connection as any;
    const projectId = conn.project_id;
    const dataset = this.config.tableDestination.schema;
    const flowToken = flowId.replace(/[^a-zA-Z0-9]/g, "").slice(-8);
    const stagingTable = `${layout.tableName}__${flowToken}__staging`;
    const escId = (id: string) => `\`${id.replace(/`/g, "\\`")}\``;
    const fullStaging = `${escId(projectId)}.${escId(dataset)}.${escId(stagingTable)}`;

    await databaseConnectionService.executeQuery(
      destination,
      `DROP TABLE IF EXISTS ${fullStaging}`,
    );

    log.info("Cleaned up staging table", { stagingTable, dataset });
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

  private async createWriter(layout: CdcEntityLayout) {
    const cacheKey = layout.tableName;
    const cached = this.writerCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const writer = await createDestinationWriter(
      {
        destinationDatabaseId: new Types.ObjectId(
          this.config.destinationDatabaseId,
        ),
        destinationDatabaseName: this.config.destinationDatabaseName,
        tableDestination: {
          connectionId: new Types.ObjectId(
            this.config.tableDestination.connectionId,
          ),
          schema: this.config.tableDestination.schema,
          tableName: layout.tableName,
          createIfNotExists: true,
          partitioning: layout.partitioning
            ? {
                enabled: true,
                type: layout.partitioning.type || "time",
                field: layout.partitioning.field,
                granularity: layout.partitioning.granularity || "day",
                requirePartitionFilter:
                  layout.partitioning.requirePartitionFilter,
              }
            : undefined,
          clustering: layout.clustering?.fields?.length
            ? {
                enabled: true,
                fields: layout.clustering.fields,
              }
            : undefined,
        } as any,
      },
      "cdc-bigquery-adapter",
    );

    this.writerCache.set(cacheKey, writer);
    return writer;
  }
}
