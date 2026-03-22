import type { NormalizedCdcEvent } from "./events";

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
  materializeEntity(
    run: CdcMaterializationRun,
    fencingToken: number,
  ): Promise<CdcMaterializationResult>;
}

export interface CdcSourceAdapter {
  fromWebhook(params: {
    event: unknown;
    eventType?: string;
    runId?: string;
  }): Promise<NormalizedCdcEvent[]>;
  fromBackfill(params: {
    entity: string;
    records: Array<Record<string, unknown>>;
    runId?: string;
  }): Promise<NormalizedCdcEvent[]>;
}
