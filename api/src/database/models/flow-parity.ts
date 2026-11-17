import mongoose, { Schema, Types } from "mongoose";

/**
 * One parity check between a live flow and its shadow (RFC connector-runtime
 * §10, iteration 5): the live flow's built-in connector against its folder
 * twin in a box, compared in the destination row by row.
 *
 * Written by connectors/boxed-runtime/parity.service.ts, read by flow_status,
 * flow_parity and the switch gate. Checks expire after 30 days.
 */
export interface IFlowParityFieldDiff {
  field: string;
  rows: number;
  /** Up to 3 differing rows: the key and both values, truncated. */
  samples: Array<{ key: string; live: string | null; shadow: string | null }>;
}

export interface IFlowParityEntity {
  entity: string;
  table: string;
  keyColumns: string[];
  /** Non-deleted rows on each side. */
  liveRows: number;
  shadowRows: number;
  /** Keys excluded because either side changed after the cutoff. */
  recent: number;
  /** Keys compared (present on either side, not recent). */
  compared: number;
  bothKeys: number;
  liveOnly: number;
  shadowOnly: number;
  /** Keys present on both sides whose field checksum differs. */
  rowsDiffering: number;
  /** BIT_XOR of the per-row field checksums over the compared keys. */
  liveChecksum: string | null;
  shadowChecksum: string | null;
  /** Columns on one side only (metadata columns excluded). */
  liveOnlyColumns: string[];
  shadowOnlyColumns: string[];
  /** The fields that differ most, with samples. Reported, not blocking. */
  topFields: IFlowParityFieldDiff[];
  /** Rows where live has a value and the shadow NULL. Blocks the gate. */
  newNullRows: number;
  newNullFields: Array<{ field: string; rows: number }>;
  /** What the check found that does not block the gate. */
  notes: string[];
  /** Live rows changed in the window, and how the shadow kept up. */
  window: {
    liveRows: number;
    matched: number;
    missingOrBehind: number;
    lagP50Seconds: number | null;
    lagP95Seconds: number | null;
  };
  clean: boolean;
  reasons: string[];
  error?: string;
}

export interface IFlowParityCheck {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  shadowFlowId: Types.ObjectId;
  trigger: "scheduled" | "manual";
  status: "running" | "done" | "error";
  startedAt: Date;
  finishedAt?: Date;
  /** Rows whose source timestamp is at or after this on either side are not compared. */
  cutoff?: Date;
  /** The live-update window: changes in [start, end) on the live side. */
  window?: { start: Date; end: Date; coverageMinutes: number };
  /** The shadow's failures in the freshness window. Any one blocks the gate. */
  failures?: {
    failedRuns: number;
    failedEntities: string[];
    failedWebhookEvents: number;
  };
  /** The twin the shadow ran (its approval): slug and folder source hash. */
  twin?: { slug: string; sourceSha?: string; registryHash?: string };
  /** When the shadow's full-history backfill completed, as this check saw it. */
  shadowBackfillCompletedAt?: Date | null;
  entities: IFlowParityEntity[];
  clean: boolean;
  /** Why this check is not clean, or why it does not open the gate. */
  reasons: string[];
  error?: string;
}

const FieldDiffSchema = new Schema<IFlowParityFieldDiff>(
  {
    field: String,
    rows: Number,
    samples: [
      {
        _id: false,
        key: String,
        live: { type: String, default: null },
        shadow: { type: String, default: null },
      },
    ],
  },
  { _id: false },
);

const EntitySchema = new Schema<IFlowParityEntity>(
  {
    entity: String,
    table: String,
    keyColumns: [String],
    liveRows: Number,
    shadowRows: Number,
    recent: Number,
    compared: Number,
    bothKeys: Number,
    liveOnly: Number,
    shadowOnly: Number,
    rowsDiffering: Number,
    liveChecksum: { type: String, default: null },
    shadowChecksum: { type: String, default: null },
    liveOnlyColumns: [String],
    shadowOnlyColumns: [String],
    topFields: [FieldDiffSchema],
    newNullRows: { type: Number, default: 0 },
    newNullFields: [{ _id: false, field: String, rows: Number }],
    notes: [String],
    window: {
      liveRows: Number,
      matched: Number,
      missingOrBehind: Number,
      lagP50Seconds: { type: Number, default: null },
      lagP95Seconds: { type: Number, default: null },
    },
    clean: Boolean,
    reasons: [String],
    error: String,
  },
  { _id: false },
);

export const FLOW_PARITY_TTL_SECONDS = 30 * 24 * 60 * 60;

const FlowParityCheckSchema = new Schema<IFlowParityCheck>(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true },
    flowId: { type: Schema.Types.ObjectId, ref: "Flow", required: true },
    shadowFlowId: { type: Schema.Types.ObjectId, ref: "Flow", required: true },
    trigger: { type: String, enum: ["scheduled", "manual"], required: true },
    status: {
      type: String,
      enum: ["running", "done", "error"],
      required: true,
    },
    startedAt: { type: Date, required: true },
    finishedAt: Date,
    cutoff: Date,
    window: { start: Date, end: Date, coverageMinutes: Number },
    twin: { slug: String, sourceSha: String, registryHash: String },
    failures: {
      failedRuns: Number,
      failedEntities: [String],
      failedWebhookEvents: Number,
    },
    shadowBackfillCompletedAt: { type: Date, default: null },
    entities: [EntitySchema],
    clean: { type: Boolean, default: false },
    reasons: [String],
    error: String,
  },
  { collection: "flow_parity_checks" },
);

FlowParityCheckSchema.index({ shadowFlowId: 1, startedAt: -1 });
FlowParityCheckSchema.index({ flowId: 1, startedAt: -1 });
FlowParityCheckSchema.index(
  { startedAt: 1 },
  {
    name: "flow_parity_checks_ttl_30d",
    expireAfterSeconds: FLOW_PARITY_TTL_SECONDS,
  },
);

export const FlowParityCheck =
  (mongoose.models.FlowParityCheck as mongoose.Model<IFlowParityCheck>) ||
  mongoose.model<IFlowParityCheck>("FlowParityCheck", FlowParityCheckSchema);
