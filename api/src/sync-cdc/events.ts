import { z } from "zod";

const cdcOperationSchema = z.enum(["upsert", "delete"]);
const cdcSourceSchema = z.enum(["webhook", "backfill"]);

const normalizedCdcEventSchema = z.object({
  entity: z.string().min(1),
  recordId: z.string().min(1),
  operation: cdcOperationSchema,
  payload: z.record(z.string(), z.unknown()).optional(),
  sourceTs: z.date(),
  source: cdcSourceSchema,
  changeId: z.string().optional(),
  runId: z.string().optional(),
});

export type CdcEventSource = z.infer<typeof cdcSourceSchema>;
export type CdcEventOperation = z.infer<typeof cdcOperationSchema>;
export type CdcMaterializationStatus =
  | "pending"
  | "applied"
  | "failed"
  | "dropped";
export type NormalizedCdcEvent = z.infer<typeof normalizedCdcEventSchema>;

export interface CdcEventInput {
  entity: string;
  recordId: string;
  operation: CdcEventOperation;
  payload?: Record<string, unknown>;
  sourceTs?: Date;
  source: CdcEventSource;
  idempotencyKey?: string;
  runId?: string;
  webhookEventId?: string;
}

export interface CdcStoredEvent {
  id: string;
  workspaceId: string;
  flowId: string;
  runId?: string;
  source: CdcEventSource;
  entity: string;
  recordId: string;
  operation: CdcEventOperation;
  sourceTs: Date;
  ingestTs: Date;
  ingestSeq: number;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  webhookEventId?: string;
  materializationStatus: CdcMaterializationStatus;
}

export interface CdcAppendEntitySummary {
  entity: string;
  source: CdcEventSource;
  runId?: string;
  lastIngestSeq: number;
}

export interface CdcAppendResult {
  inserted: number;
  deduped: number;
  attempted: number;
  entities: CdcAppendEntitySummary[];
}

export interface CdcEventStore {
  appendEvents(params: {
    workspaceId: string;
    flowId: string;
    events: CdcEventInput[];
  }): Promise<CdcAppendResult>;

  readAfter(params: {
    flowId: string;
    entity: string;
    afterIngestSeq: number;
    limit: number;
  }): Promise<CdcStoredEvent[]>;

  markEventsApplied(eventIds: string[]): Promise<void>;

  markEventsFailed(params: {
    eventIds: string[];
    errorCode?: string;
    errorMessage: string;
  }): Promise<void>;

  markEventsDropped(params: {
    eventIds: string[];
    errorCode?: string;
    errorMessage: string;
  }): Promise<void>;

  countEvents(params: {
    flowId: string;
    workspaceId?: string;
    entity?: string;
    source?: CdcEventSource;
    materializationStatus?: CdcMaterializationStatus;
  }): Promise<number>;

  countEventsByEntity(params: {
    flowId: string;
    workspaceId?: string;
    materializationStatus: CdcMaterializationStatus;
  }): Promise<Array<{ entity: string; count: number }>>;

  findLatestEvent(params: {
    flowId: string;
    workspaceId?: string;
    source?: CdcEventSource;
  }): Promise<CdcStoredEvent | null>;

  listRecentEvents(params: {
    flowId: string;
    workspaceId: string;
    limit: number;
  }): Promise<CdcStoredEvent[]>;

  resetFailedEvents(params: {
    workspaceId: string;
    flowId: string;
    entity?: string;
  }): Promise<{
    resetCount: number;
    entities: string[];
    webhookEventIds: string[];
  }>;

  deleteFlowEvents(params: {
    workspaceId: string;
    flowId: string;
  }): Promise<number>;
}

export function normalizeCdcEvent(
  candidate: Omit<NormalizedCdcEvent, "sourceTs"> & {
    sourceTs?: Date | string;
  },
): NormalizedCdcEvent {
  const sourceTs =
    candidate.sourceTs instanceof Date
      ? candidate.sourceTs
      : new Date(candidate.sourceTs || Date.now());

  const parsed = normalizedCdcEventSchema.parse({
    ...candidate,
    sourceTs,
  });

  return parsed;
}
