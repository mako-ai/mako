import { Types } from "mongoose";
import type { IFlow } from "../../database/workspace-schema";
import { createDestinationWriter } from "../../services/destination-writer.service";
import { loggers } from "../../logging";
import { normalizePayloadKeys, resolveSourceTimestamp } from "../normalization";
import { materializeCdcEvents } from "../materialize";
import type { CdcStoredEvent } from "../events";
import type { CdcDestinationAdapter, CdcEntityLayout } from "./registry";

const log = loggers.sync("cdc.adapter.postgresql");

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

  constructor(private readonly config: PostgreSqlAdapterConfig) {}

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

    const materialized = materializeCdcEvents({
      events: params.events,
      layout: params.layout,
      flow: params.flow,
    });

    if (materialized.upsertRows.length > 0) {
      const write = await writer.writeBatch(materialized.upsertRows, {
        keyColumns: params.layout.keyColumns,
        conflictStrategy: "update",
      });
      if (!write.success) {
        throw new Error(
          write.error || "Failed to apply PostgreSQL CDC upserts",
        );
      }
    }

    if (materialized.softDeleteRows.length > 0) {
      const write = await writer.writeBatch(materialized.softDeleteRows, {
        keyColumns: params.layout.keyColumns,
        conflictStrategy: "update",
      });
      if (!write.success) {
        throw new Error(
          write.error || "Failed to apply PostgreSQL CDC soft deletes",
        );
      }
    }

    for (const event of materialized.hardDeleteEvents) {
      const payload = normalizePayloadKeys(event.payload || {});
      const dataSourceId =
        payload._dataSourceId ?? materialized.fallbackDataSourceId ?? undefined;
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

    return {
      applied: materialized.applied,
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
      log.error("PostgreSQL batch apply failed", {
        table: params.layout.tableName,
        rows: rows.length,
        error: write.error,
      });
      throw new Error(
        write.error || "Failed to apply PostgreSQL backfill batch",
      );
    }

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
