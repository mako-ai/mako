import type { CdcOperation } from "./cdc-event";

export interface CdcEntityLayout {
  entity: string;
  tableName: string;
  keyColumns: string[];
  deleteMode?: "hard" | "soft";
  partitioning?: {
    field: string;
    granularity?: "day" | "hour" | "month" | "year";
    requirePartitionFilter?: boolean;
  };
  clustering?: {
    fields: string[];
  };
}

export interface CdcApplyChange {
  entity: string;
  recordId: string;
  operation: CdcOperation;
  payload?: Record<string, unknown>;
  sourceTs: Date;
  ingestSeq: number;
}

export interface CdcApplyOrderingKey {
  sourceTsField: string;
  ingestSeqField: string;
}

export interface CdcApplyResult {
  appliedCount: number;
  failedCount: number;
}

export interface CdcDestinationAdapter {
  ensureLiveTable(layout: CdcEntityLayout): Promise<void>;
  applyChanges(
    layout: CdcEntityLayout,
    batch: CdcApplyChange[],
    ordering: CdcApplyOrderingKey,
    fencingToken: number,
  ): Promise<CdcApplyResult>;
  upsertRecords(
    layout: CdcEntityLayout,
    records: Record<string, unknown>[],
    fencingToken: number,
  ): Promise<number>;
  applyTombstones(
    layout: CdcEntityLayout,
    recordIds: string[],
    fencingToken: number,
  ): Promise<number>;
  getLagAndBacklog?(layout: CdcEntityLayout): Promise<{
    lagSeconds: number | null;
    backlogCount: number;
  }>;
}
