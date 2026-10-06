/**
 * Process persistence — five collections, one of them append-only.
 *
 *   processes               a workspace's installation of a definition
 *   process_versions        immutable snapshot of each distinct definition
 *   process_runs            one row per run: status projection + summary
 *   process_events          APPEND-ONLY journal: timeline, audit, memo, traces
 *   process_human_requests  approvals and tasks (queried across runs: inbox)
 *
 * Steps, tool invocations, agent turns, logs and artifacts are all events.
 * `projectRun()` folds them into the step view; nothing else is materialized.
 */
import mongoose, { Schema, type Document, type Types } from "mongoose";

// ── processes ──────────────────────────────────────────────────────────────

export interface IProcess extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  /** Definition id from the registry (kebab-case). */
  processId: string;
  enabled: boolean;
  /** Connection binding slot → connection id. */
  bindings: Record<string, string>;
  runCounter: number;
  versionCounter: number;
  /** Per schedule trigger (by cron string): last time it was claimed. */
  lastScheduledAt: Record<string, Date>;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ProcessSchema = new Schema<IProcess>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    processId: { type: String, required: true },
    enabled: { type: Boolean, default: false },
    bindings: { type: Schema.Types.Mixed, default: {} },
    runCounter: { type: Number, default: 0 },
    versionCounter: { type: Number, default: 0 },
    lastScheduledAt: { type: Schema.Types.Mixed, default: {} },
    updatedBy: { type: String },
  },
  { collection: "processes", timestamps: true, minimize: false },
);
ProcessSchema.index({ workspaceId: 1, processId: 1 }, { unique: true });

export const ProcessInstallation = mongoose.model<IProcess>(
  "ProcessInstallation",
  ProcessSchema,
);

// ── process_versions ───────────────────────────────────────────────────────

export interface OutlineItem {
  kind: "step" | "agent" | "approval" | "task" | "wait";
  name: string;
  /** Inside a loop/conditional: the name may be a template. */
  dynamic: boolean;
}

export interface ProcessManifest {
  name: string;
  description?: string;
  triggers: unknown[];
  tools: Array<{
    name: string;
    effect: string;
    description: string;
    connections: string[];
  }>;
  inputSchema: unknown;
}

export interface IProcessVersion extends Document {
  _id: Types.ObjectId;
  /** Global per definition (not per workspace): code is shared. */
  processId: string;
  hash: string;
  number: number;
  source: string;
  outline: OutlineItem[];
  manifest: ProcessManifest;
  firstSeenBuild?: string;
  createdAt: Date;
}

const ProcessVersionSchema = new Schema<IProcessVersion>(
  {
    processId: { type: String, required: true },
    hash: { type: String, required: true },
    number: { type: Number, required: true },
    source: { type: String, required: true },
    outline: { type: Schema.Types.Mixed, default: [] },
    manifest: { type: Schema.Types.Mixed, required: true },
    firstSeenBuild: { type: String },
  },
  {
    collection: "process_versions",
    timestamps: { createdAt: true, updatedAt: false },
  },
);
ProcessVersionSchema.index({ processId: 1, hash: 1 }, { unique: true });
ProcessVersionSchema.index({ processId: 1, number: 1 }, { unique: true });

export const ProcessVersion = mongoose.model<IProcessVersion>(
  "ProcessVersion",
  ProcessVersionSchema,
);

// ── process_runs ───────────────────────────────────────────────────────────

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export interface WaitingOn {
  kind: "approval" | "task" | "sleep" | "event";
  stepKey: string;
  title: string;
  until?: Date;
  event?: string;
  match?: Record<string, unknown>;
  requestId?: string;
}

export interface RunTrigger {
  type: "manual" | "event" | "schedule" | "api";
  by?: string;
  event?: string;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  modelCalls: number;
  toolCalls: number;
}

export interface IProcessRun extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  processId: string;
  number: number;
  versionId: Types.ObjectId;
  versionNumber: number;
  status: RunStatus;
  waitingOn?: WaitingOn | null;
  input: unknown;
  output?: unknown;
  error?: { message: string; stepKey?: string } | null;
  trigger: RunTrigger;
  idempotencyKey?: string;
  usage: RunUsage;
  /** Increments each time "retry run" re-queues a failed run. */
  attempt: number;
  startedAt?: Date;
  endedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ProcessRunSchema = new Schema<IProcessRun>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    processId: { type: String, required: true },
    number: { type: Number, required: true },
    versionId: { type: Schema.Types.ObjectId, required: true },
    versionNumber: { type: Number, required: true },
    status: { type: String, enum: RUN_STATUSES, required: true },
    waitingOn: { type: Schema.Types.Mixed, default: null },
    input: { type: Schema.Types.Mixed },
    output: { type: Schema.Types.Mixed },
    error: { type: Schema.Types.Mixed, default: null },
    trigger: { type: Schema.Types.Mixed, required: true },
    idempotencyKey: { type: String },
    usage: {
      type: Schema.Types.Mixed,
      default: () => ({
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        modelCalls: 0,
        toolCalls: 0,
      }),
    },
    attempt: { type: Number, default: 0 },
    startedAt: { type: Date },
    endedAt: { type: Date },
  },
  { collection: "process_runs", timestamps: true, minimize: false },
);
ProcessRunSchema.index({ workspaceId: 1, processId: 1, createdAt: -1 });
ProcessRunSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
ProcessRunSchema.index(
  { workspaceId: 1, processId: 1, number: 1 },
  { unique: true },
);
ProcessRunSchema.index(
  { workspaceId: 1, processId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  },
);
ProcessRunSchema.index({ "waitingOn.event": 1, status: 1, workspaceId: 1 });

