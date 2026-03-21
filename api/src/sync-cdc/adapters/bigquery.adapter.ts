import { Types } from "mongoose";
import { createDestinationWriter } from "../../services/destination-writer.service";
import {
  CdcApplyChange,
  CdcApplyOrderingKey,
  CdcApplyResult,
  CdcDestinationAdapter,
  CdcEntityLayout,
  CdcMaterializationResult,
  CdcMaterializationRun,
} from "../contracts/destination-adapter";
import { materializeBigQueryEntity } from "../../services/bigquery-cdc.service";

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
    // Table creation is handled lazily in DestinationWriter.writeBatch()
  }

  async materializeEntity(
    run: CdcMaterializationRun,
    _fencingToken: number,
  ): Promise<CdcMaterializationResult> {
    return materializeBigQueryEntity({
      workspaceId: run.workspaceId,
      flowId: run.flowId,
      entity: run.entity,
      maxEvents: run.maxEvents,
    });
  }

  async applyChanges(
    layout: CdcEntityLayout,
    batch: CdcApplyChange[],
    _ordering: CdcApplyOrderingKey,
    _fencingToken: number,
  ): Promise<CdcApplyResult> {
    const sorted = [...batch].sort((a, b) => {
      const tsDiff = a.sourceTs.getTime() - b.sourceTs.getTime();
      if (tsDiff !== 0) return tsDiff;
      return a.ingestSeq - b.ingestSeq;
    });

    const latestByRecord = new Map<string, CdcApplyChange>();
    for (const change of sorted) {
      latestByRecord.set(change.recordId, change);
    }

    const latest = Array.from(latestByRecord.values());
    const upserts = latest.filter(change => change.operation === "upsert");
    const tombstones = latest.filter(change => change.operation === "delete");

    let appliedCount = 0;
    if (upserts.length > 0) {
      appliedCount += await this.upsertRecords(
        layout,
        upserts.map(change => ({
          ...(change.payload || {}),
          id: change.recordId,
          _mako_source_ts: change.sourceTs,
          _mako_ingest_seq: change.ingestSeq,
          _mako_operation: change.operation,
        })),
        0,
      );
    }

    if (tombstones.length > 0) {
      appliedCount += await this.applyTombstones(
        layout,
        tombstones.map(change => change.recordId),
        0,
      );
    }

    return {
      appliedCount,
      failedCount: Math.max(latest.length - appliedCount, 0),
    };
  }

  async upsertRecords(
    layout: CdcEntityLayout,
    records: Record<string, unknown>[],
    _fencingToken: number,
  ): Promise<number> {
    if (records.length === 0) return 0;
    const writer = await this.createWriter(layout.tableName);
    const result = await writer.writeBatch(records, {
      keyColumns: layout.keyColumns.length > 0 ? layout.keyColumns : ["id"],
      conflictStrategy: "update",
    });
    if (!result.success) {
      throw new Error(result.error || "Failed to upsert CDC records");
    }
    return result.rowsWritten;
  }

  async applyTombstones(
    layout: CdcEntityLayout,
    recordIds: string[],
    _fencingToken: number,
  ): Promise<number> {
    if (recordIds.length === 0) return 0;
    const writer = await this.createWriter(layout.tableName);
    const rows = recordIds.map(recordId => ({
      id: recordId,
      is_deleted: true,
      deleted_at: new Date(),
      _mako_operation: "delete",
    }));
    const result = await writer.writeBatch(rows, {
      keyColumns: layout.keyColumns.length > 0 ? layout.keyColumns : ["id"],
      conflictStrategy: "update",
    });
    if (!result.success) {
      throw new Error(result.error || "Failed to apply CDC tombstones");
    }
    return result.rowsWritten;
  }

  async getLagAndBacklog(_layout: CdcEntityLayout): Promise<{
    lagSeconds: number | null;
    backlogCount: number;
  }> {
    return {
      lagSeconds: null,
      backlogCount: 0,
    };
  }

  private async createWriter(entityTableName: string) {
    return createDestinationWriter(
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
          tableName: entityTableName,
        },
      },
      "cdc-bigquery-adapter",
    );
  }
}
