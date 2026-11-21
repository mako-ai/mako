import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * BigQuery CDC change event model interface
 * Canonical append-only change log for webhook + backfill writes.
 */
export interface ICdcChangeEvent extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  runId?: string;
  sourceKind: "webhook" | "backfill";
  entity: string;
  recordId: string;
  op: "upsert" | "delete";
  sourceTs: Date;
  ingestTs: Date;
  ingestSeq: number;
  idempotencyKey: string;
  payload?: unknown;
  webhookEventId?: string;
  stageStatus: "pending" | "staged" | "failed";
  stageAttemptCount: number;
  stagedAt?: Date;
  stageError?: {
    message: string;
    code?: string;
  };
  materializationStatus: "pending" | "applied" | "failed" | "dropped";
  retainedBigQueryWrite?: string;
  materializationAttemptCount: number;
  appliedAt?: Date;
  materializationError?: {
    message: string;
    code?: string;
  };
}

/**
 * CdcChangeEvent Schema
 */
const CdcChangeEventSchema = new Schema<ICdcChangeEvent>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    flowId: { type: Schema.Types.ObjectId, ref: "Flow", required: true },
    runId: String,
    sourceKind: {
      type: String,
      enum: ["webhook", "backfill"],
      required: true,
    },
    entity: { type: String, required: true },
    recordId: { type: String, required: true },
    op: { type: String, enum: ["upsert", "delete"], required: true },
    sourceTs: { type: Date, required: true },
    ingestTs: { type: Date, required: true, default: Date.now },
    ingestSeq: { type: Number, required: true },
    idempotencyKey: { type: String, required: true },
    payload: Schema.Types.Mixed,
    webhookEventId: String,
    stageStatus: {
      type: String,
      enum: ["pending", "staged", "failed"],
      default: "pending",
      required: true,
    },
    stageAttemptCount: { type: Number, default: 0 },
    stagedAt: Date,
    stageError: {
      message: String,
      code: String,
    },
    materializationStatus: {
      type: String,
      enum: ["pending", "applied", "failed", "dropped"],
      default: "pending",
      required: true,
    },
    retainedBigQueryWrite: String,
    materializationAttemptCount: { type: Number, default: 0 },
    appliedAt: Date,
    materializationError: {
      message: String,
      code: String,
    },
  },
  {
    collection: "cdc_change_events",
    timestamps: false,
  },
);

CdcChangeEventSchema.index({ idempotencyKey: 1 }, { unique: true });
CdcChangeEventSchema.index({ flowId: 1, entity: 1, ingestSeq: 1 });
CdcChangeEventSchema.index(
  { flowId: 1, entity: 1, recordId: 1, sourceTs: 1, ingestSeq: 1 },
  { unique: true },
);
CdcChangeEventSchema.index({
  flowId: 1,
  entity: 1,
  sourceTs: 1,
  ingestSeq: 1,
});
CdcChangeEventSchema.index({
  flowId: 1,
  entity: 1,
  materializationStatus: 1,
  ingestSeq: 1,
});
CdcChangeEventSchema.index({
  flowId: 1,
  entity: 1,
  stageStatus: 1,
  ingestSeq: 1,
});
/** Successfully materialized rows — shorter retention. */
CdcChangeEventSchema.index(
  { appliedAt: 1 },
  {
    name: "cdc_applied_events_ttl_36h",
    expireAfterSeconds: 36 * 60 * 60,
    partialFilterExpression: {
      appliedAt: { $exists: true },
      materializationStatus: "applied",
    },
  },
);
/** Dropped rows (e.g. entity disabled) — keep longer for audit. */
CdcChangeEventSchema.index(
  { appliedAt: 1 },
  {
    name: "cdc_dropped_events_ttl_7d",
    expireAfterSeconds: 7 * 24 * 60 * 60,
    partialFilterExpression: {
      appliedAt: { $exists: true },
      materializationStatus: "dropped",
    },
  },
);

export const CdcChangeEvent = mongoose.model<ICdcChangeEvent>(
  "CdcChangeEvent",
  CdcChangeEventSchema,
);

/**
 * Per-flow/entity CDC state for observability and adaptive cadence
 */