export const ProcessRun = mongoose.model<IProcessRun>(
  "ProcessRun",
  ProcessRunSchema,
);

// ── process_events (append-only) ───────────────────────────────────────────

export type ProcessEventType =
  | "run.created"
  | "run.started"
  | "run.version_changed"
  | "run.retried"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "log"
  | "artifact.created"
  | "agent.started"
  | "agent.turn"
  | "agent.completed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "human.requested"
  | "human.responded"
  | "human.expired"
  | "wait.started"
  | "wait.matched"
  | "wait.completed";

export interface IProcessEvent extends Document {
  _id: Types.ObjectId;
  runId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  ts: Date;
  type: ProcessEventType;
  stepKey?: string;
  versionId?: Types.ObjectId;
  data: Record<string, unknown>;
  /**
   * Set on events that double as durable state (step memo, effect ledger,
   * one-shot markers). Unique per run, so a duplicate write is a no-op.
   */
  dedupeKey?: string;
}

const ProcessEventSchema = new Schema<IProcessEvent>(
  {
    runId: { type: Schema.Types.ObjectId, required: true },
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    ts: { type: Date, required: true },
    type: { type: String, required: true },
    stepKey: { type: String },
    versionId: { type: Schema.Types.ObjectId },
    data: { type: Schema.Types.Mixed, default: {} },
    dedupeKey: { type: String },
  },
  { collection: "process_events", minimize: false },
);
ProcessEventSchema.index({ runId: 1, ts: 1, _id: 1 });
ProcessEventSchema.index(
  { runId: 1, dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: "string" } },
  },
);
ProcessEventSchema.index({ runId: 1, stepKey: 1, type: 1 });

export const ProcessEvent = mongoose.model<IProcessEvent>(
  "ProcessEvent",
  ProcessEventSchema,
);

// ── process_human_requests ─────────────────────────────────────────────────

export const HUMAN_REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "submitted",
  "expired",
  "cancelled",
] as const;
export type HumanRequestStatus = (typeof HUMAN_REQUEST_STATUSES)[number];

export interface IHumanRequest extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  runId: Types.ObjectId;
  processId: string;
  runNumber: number;
  stepKey: string;
  kind: "approval" | "task";
  title: string;
  description?: string;
  /** Frozen at request time (approval data / task prefill). */
  payload: unknown;
  /** JSON schema: editable approval data, or the task form. */
  dataSchema?: unknown;
  assignees: string[];
  status: HumanRequestStatus;
  response?: { data?: unknown; comment?: string; edited?: boolean } | null;
  respondedBy?: { id: string; name?: string; email?: string } | null;
  respondedAt?: Date;
  expiresAt: Date;
  versionId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const HumanRequestSchema = new Schema<IHumanRequest>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    runId: { type: Schema.Types.ObjectId, required: true },
    processId: { type: String, required: true },
    runNumber: { type: Number, required: true },
    stepKey: { type: String, required: true },
    kind: { type: String, enum: ["approval", "task"], required: true },
    title: { type: String, required: true },
    description: { type: String },
    payload: { type: Schema.Types.Mixed },
    dataSchema: { type: Schema.Types.Mixed },
    assignees: { type: [String], default: [] },
    status: { type: String, enum: HUMAN_REQUEST_STATUSES, required: true },
    response: { type: Schema.Types.Mixed, default: null },
    respondedBy: { type: Schema.Types.Mixed, default: null },
    respondedAt: { type: Date },
    expiresAt: { type: Date, required: true },
    versionId: { type: Schema.Types.ObjectId, required: true },
  },
  { collection: "process_human_requests", timestamps: true, minimize: false },
);
HumanRequestSchema.index({ runId: 1, stepKey: 1 }, { unique: true });
HumanRequestSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });

export const HumanRequest = mongoose.model<IHumanRequest>(
  "ProcessHumanRequest",
  HumanRequestSchema,
);
