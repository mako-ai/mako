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

export interface CdcMaterializationRun {
  workspaceId: string;
  flowId: string;
  entity: string;
  maxEvents?: number;
}

export interface CdcMaterializationResult {
  staged: number;
  applied: number;
  lastMaterializedSeq: number;
  skipped?: boolean;
  reason?: string;
}

export interface CdcDestinationAdapter {
  destinationType: string;
  ensureLiveTable(layout: CdcEntityLayout): Promise<void>;
  ensureStageTable?(
    layout: CdcEntityLayout,
    run: CdcMaterializationRun,
  ): Promise<void>;
  stageChanges?(
    layout: CdcEntityLayout,
    batch: CdcApplyChange[],
    run: CdcMaterializationRun,
  ): Promise<{ stagedCount: number; stageRef: string }>;
  materializeEntity(
    run: CdcMaterializationRun,
    fencingToken: number,
  ): Promise<CdcMaterializationResult>;
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