export interface ICdcEntityState extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  entity: string;
  mode: "steady" | "backfill";
  runId?: string;
  backfillStartedAt?: Date;
  backfillCompletedAt?: Date;
  /**
   * `backfillState.startedAt` of the last backfill run in which this entity
   * completed (full or incremental) — the anchor of the next incremental
   * scheduled resync. See sync-cdc/backfill-fetch-mode.ts.
   */
  lastBackfillRunStartedAt?: Date;
  /** Same, for the last run in which this entity was fetched in FULL. */
  lastFullBackfillRunStartedAt?: Date;
  /**
   * Start of the last scheduled poll run in which this entity completed —
   * the anchor of the next incremental poll. Only polls write it; webhook
   * writes never move it. See sync-cdc/poll-cursor.ts.
   */
  lastPollRunStartedAt?: Date;
  lastIngestSeq: number;
  lastMaterializedSeq: number;
  lastMaterializedAt?: Date;
  backlogCount: number;
  lifetimeEventsProcessed: number;
  lifetimeRowsApplied: number;
  lastEnqueuedAt?: Date;
  mergeIntervalSeconds: number;
  backfillCursor?: Record<string, unknown>;
  /**
   * The backfill run and destination `backfillCursor` belongs to
   * (backfillCheckpointScope). A cursor of another scope is never resumed.
   */
  backfillCursorScope?: string;
  consecutiveFailures: number;
  lastFailedAt?: Date;
  lastFailureError?: string;
  // Progress of an in-place destination-table repartition (layout change).
  repartition?: {
    status: "pending" | "running" | "done" | "failed";
    startedAt?: Date;
    completedAt?: Date;
    error?: string;
  };
}

/**
 * CdcEntityState schema
 */
const CdcEntityStateSchema = new Schema<ICdcEntityState>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    flowId: { type: Schema.Types.ObjectId, ref: "Flow", required: true },
    entity: { type: String, required: true },
    mode: {
      type: String,
      enum: ["steady", "backfill"],
      default: "steady",
      required: true,
    },
    runId: String,
    backfillStartedAt: Date,
    backfillCompletedAt: Date,
    lastBackfillRunStartedAt: Date,
    lastFullBackfillRunStartedAt: Date,
    lastPollRunStartedAt: Date,
    lastIngestSeq: { type: Number, default: 0 },
    lastMaterializedSeq: { type: Number, default: 0 },
    lastMaterializedAt: Date,
    backlogCount: { type: Number, default: 0 },
    lifetimeEventsProcessed: { type: Number, default: 0 },
    lifetimeRowsApplied: { type: Number, default: 0 },
    lastEnqueuedAt: Date,
    mergeIntervalSeconds: { type: Number, default: 300 },
    backfillCursor: Schema.Types.Mixed,
    backfillCursorScope: String,
    consecutiveFailures: { type: Number, default: 0 },
    lastFailedAt: Date,
    lastFailureError: String,
    repartition: {
      status: {
        type: String,
        enum: ["pending", "running", "done", "failed"],
      },
      startedAt: Date,
      completedAt: Date,
      error: String,
    },
  },
  {
    collection: "cdc_entity_state",
    timestamps: false,
  },
);

CdcEntityStateSchema.index({ flowId: 1, entity: 1 }, { unique: true });
CdcEntityStateSchema.index({ workspaceId: 1, flowId: 1 });

export const CdcEntityState = mongoose.model<ICdcEntityState>(
  "CdcEntityState",
  CdcEntityStateSchema,
);

export interface ICdcStateTransition extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  machine?: "stream" | "backfill";
  fromState: string;
  event: string;
  toState: string;
  at: Date;
  reason?: string;
}

const CdcStateTransitionSchema = new Schema<ICdcStateTransition>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    flowId: { type: Schema.Types.ObjectId, ref: "Flow", required: true },
    machine: {
      type: String,
      enum: ["stream", "backfill"],
    },
    fromState: {
      type: String,
      required: true,
    },
    event: { type: String, required: true },
    toState: {
      type: String,
      required: true,
    },
    at: { type: Date, required: true, default: Date.now },
    reason: String,
  },
  {
    collection: "cdc_state_transitions",
    timestamps: false,
  },
);

CdcStateTransitionSchema.index({ flowId: 1, at: -1 });
CdcStateTransitionSchema.index({ workspaceId: 1, flowId: 1, at: -1 });

export const CdcStateTransition = mongoose.model<ICdcStateTransition>(
  "CdcStateTransition",
  CdcStateTransitionSchema,
);

export type IBigQueryChangeEvent = ICdcChangeEvent;
export type IBigQueryCdcState = ICdcEntityState;
// Legacy aliases for backward compatibility

export const BigQueryChangeEvent = CdcChangeEvent;
export const BigQueryCdcState = CdcEntityState;
