import { Types } from "mongoose";
import {
  DatabaseConnection,
  type IFlow,
} from "../../database/workspace-schema";
import { createDestinationWriter } from "../../services/destination-writer.service";
import { databaseRegistry } from "../../databases/registry";
import { MySQLDatabaseDriver } from "../../databases/drivers/mysql/driver";
import { buildMySqlLayoutIndexes } from "../../databases/drivers/mysql/write";
import { loggers } from "../../logging";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
  selectLatestChangePerRecord,
  withSyncedAt,
} from "../normalization";
import type { CdcStoredEvent } from "../events";
import type { CdcDestinationAdapter, CdcEntityLayout } from "./registry";

const log = loggers.sync("cdc.adapter.mysql");

interface MySqlAdapterConfig {
  destinationDatabaseId: string;
  destinationDatabaseName?: string;
  tableDestination: {
    connectionId: string;
    schema: string;
    tableName: string;
  };
}

/**
 * MySQL CDC destination adapter. Mirrors the PostgreSQL adapter: writes go
 * through DestinationWriter (which delegates to the MySQL driver's
 * INSERT ... AS new ON DUPLICATE KEY UPDATE upserts with out-of-order
 * guards), and the engine-agnostic layout hints map to secondary indexes.
 */
export class MySqlDestinationAdapter implements CdcDestinationAdapter {
  readonly destinationType = "mysql";
  private readonly writerCache = new Map<
    string,
    Awaited<ReturnType<typeof createDestinationWriter>>
  >();
  private readonly layoutIndexesEnsured = new Set<string>();

  constructor(private readonly config: MySqlAdapterConfig) {}

  async ensureLiveTable(_layout: CdcEntityLayout): Promise<void> {
    // DestinationWriter creates tables lazily on first write.
  }

  async applyEvents(params: {
    events: CdcStoredEvent[];
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
  }): Promise<{ applied: number }> {
    if (params.events.length === 0) {
      return { applied: 0 };
    }

    const writer = await this.createWriter(params.layout.tableName);
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
        return withSyncedAt({
          ...payload,
          id: event.recordId,
          _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
          _mako_source_ts: sourceTs,
          _mako_ingest_seq: Number(event.ingestSeq),
          _mako_deleted_at: null,
          is_deleted: false,
          deleted_at: null,
        });
      });

      const write = await writer.writeBatch(rows, {
        keyColumns: params.layout.keyColumns,
        conflictStrategy: "update",
      });
      if (!write.success) {
        throw new Error(write.error || "Failed to apply MySQL CDC upserts");
      }
      await this.ensureLayoutIndexes(params.layout);
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
          return withSyncedAt({
            ...payload,
            id: event.recordId,
            _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
            _mako_source_ts: sourceTs,
            _mako_ingest_seq: Number(event.ingestSeq),
            _mako_deleted_at: new Date(),
            is_deleted: true,
            deleted_at: new Date(),
          });
        });

        const write = await writer.writeBatch(rows, {
          keyColumns: params.layout.keyColumns,
          conflictStrategy: "update",
        });
        if (!write.success) {
          throw new Error(
            write.error || "Failed to apply MySQL CDC soft deletes",
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
              remove.error || "Failed to apply MySQL CDC hard delete",
            );
          }
        }
      }
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

    const writer = await this.createWriter(params.layout.tableName);
    (writer as any).config.deleteMode = params.flow.deleteMode;
    const fallbackDataSourceId = params.flow.dataSourceId
      ? String(params.flow.dataSourceId)
      : undefined;

    const rows = params.records.map(record => {
      const payload = normalizePayloadKeys(record || {});
      return withSyncedAt({
        ...payload,
        _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
        _mako_source_ts: resolveSourceTimestamp(payload),
        _mako_ingest_seq:
          typeof payload._mako_ingest_seq === "number"
            ? payload._mako_ingest_seq
            : undefined,
      });
    });

    const write = await writer.writeBatch(rows, {
      keyColumns: params.layout.keyColumns,
      conflictStrategy: "update",
    });
    if (!write.success) {
      log.error("MySQL batch apply failed", {
        table: params.layout.tableName,
        rows: rows.length,
        error: write.error,
      });
      throw new Error(write.error || "Failed to apply MySQL backfill batch");
    }

    await this.ensureLayoutIndexes(params.layout);

    return { written: write.rowsWritten };
  }

  /** Layout hints → secondary indexes (idempotent, best-effort). */
  private async ensureLayoutIndexes(layout: CdcEntityLayout): Promise<void> {
    const schema = this.config.tableDestination.schema;
    const cacheKey = `${layout.tableName}:${layout.partitioning?.field ?? ""}:${(layout.clustering?.fields || []).join(",")}`;
    if (this.layoutIndexesEnsured.has(cacheKey)) return;

    try {
      const destination = await DatabaseConnection.findById(
        this.config.tableDestination.connectionId,
      );
      if (!destination) return;
      const driver = databaseRegistry.getDriver(destination.type) as
        | MySQLDatabaseDriver
        | undefined;
      if (!driver) return;

      const columnTypes = await driver.fetchColumnTypes(
        destination,
        schema,
        layout.tableName,
      );
      const existing = await driver.executeQuery(
        destination,
        `SELECT DISTINCT index_name AS index_name FROM information_schema.statistics WHERE table_schema = '${schema.replace(/'/g, "''")}' AND table_name = '${layout.tableName.replace(/'/g, "''")}'`,
      );
      const existingNames = new Set(
        ((existing.data || []) as Array<Record<string, unknown>>).map(row =>
          String(row.index_name ?? row.INDEX_NAME ?? "").toLowerCase(),
        ),
      );

      for (const { indexName, sql } of buildMySqlLayoutIndexes(
        layout,
        schema,
        columnTypes,
      )) {
        if (existingNames.has(indexName.toLowerCase())) continue;
        const result = await driver.executeQuery(destination, sql);
        if (!result.success && !/duplicate key name/i.test(result.error || "")) {
          log.warn("Failed to ensure MySQL layout index", {
            table: layout.tableName,
            indexName,
            error: result.error,
          });
          return; // Retry on the next apply.
        }
      }
      this.layoutIndexesEnsured.add(cacheKey);
    } catch (err) {
      log.warn("MySQL layout index creation failed", {
        table: layout.tableName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async createWriter(tableName: string) {
    const cached = this.writerCache.get(tableName);
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
          tableName,
          createIfNotExists: true,
        } as any,
      },
      "cdc-mysql-adapter",
    );

    this.writerCache.set(tableName, writer);
    return writer;
  }
}
