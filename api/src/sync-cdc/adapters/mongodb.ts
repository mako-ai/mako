import {
  DatabaseConnection,
  type IFlow,
  type IDatabaseConnection,
} from "../../database/workspace-schema";
import { databaseConnectionService } from "../../services/database-connection.service";
import { loggers } from "../../logging";
import { normalizePayloadKeys, resolveSourceTimestamp } from "../normalization";
import { materializeCdcEvents } from "../materialize";
import type { CdcStoredEvent } from "../events";
import type { CdcDestinationAdapter, CdcEntityLayout } from "./registry";
import type { Collection, Db, MongoClient } from "mongodb";

const log = loggers.sync("cdc.adapter.mongodb");

interface MongoDbAdapterConfig {
  destinationDatabaseId: string;
  destinationDatabaseName?: string;
  tableDestination: {
    connectionId: string;
    schema: string;
    tableName: string;
  };
}

export class MongoDbDestinationAdapter implements CdcDestinationAdapter {
  readonly destinationType = "mongodb";

  private _resolvedDestination?: IDatabaseConnection;
  private _indexEnsured = new Set<string>();

  constructor(private readonly config: MongoDbAdapterConfig) {}

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

  private async getDb(): Promise<Db> {
    const destination = await this.resolveDestination();
    const client = (await databaseConnectionService.getConnection(
      destination,
    )) as MongoClient;
    const dbName =
      (destination.connection as any).database ||
      this.config.tableDestination.schema ||
      "default";
    return client.db(dbName);
  }

  private async getCollection(tableName: string): Promise<Collection> {
    const db = await this.getDb();
    return db.collection(tableName);
  }

  private async ensureKeyIndex(
    collection: Collection,
    keyColumns: string[],
  ): Promise<void> {
    const cacheKey = `${collection.collectionName}:${keyColumns.join(",")}`;
    if (this._indexEnsured.has(cacheKey)) return;

    const indexSpec: Record<string, 1> = {};
    for (const col of keyColumns) {
      indexSpec[col] = 1;
    }

    try {
      await collection.createIndex(indexSpec, {
        unique: true,
        name: `mako_cdc_key_${keyColumns.join("_")}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already exists")) {
        log.warn("Failed to create key index", {
          collection: collection.collectionName,
          keyColumns,
          error: msg,
        });
      }
    }
    this._indexEnsured.add(cacheKey);
  }

  async ensureLiveTable(_layout: CdcEntityLayout): Promise<void> {
    // MongoDB collections are created on first write
  }

  async applyEvents(params: {
    events: CdcStoredEvent[];
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
  }): Promise<{ applied: number }> {
    if (params.events.length === 0) return { applied: 0 };

    const collection = await this.getCollection(params.layout.tableName);
    await this.ensureKeyIndex(collection, params.layout.keyColumns);

    const materialized = materializeCdcEvents({
      events: params.events,
      layout: params.layout,
      flow: params.flow,
    });

    const ops: any[] = [];

    for (const row of [
      ...materialized.upsertRows,
      ...materialized.softDeleteRows,
    ]) {
      const filter = this.buildKeyFilter(params.layout.keyColumns, row);
      ops.push({
        replaceOne: {
          filter,
          replacement: row,
          upsert: true,
        },
      });
    }

    for (const event of materialized.hardDeleteEvents) {
      const payload = normalizePayloadKeys(event.payload || {});
      const dataSourceId =
        payload._dataSourceId ?? materialized.fallbackDataSourceId ?? undefined;
      const keyFilters: Record<string, unknown> = { id: event.recordId };
      if (dataSourceId !== undefined) {
        keyFilters._dataSourceId = dataSourceId;
      }
      ops.push({
        deleteOne: { filter: keyFilters },
      });
    }

    if (ops.length > 0) {
      const result = await collection.bulkWrite(ops, { ordered: false });
      log.info("MongoDB CDC applyEvents complete", {
        table: params.layout.tableName,
        upserted: result.upsertedCount,
        modified: result.modifiedCount,
        deleted: result.deletedCount,
      });
    }

    return { applied: materialized.applied };
  }

  async applyBatch(params: {
    records: Array<Record<string, unknown>>;
    layout: CdcEntityLayout;
    flow: Pick<IFlow, "_id" | "deleteMode" | "dataSourceId">;
  }): Promise<{ written: number }> {
    if (params.records.length === 0) return { written: 0 };

    const collection = await this.getCollection(params.layout.tableName);
    await this.ensureKeyIndex(collection, params.layout.keyColumns);

    const fallbackDataSourceId = params.flow.dataSourceId
      ? String(params.flow.dataSourceId)
      : undefined;

    const ops = params.records.map(record => {
      const payload = normalizePayloadKeys(record);
      const row = {
        ...payload,
        _dataSourceId: payload._dataSourceId ?? fallbackDataSourceId,
        _mako_source_ts: resolveSourceTimestamp(payload),
        _mako_ingest_seq:
          typeof payload._mako_ingest_seq === "number"
            ? payload._mako_ingest_seq
            : undefined,
      };

      const filter = this.buildKeyFilter(params.layout.keyColumns, row);
      return {
        replaceOne: {
          filter,
          replacement: row,
          upsert: true,
        },
      };
    });

    const result = await collection.bulkWrite(ops, { ordered: false });

    log.info("MongoDB CDC applyBatch complete", {
      table: params.layout.tableName,
      total: params.records.length,
      upserted: result.upsertedCount,
      modified: result.modifiedCount,
    });

    return { written: result.upsertedCount + result.modifiedCount };
  }

  private buildKeyFilter(
    keyColumns: string[],
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    for (const col of keyColumns) {
      filter[col] = row[col] ?? null;
    }
    return filter;
  }
}
