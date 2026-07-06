import { Types } from "mongoose";
import {
  DatabaseConnection,
  type IFlow,
} from "../../database/workspace-schema";
import { createDestinationWriter } from "../../services/destination-writer.service";
import { databaseRegistry } from "../../databases/registry";
import { loggers } from "../../logging";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
  selectLatestChangePerRecord,
  withSyncedAt,
} from "../normalization";
import type { CdcStoredEvent } from "../events";
import type { CdcDestinationAdapter, CdcEntityLayout } from "./registry";

const log = loggers.sync("cdc.adapter.postgresql");

function pgIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Postgres has no BigQuery-style partition/cluster DDL on plain tables, so the
 * engine-agnostic layout hints map to secondary btree indexes: one on the
 * partition field (time-range scans) and one per cluster field (filter scans).
 * Exported for the destination layout contract tests.
 */
export function buildPgLayoutIndexStatements(
  layout: Pick<
    CdcEntityLayout,
    "tableName" | "partitioning" | "clustering" | "keyColumns"
  >,
  schema: string,
): string[] {
  const fields = new Set<string>();
  if (layout.partitioning?.field) fields.add(layout.partitioning.field);
  for (const field of layout.clustering?.fields || []) fields.add(field);
  for (const key of layout.keyColumns || []) fields.delete(key);

  const statements: string[] = [];
  for (const field of fields) {
    const indexName = `mako_layout_${layout.tableName}_${field}`
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 63);
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${pgIdent(indexName)} ON ${pgIdent(schema)}.${pgIdent(layout.tableName)} (${pgIdent(field)})`,
    );
  }
  return statements;
}

interface PostgreSqlAdapterConfig {
  destinationDatabaseId: string;
  destinationDatabaseName?: string;
  tableDestination: {
    connectionId: string;
    schema: string;
    tableName: string;
  };
}

export class PostgreSqlDestinationAdapter implements CdcDestinationAdapter {
  readonly destinationType = "postgresql";
  private readonly writerCache = new Map<
    string,
    Awaited<ReturnType<typeof createDestinationWriter>>
  >();
  private readonly layoutIndexesEnsured = new Set<string>();

  constructor(private readonly config: PostgreSqlAdapterConfig) {}

  async ensureLiveTable(_layout: CdcEntityLayout): Promise<void> {
    // DestinationWriter creates tables lazily on first write.
  }

  /** Full Refresh | Overwrite: clear the live table (no-op when absent). */
  async truncateLiveTable(layout: CdcEntityLayout): Promise<void> {
    const destination = await DatabaseConnection.findById(
      this.config.tableDestination.connectionId,
    );
    if (!destination) return;
    const driver = databaseRegistry.getDriver(destination.type);
    if (!driver) return;
    const schema = this.config.tableDestination.schema || "public";
    const result = await driver.executeQuery(
      destination,
      `DELETE FROM ${pgIdent(schema)}.${pgIdent(layout.tableName)}`,
      { databaseName: this.config.destinationDatabaseName },
    );
    if (!result.success && !/does not exist/i.test(result.error || "")) {
      throw new Error(
        result.error || "Failed to clear PostgreSQL live table for overwrite",
      );
    }
  }

  /**
   * Map the engine-agnostic layout hints (partition field + cluster fields)
   * to Postgres secondary indexes. Idempotent and best-effort: the table may
   * not exist until the first write, so callers invoke this after writing.
   */
  private async ensureLayoutIndexes(layout: CdcEntityLayout): Promise<void> {
    const statements = buildPgLayoutIndexStatements(
      layout,
      this.config.tableDestination.schema || "public",
    );
    if (statements.length === 0) return;
    const cacheKey = `${layout.tableName}:${statements.join(";")}`;
    if (this.layoutIndexesEnsured.has(cacheKey)) return;

    try {
      const destination = await DatabaseConnection.findById(
        this.config.tableDestination.connectionId,
      );
      if (!destination) return;
      const driver = databaseRegistry.getDriver(destination.type);
      if (!driver) return;
      for (const statement of statements) {
        const result = await driver.executeQuery(destination, statement, {
          databaseName: this.config.destinationDatabaseName,
        });
        if (!result.success) {
          log.warn("Failed to ensure layout index", {
            table: layout.tableName,
            statement,
            error: result.error,
          });
          return; // Don't cache failures — retry on the next apply.
        }
      }
      this.layoutIndexesEnsured.add(cacheKey);
    } catch (err) {
      log.warn("Layout index creation failed", {
        table: layout.tableName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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

      const write = await writer.writeBatch(
        rows,
        params.layout.writeMode === "append"
          ? {}
          : {
              keyColumns: params.layout.keyColumns,
              conflictStrategy: "update",
            },
      );
      if (!write.success) {
        throw new Error(
          write.error || "Failed to apply PostgreSQL CDC upserts",
        );
      }
      await this.ensureLayoutIndexes(params.layout);
    }

    if (deletes.length > 0) {
      const deleteMode =
        params.layout.writeMode === "append"
          ? "soft" // append mode never mutates prior rows; deletions land as tombstone rows
          : params.flow.deleteMode || params.layout.deleteMode || "hard";
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

        const write = await writer.writeBatch(
          rows,
          params.layout.writeMode === "append"
            ? {}
            : {
                keyColumns: params.layout.keyColumns,
                conflictStrategy: "update",
              },
        );
        if (!write.success) {
          throw new Error(
            write.error || "Failed to apply PostgreSQL CDC soft deletes",
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
              remove.error || "Failed to apply PostgreSQL CDC hard delete",
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

    const write = await writer.writeBatch(
      rows,
      params.layout.writeMode === "append"
        ? {}
        : {
            keyColumns: params.layout.keyColumns,
            conflictStrategy: "update",
          },
    );
    if (!write.success) {
      log.error("PostgreSQL batch apply failed", {
        table: params.layout.tableName,
        rows: rows.length,
        error: write.error,
      });
      throw new Error(
        write.error || "Failed to apply PostgreSQL backfill batch",
      );
    }

    await this.ensureLayoutIndexes(params.layout);

    return {
      written: write.rowsWritten,
    };
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
      "cdc-postgresql-adapter",
    );

    this.writerCache.set(tableName, writer);
    return writer;
  }
}
