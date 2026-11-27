/**
 * Legacy MongoDB models for a dry run's recorded writes. Postgres
 * (`workflow_recorded_writes`, `workflow_recorded_runs`) is the store of record;
 * these models back the MongoMemoryServer test fallback and the one-shot
 * backfill only.
 */
import mongoose, { Schema, Types } from "mongoose";

import type { RecordedRequest } from "../../connections/forward";

export interface IWorkflowRecordedWrite {
  workspaceId: Types.ObjectId;
  runId: string;
  /** A sandbox run's person: only they read it. */
  userId?: string;
  connectionId: Types.ObjectId;
  connection: string;
  step?: string;
  request: RecordedRequest;
  /** Its place in the run, from 0: the order an answer pages them in. */
  seq: number;
  /** The body was longer than kept. */
  bodyCut?: boolean;
  /** A real run's writer is on the connection's writers list. */
  wouldSend?: boolean;
  at: Date;
}

const WorkflowRecordedWriteSchema = new Schema<IWorkflowRecordedWrite>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    runId: { type: String, required: true },
    userId: { type: String },
    connectionId: { type: Schema.Types.ObjectId, required: true },
    connection: { type: String, required: true },
    step: { type: String },
    request: { type: Schema.Types.Mixed, required: true },
    seq: { type: Number, required: true },
    bodyCut: { type: Boolean },
    wouldSend: { type: Boolean },
    at: { type: Date, default: () => new Date() },
  },
  { collection: "workflow_recorded_writes", versionKey: false },
);

WorkflowRecordedWriteSchema.index(
  { workspaceId: 1, runId: 1, seq: 1 },
  { unique: true },
);
WorkflowRecordedWriteSchema.index(
  { at: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60 },
);

export const WorkflowRecordedWrite =
  (mongoose.models
    .WorkflowRecordedWrite as mongoose.Model<IWorkflowRecordedWrite>) ??
  mongoose.model<IWorkflowRecordedWrite>(
    "WorkflowRecordedWrite",
    WorkflowRecordedWriteSchema,
  );

/** One run's count of recorded writes. */
export interface IWorkflowRecordedRun {
  workspaceId: Types.ObjectId;
  runId: string;
  count: number;
  at: Date;
}

const WorkflowRecordedRunSchema = new Schema<IWorkflowRecordedRun>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    runId: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
    at: { type: Date, default: () => new Date() },
  },
  { collection: "workflow_recorded_runs", versionKey: false },
);

WorkflowRecordedRunSchema.index({ workspaceId: 1, runId: 1 }, { unique: true });
WorkflowRecordedRunSchema.index(
  { at: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60 },
);

export const WorkflowRecordedRun =
  (mongoose.models
    .WorkflowRecordedRun as mongoose.Model<IWorkflowRecordedRun>) ??
  mongoose.model<IWorkflowRecordedRun>(
    "WorkflowRecordedRun",
    WorkflowRecordedRunSchema,
  );
