import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * One data-diff check of a flow (sync-cdc/data-diff.ts): per-column non-null
 * counts of each destination table before a write that can rewrite existing
 * rows, the same counts after the run that made it, and the columns that
 * lost values.
 *
 * `open` holds a baseline that waits for the next successful run;
 * `compared` is a finished check. At most one `open` check per flow.
 */
export type FlowDataDiffReason =
  | "backfill"
  | "scheduled-resync"
  | "resync"
  | "entity-reset"
  | "connector-change"
  | "connector-code-change"
  | "destination-change";

export interface IFlowDataDiffCounts {
  rows: number;
  /**
   * The table was over 1 GB: `rows` is exact (metadata), each column's
   * `nonNull` is its share in a 10% block sample times `rows`.
   */
  sampled?: boolean;
  columns: { name: string; nonNull: number }[];
}

export interface IFlowDataDiffTable {
  entity: string;
  table: string;
  before?: IFlowDataDiffCounts;
  after?: IFlowDataDiffCounts;
  error?: string;
}

export interface IFlowDataDiffFlag {
  entity: string;
  table: string;
  /** A column name, or "(rows)" when the table itself lost rows. */
  column: string;
  before: number;
  after: number;
  /** `before` scaled to the table's new row count when it shrank. */
  expected: number;
  lost: number;
  lostPct: number;
}

export interface IFlowDataDiff extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  flowId: Types.ObjectId;
  status: "open" | "compared" | "expired";
  reasons: FlowDataDiffReason[];
  baselineAt: Date;
  comparedAt?: Date;
  executionId?: string;
  /** Where the baseline was read, when the flow wrote elsewhere before. */
  from?: string;
  tables: IFlowDataDiffTable[];
  flagged: IFlowDataDiffFlag[];
  createdAt: Date;
  updatedAt: Date;
}

const CountsSchema = new Schema(
  {
    rows: { type: Number, required: true },
    sampled: Boolean,
    columns: [
      new Schema(
        { name: { type: String, required: true }, nonNull: Number },
        { _id: false },
      ),
    ],
  },
  { _id: false },
);

const FlowDataDiffSchema = new Schema<IFlowDataDiff>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    flowId: { type: Schema.Types.ObjectId, ref: "Flow", required: true },
    status: {
      type: String,
      enum: ["open", "compared", "expired"],
      required: true,
    },
    reasons: [String],
    baselineAt: { type: Date, required: true },
    comparedAt: Date,
    executionId: String,
    from: String,
    tables: [
      new Schema(
        {
          entity: { type: String, required: true },
          table: { type: String, required: true },
          before: CountsSchema,
          after: CountsSchema,
          error: String,
        },
        { _id: false },
      ),
    ],
    flagged: [
      new Schema(
        {
          entity: String,
          table: String,
          column: String,
          before: Number,
          after: Number,
          expected: Number,
          lost: Number,
          lostPct: Number,
        },
        { _id: false },
      ),
    ],
  },
  { timestamps: true, collection: "flow_data_diffs" },
);

FlowDataDiffSchema.index({ flowId: 1, createdAt: -1 });
FlowDataDiffSchema.index({ flowId: 1, status: 1 });
// Checks are evidence for a while, not forever.
FlowDataDiffSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 180 * 24 * 3600 },
);

export const FlowDataDiff = mongoose.model<IFlowDataDiff>(
  "FlowDataDiff",
  FlowDataDiffSchema,
);
