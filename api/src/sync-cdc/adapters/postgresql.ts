import { Types } from "mongoose";
import type { IFlow, ITableDestination } from "../../database/workspace-schema";
import { createDestinationWriter } from "../../services/destination-writer.service";
import { loggers } from "../../logging";
import {
  normalizePayloadKeys,
  selectLatestChangePerRecord,
} from "../normalization";
import type { CdcStoredEvent } from "../events";
import type { CdcDestinationAdapter, CdcEntityLayout } from "./registry";
import {
  buildUpsertRow,
  buildSoftDeleteRow,
  buildBatchRow,
  partitionEventsByOperation,
  resolveDeleteMode,
  resolveFallbackDataSourceId,
} from "./shared";

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
    if (params.events.length === 0) return { applied: 0 };

    const writer = await this.createWriter(params.layout.tableName);
    (
      writer as unknown as { config: { deleteMode?: string } }
    ).config.deleteMode = params.flow.deleteMode;

    const latest = selectLatestChangePerRecord(params.events);
    const fallbackDsId = resolveFallbackDataSourceId(params.flow);
    const { upserts, deletes } = partitionEventsByOperation(latest);
    const deleteMode = resolveDeleteMode(params.flow, params.layout);

    if (upserts.length > 0) {
      const rows = upserts.map(e => buildUpsertRow(e, fallbackDsId));
      const write = await writer.writeBatch(rows, {
        keyColumns: params.layout.keyColumns,
        conflictStrategy: "update",
      });
      if (!write.success) {
        throw new Error(
          write.error || "Failed to apply PostgreSQL CDC upserts",
        );
      }
    }

    if (deletes.length > 0) {
      if (deleteMode === "soft") {
        const rows = deletes.map(e => buildSoftDeleteRow(e, fallbackDsId));
        const write = await writer.writeBatch(rows, {
          keyColumns: params.layout.keyColumns,
          conflictStrategy: "update",
        });
        if (!write.success) {
          throw new Error(
            write.error || "Failed to apply PostgreSQL CDC soft deletes",
          );
        }
      } else {
        for (const event of deletes) {
          const payload = normalizePayloadKeys(event.payload || {});
          const dataSourceId =
            payload._dataSourceId ?? fallbackDsId ?? undefined;
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

    return { applied: latest.length };
  }

  async applyBatch(params: {
    records: Array<Record<string, unknown>>;
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
  }): Promise<{ written: number }> {
    if (params.records.length === 0) return { written: 0 };

    const writer = await this.createWriter(params.layout.tableName);
    (
      writer as unknown as { config: { deleteMode?: string } }
    ).config.deleteMode = params.flow.deleteMode;
    const fallbackDsId = resolveFallbackDataSourceId(params.flow);
    const rows = params.records.map(r => buildBatchRow(r, fallbackDsId));

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
        } satisfies ITableDestination,
      },
      "cdc-postgresql-adapter",
    );

    this.writerCache.set(tableName, writer);
    return writer;
  }
}
