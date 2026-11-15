import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * QueryExecution model interface
 * Tracks all query executions for usage analytics and billing
 */
export interface IQueryExecution extends Document {
  _id: Types.ObjectId;
  executedAt: Date;

  // Who executed
  userId: string; // Always populated (user or API key owner)
  apiKeyId?: Types.ObjectId; // If executed via API key (nullable for UI sessions)

  // What was executed against
  workspaceId: Types.ObjectId;
  connectionId: Types.ObjectId; // The database connection
  databaseName?: string; // For multi-database connections (D1, clusters)

  // Optional console tracking
  consoleId?: Types.ObjectId; // If executed from a saved console

  // Execution context
  source:
    | "console_ui"
    | "console_ui_admin_override"
    | "api"
    | "mcp"
    | "agent"
    | "flow"
    | "scheduled_query";
  databaseType: string; // postgresql, mongodb, bigquery, etc.
  queryLanguage: "sql" | "mongodb" | "javascript";

  // Results
  status: "success" | "error" | "cancelled" | "timeout";
  executionTimeMs: number;
  rowCount?: number; // Rows returned (if applicable)
  errorType?: string; // If failed: syntax, connection, timeout, permission

  // Optional resource tracking (some DBs provide this)
  bytesScanned?: number; // BigQuery, ClickHouse report this
}

/**
 * QueryExecution Schema
 */
const QueryExecutionSchema = new Schema<IQueryExecution>(
  {
    executedAt: { type: Date, required: true, default: Date.now },

    // Who executed
    userId: { type: String, ref: "User", required: true },
    apiKeyId: { type: Schema.Types.ObjectId, required: false },

    // What was executed against
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    connectionId: {
      type: Schema.Types.ObjectId,
      ref: "DatabaseConnection",
      required: true,
    },
    databaseName: { type: String, required: false },

    // Optional console tracking
    consoleId: {
      type: Schema.Types.ObjectId,
      ref: "SavedConsole",
      required: false,
    },

    // Execution context
    source: {
      type: String,
      enum: [
        "console_ui",
        "console_ui_admin_override",
        "api",
        "mcp",
        "agent",
        "flow",
        "scheduled_query",
      ],
      required: true,
    },
    databaseType: { type: String, required: true },
    queryLanguage: {
      type: String,
      enum: ["sql", "mongodb", "javascript"],
      required: true,
    },

    // Results
    status: {
      type: String,
      enum: ["success", "error", "cancelled", "timeout"],
      required: true,
    },
    executionTimeMs: { type: Number, required: true },
    rowCount: { type: Number, required: false },
    errorType: { type: String, required: false },

    // Optional resource tracking
    bytesScanned: { type: Number, required: false },
  },
  {
    collection: "query_executions",
    timestamps: false,
  },
);

// Indexes for QueryExecution
QueryExecutionSchema.index({ workspaceId: 1, executedAt: -1 }); // Usage over time per workspace
QueryExecutionSchema.index({ userId: 1, executedAt: -1 }); // Per-user analytics
QueryExecutionSchema.index({ apiKeyId: 1, executedAt: -1 }, { sparse: true }); // API key usage
QueryExecutionSchema.index({ workspaceId: 1, status: 1 }); // Error rate monitoring
QueryExecutionSchema.index(
  { workspaceId: 1, consoleId: 1, executedAt: -1 },
  { sparse: true, name: "query_executions_workspace_console_executed" },
); // Per-console recent runs
QueryExecutionSchema.index({ executedAt: 1 }, { expireAfterSeconds: 7776000 }); // TTL: 90 days

export const QueryExecution = mongoose.model<IQueryExecution>(
  "QueryExecution",
  QueryExecutionSchema,
);

export interface IScheduledQueryRun extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  consoleId: Types.ObjectId;
  triggeredAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  status: "queued" | "running" | "success" | "error";
  triggerType: "schedule" | "manual";
  triggeredBy?: string;
  durationMs?: number;
  rowsAffected?: number;
  rowCount?: number;
  error?: {
    message: string;
    code?: string;
  };
  inngestRunId?: string;
}

const ScheduledQueryRunSchema = new Schema<IScheduledQueryRun>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    consoleId: {
      type: Schema.Types.ObjectId,
      ref: "SavedConsole",
      required: true,
    },
    triggeredAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    startedAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
    status: {
      type: String,
      enum: ["queued", "running", "success", "error"],
      required: true,
    },
    triggerType: {
      type: String,
      enum: ["schedule", "manual"],
      required: true,
    },
    triggeredBy: {
      type: String,
      ref: "User",
    },
    durationMs: {
      type: Number,
    },
    rowsAffected: {
      type: Number,
    },
    rowCount: {
      type: Number,
    },
    error: {
      message: {
        type: String,
      },
      code: {
        type: String,
      },
    },
    inngestRunId: {
      type: String,
    },
  },
  {
    collection: "scheduled_query_runs",
    timestamps: false,
  },
);

ScheduledQueryRunSchema.index({
  workspaceId: 1,
  consoleId: 1,
  triggeredAt: -1,
});
ScheduledQueryRunSchema.index(
  { completedAt: 1 },
  { sparse: true, expireAfterSeconds: 7776000 },
);

export const ScheduledQueryRun = mongoose.model<IScheduledQueryRun>(
  "ScheduledQueryRun",
  ScheduledQueryRunSchema,
);
