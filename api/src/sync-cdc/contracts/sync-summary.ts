import type { SyncState } from "../../database/workspace-schema";

export interface CdcLastTransition {
  fromState: SyncState;
  event: string;
  toState: SyncState;
  at: Date;
  reason?: string;
}

export interface CdcEntitySummary {
  entity: string;
  appliedCount: number;
  backlogCount: number;
  failedCount: number;
  droppedCount: number;
  lagSeconds: number | null;
  lastMaterializedAt: Date | null;
}

export interface CdcSyncSummary {
  syncState: SyncState;
  lastTransition: CdcLastTransition | null;
  lastWebhookAt: Date | null;
  lastMaterializedAt: Date | null;
  appliedCount: number;
  backlogCount: number;
  failedCount: number;
  droppedCount: number;
  lagSeconds: number | null;
  entityCounts: CdcEntitySummary[];
}

export interface CdcSyncDiagnostics {
  syncState: SyncState;
  transitions: CdcLastTransition[];
  cursors: Array<{
    entity: string;
    lastIngestSeq: number;
    lastMaterializedSeq: number;
    backlogCount: number;
    lagSeconds: number | null;
    lastMaterializedAt: Date | null;
  }>;
  recentEvents: Array<{
    entity: string;
    recordId: string;
    operation: "upsert" | "delete";
    sourceTs: Date;
    ingestSeq: number;
    source: "webhook" | "backfill";
    materializationStatus: "pending" | "applied" | "failed" | "dropped";
  }>;
}
