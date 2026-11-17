import mongoose, { Schema, Document, Types } from "mongoose";
import {
  FLOW_EXECUTION_TTL_INDEX_NAME,
  FLOW_EXECUTION_TTL_KEY,
  FLOW_EXECUTION_TTL_PARTIAL_FILTER,
  flowExecutionRetentionSeconds,
} from "../flow-execution-retention";

/**
 * Query configuration for GraphQL/PostHog flows
 */
export interface IFlowQuery {
  name: string;
  query: string;
  variables?: Record<string, unknown>;
  dataPath?: string;
  data_path?: string;
  hasNextPagePath?: string;
  has_next_page_path?: string;
  cursorPath?: string;
  cursor_path?: string;
  totalCountPath?: string;
  total_count_path?: string;
  batchSize?: number;
  batch_size?: number;
}

/**
 * Database source configuration for db-to-db flows
 */
export interface IDatabaseSource {
  connectionId: Types.ObjectId;
  database?: string; // Database name within the connection
  query: string; // SQL query to fetch data
}

/**
 * BigQuery partitioning configuration for table destination
 */
export interface ITablePartitioning {
  enabled: boolean;
  type?: "time" | "ingestion";
  field?: string;
  granularity?: "day" | "hour" | "month" | "year";
  requirePartitionFilter?: boolean;
}

/**
 * BigQuery clustering configuration for table destination
 */
export interface ITableClustering {
  enabled: boolean;
  fields?: string[];
}

/**
 * Per-entity table layout config for connector -> BigQuery flows
 */
export interface IEntityLayout {
  entity: string;
  label?: string;
  partitionField: string;
  partitionGranularity: "day" | "hour" | "month" | "year";
  clusterFields: string[];
  enabled?: boolean;
}

/**
 * Table destination configuration for writing to SQL tables
 */
export interface ITableDestination {
  connectionId: Types.ObjectId;
  database?: string;
  schema?: string;
  tableName: string;
  createIfNotExists?: boolean;
  partitioning?: ITablePartitioning;
  clustering?: ITableClustering;
}

/**
 * Incremental sync configuration
 */
export interface IIncrementalConfig {
  trackingColumn: string; // e.g., 'updated_at' or 'id'
  trackingType: "timestamp" | "numeric";
  lastValue?: string; // Last synced value (stored as string for flexibility)
}

/**
 * Conflict resolution configuration for upserts
 */
export interface IConflictConfig {
  keyColumns: string[]; // Columns that form the unique key
  strategy: "update" | "ignore" | "replace" | "upsert";
}

/**
 * Pagination configuration for database syncs
 */
export interface IPaginationConfig {
  mode: "offset" | "keyset"; // offset uses LIMIT/OFFSET, keyset uses WHERE col > last_value
  keysetColumn?: string; // Column for keyset pagination (e.g., 'id', 'created_at')
  keysetDirection?: "asc" | "desc"; // Sort direction (must match ORDER BY in query)
  lastKeysetValue?: string; // Last processed keyset value for resumption
}

/**
 * Type coercion configuration for column mapping between databases
 */
export interface ITypeCoercion {
  column: string; // Column name
  sourceType?: string; // Original type (informational)
  targetType: string; // Target type to coerce to
  format?: string; // Optional format string (e.g., for dates: 'YYYY-MM-DD')
  nullValue?: unknown; // Value to use when source is null
  transformer?: string; // Optional transformation: 'lowercase' | 'uppercase' | 'trim' | 'json_parse' | 'json_stringify'
}

export type SyncEngine = "legacy" | "cdc";

/** @deprecated Use StreamState + BackfillStatus instead */
export type SyncState =
  "idle" | "backfill" | "catchup" | "live" | "paused" | "degraded";

export type StreamState = "idle" | "active" | "paused" | "error";
export type BackfillStatus =
  "idle" | "running" | "paused" | "completed" | "error";

export interface ISyncStateMeta {
  lastEvent?: string;
  lastReason?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
}

/** An owner/admin's approval for a flow to run a folder twin. */
export interface IBoxedApproval {
  by: string;
  at: Date;
  /** `shadow`: this shadow may run boxed. `switch`: this live flow may. */
  kind: "shadow" | "switch";
  /** The twin's folder slug. */
  slug: string;
  /** Bound to: the connection, the destination tables, the live flow. */
  connectionId: string;
  destination: string;
  shadowOf?: string;
  /**
   * The code approved: the folder's source hash. A registry connector
   * whose registry slug is the connection's type needs no pin (Mako-built).
   */
  sourceSha?: string;
  registryHash?: string;
}

/**
 * Flow model interface (data sync flow configuration)
 */
export interface IFlow extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  /**
   * Retired: what drives a flow is its trigger set (services/flow-triggers).
   * Documents written before carry it; new code never writes it.
   */
  type?: "scheduled" | "webhook";

  /**
   * Editable display name. Absent on rows created before names existed —
   * `flowDisplayName()` falls back to the source → destination derivation.
   */
  name?: string;
  /**
   * Filename identity for `flows/<slug>.yml` (RFC #904): minted once from
   * the name, unique per workspace, NEVER changed by a rename. Absent until
   * the backfill stamps pre-existing rows.
   */
  slug?: string;
  /**
   * Blob sha of the definition last mirrored to `flows/<slug>.yml`, so an
   * unchanged definition makes no commit. Runtime bookkeeping, never in the
   * file itself. Derived cache — git is the store.
   */
  sourceBlobSha?: string;
  /**
   * Set when `flows/<slug>.yml` at main does not parse or cannot be applied.
   * Runtime must not run this definition and must never write the row back
   * over the file.
   */
  definitionInvalid?: {
    reason: string;
    at: Date;
    path?: string;
  };

  // Source configuration — either a source connection or a database connection
  sourceType: "connector" | "database";
  /**
   * Id of the source connection this flow reads from (when `sourceType` is
   * `"connector"`). Persisted field name is historical — do not rename in
   * Mongo. TypeScript callers should treat this as a SourceConnection id.
   */
  dataSourceId?: Types.ObjectId;
  databaseSource?: IDatabaseSource; // For database-query sources

  // Destination configuration
  destinationDatabaseId: Types.ObjectId;
  destinationDatabaseName?: string;
  tableDestination?: ITableDestination; // For writing to SQL tables instead of MongoDB collections

  schedule?: {
    enabled: boolean;
    cron?: string;
    timezone?: string;
  };
  /**
   * Optional periodic full backfill cadence for CDC flows. Independent of
   * `schedule` (which only drives `type: scheduled` batch runs). When enabled,
   * `cdcScheduledBackfillFunction` triggers `cdcBackfillService.startBackfill`
   * on the cron cadence so a streaming CDC flow gets a periodic full
   * reconciliation while the live stream stays active between runs.
   */
  backfillSchedule?: {
    enabled: boolean;
    cron?: string;
    timezone?: string;
    /** Scope each scheduled backfill to these entities; empty = all. */
    entities?: string[];
    lastRunAt?: Date;
  };
  webhookConfig?: {
    endpoint: string;
    secret: string;
    /**
     * Provider-side id of the subscription that POSTs to `endpoint` (Stripe
     * `we_…`), stored at provisioning so later entity changes update that
     * subscription in place instead of creating a duplicate. Authoritative in
     * `flows/<slug>.yml` (`webhook.provider_webhook_id`); mirrored here.
     */
    providerWebhookId?: string;
    lastReceivedAt?: Date;
    /**
     * Why the provider refused the last automatic provisioning (on save).
     * Cleared on success. Polling carries on regardless.
     */
    provisionError?: { message: string; at: Date } | null;
    totalReceived: number;
    enabled: boolean;
    /**
     * Boxed connectors only: events per webhook batch. Halved after a batch
     * fails in its box, doubled back after one succeeds, so one bad event
     * is isolated without failing its neighbours (webhook-batch.ts).
     */
    boxBatchSize?: number;
  };
  entityFilter?: string[]; // Optional: specific entities to sync (for connector sources)
  /**
   * Which code reads a built-in connection for this flow (RFC
   * connector-runtime §10, iteration 5). `builtin` (absent) runs the
   * in-process connector. `boxed` runs the workspace's folder twin
   * (`ws:<boxedConnector ?? connection type>`) in a box with the SAME
   * connection's credential. Honoured only with CONNECTOR_BOXED_SWITCH on
   * (connectors/boxed-runtime). Definition: in `flows/<slug>.yml`.
   */
  connectorRuntime?: "builtin" | "boxed";
  /** The folder slug a boxed run uses; absent = the connection's type. */
  boxedConnector?: string;
  /**
   * Set on a shadow flow: the live flow it mirrors. A shadow reads the live
   * flow's connection through its folder twin and writes to its own
   * dataset; it never writes the live one (assertShadowIsolated).
   */
  shadowOf?: Types.ObjectId;
  /**
   * Who allowed this flow's connection to be read by a folder twin, and
   * exactly what they allowed. Set only by an owner/admin action
   * (flow_update runtime, flow_shadow start), never from
   * `flows/<slug>.yml`, and cleared by applyDefinition when the file moves
   * anything it is bound to. A boxed run needs every field to still hold
   * (connectors/boxed-runtime/runtime.ts `boxedTwinFor`, `assertTwinPinned`).
   * Runtime bookkeeping, not in the file.
   */
  boxedApproval?: IBoxedApproval;
  /**
   * Set on a promoted twin: the built-in flow it replaced at a switch. It
   * writes that flow's dataset and takes its webhook deliveries (forwarded
   * from that flow's URL). Definition: `replaces:` in the file.
   */
  replaces?: Types.ObjectId;
  /**
   * Set on a built-in flow paused by a switch: the twin flow that replaced
   * it, and the triggers to restore on a switch back (their crons kept
   * here, since a paused flow's file says "off"). Mongo-only bookkeeping,
   * set and cleared by an owner/admin's switch, never by a file.
   */
  boxedSwitch?: {
    to: Types.ObjectId;
    by: string;
    at: Date;
    poll?: { enabled: boolean; cron?: string; timezone?: string };
    resync?: {
      enabled: boolean;
      cron?: string;
      timezone?: string;
      entities?: string[];
    };
    webhook: boolean;
  };
  queries?: IFlowQuery[]; // Queries for GraphQL/PostHog connectors
  syncMode: "full" | "incremental";
  /**
   * Destination write mode (Airbyte-style sync modes; the read mode is
   * `syncMode`):
   * - "append_dedup" (default): upsert by key — the destination holds one
   *   deduplicated row per record.
   * - "append": insert-only — every fetched record version becomes a new row
   *   (re-syncs duplicate, by design).
   * - "overwrite": full-refresh only — the destination is cleared at the
   *   start of each run, ending up as an exact snapshot.
   */
  writeMode?: "append_dedup" | "append" | "overwrite";
  syncEngine: SyncEngine;
  /** @deprecated Use streamState + backfillState.status instead */
  syncState?: SyncState;
  syncStateUpdatedAt?: Date;
  syncStateMeta?: ISyncStateMeta;
  streamState?: StreamState;
  deleteMode?: "hard" | "soft";
  entityLayouts?: IEntityLayout[];

  // Incremental and conflict config (for database sources)
  incrementalConfig?: IIncrementalConfig;
  conflictConfig?: IConflictConfig;
  paginationConfig?: IPaginationConfig;
  typeCoercions?: ITypeCoercion[];
  batchSize?: number;
  backfillState?: {
    status?: BackfillStatus;
    runId?: string;
    startedAt?: Date;
    completedAt?: Date;
    consecutiveFailures?: number;
    scope?: {
      mode: "all" | "subset";
      entities?: string[];
    };
    /**
     * What started this run. Only "scheduled" runs (backfillSchedule) may
     * fetch incrementally — see sync-cdc/backfill-fetch-mode.ts. Absent on
     * runs started before this field existed: treated as manual (full).
     */
    trigger?: "scheduled" | "manual";
  };

  lastRunAt?: Date;
  /**
   * When the poll scheduler last dispatched this flow (its atomic claim).
   * A dispatched run can sit queued behind `concurrency: 1` before it
   * stamps `lastRunAt`; due-ness counts from the later of the two so the
   * next tick does not dispatch it again. Runtime state, never in YAML.
   */
  lastScheduledDispatchAt?: Date;
  lastSuccessAt?: Date;
  lastError?: string;
  nextRunAt?: Date;
  runCount: number;
  avgDurationMs?: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Flow Schema (data sync flow configuration)
 */
const FlowSchema = new Schema<IFlow>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    // Retired (see IFlow.type): kept so older documents still load.
    type: {
      type: String,
      enum: ["scheduled", "webhook"],
      required: false,
    },
    // Display name (editable) and slug (minted once; the `flows/<slug>.yml`
    // filename identity — see RFC #904). Both optional: rows predating names
    // fall back to the source → destination derivation until the backfill.
    name: {
      type: String,
      trim: true,
      maxlength: 200,
    },
    slug: {
      type: String,
      trim: true,
      match: /^[a-z0-9][a-z0-9-]*$/,
    },
    // Change detection for the git write-through (RFC #904).
    sourceBlobSha: {
      type: String,
    },
    definitionInvalid: {
      reason: { type: String },
      at: { type: Date },
      path: { type: String },
    },
    // Source type discriminator - defaults to "connector" for backward compatibility
    sourceType: {
      type: String,
      enum: ["connector", "database"],
      default: "connector",
    },
    // For connector sources (Stripe, Close, GraphQL, etc.)
    dataSourceId: {
      type: Schema.Types.ObjectId,
      ref: "Connector",
      required: function () {
        return (this as IFlow).sourceType !== "database";
      },
    },
    // For database sources (SQL queries)
    databaseSource: {
      connectionId: {
        type: Schema.Types.ObjectId,
        ref: "DatabaseConnection",
      },
      database: String,
      query: String,
    },
    destinationDatabaseId: {
      type: Schema.Types.ObjectId,
      ref: "DatabaseConnection",
      required: true,
    },
    destinationDatabaseName: {
      type: String,
      required: false,
    },
    // For writing to SQL tables instead of MongoDB collections
    tableDestination: {
      connectionId: {
        type: Schema.Types.ObjectId,
        ref: "DatabaseConnection",
      },
      database: String,
      schema: String,
      tableName: String,
      createIfNotExists: {
        type: Boolean,
        default: true,
      },
      partitioning: {
        enabled: { type: Boolean, default: false },
        type: { type: String, enum: ["time", "ingestion"] },
        field: String,
        granularity: { type: String, enum: ["day", "hour", "month", "year"] },
        requirePartitionFilter: { type: Boolean, default: false },
      },
      clustering: {
        enabled: { type: Boolean, default: false },
        fields: [String],
      },
    },
    schedule: {
      enabled: {
        type: Boolean,
        default: true,
      },
      cron: {
        type: String,
        // A flow with webhooks carries the default `schedule.enabled: true`
        // with no cron (it may have no poll schedule at all); any other flow
        // whose schedule is on needs its cron. An older document's retired
        // `type: "webhook"` counts as webhooks, so it saves as it always did.
        // The route boundary enforces the same (routes/flows.ts), and a poll
        // trigger only exists when a cron is set (flow-triggers.service.ts).
        required: function () {
          return Boolean(
            this.schedule?.enabled &&
            !this.webhookConfig?.endpoint &&
            this.type !== "webhook",
          );
        },
        validate: {
          validator: function (v: string) {
            // Absence is handled by `required`; any present cron must be
            // well-formed regardless of flow type.
            if (!v) return true;
            // Basic cron validation - 5 or 6 fields
            const fields = v.split(" ");
            return fields.length === 5 || fields.length === 6;
          },
          message: "Invalid cron expression",
        },
      },
      timezone: {
        type: String,
        default: "UTC",
      },
    },
    backfillSchedule: {
      enabled: {
        type: Boolean,
        default: false,
      },
      cron: {
        type: String,
        validate: {
          validator: function (v: string) {
            if (!v) return true;
            const fields = v.split(" ");
            return fields.length === 5 || fields.length === 6;
          },
          message: "Invalid cron expression",
        },
      },
      timezone: {
        type: String,
        default: "UTC",
      },
      entities: { type: [String], default: undefined },
      lastRunAt: Date,
    },
    webhookConfig: {
      endpoint: {
        type: String,
        unique: true,
        sparse: true,
      },
      secret: {
        type: String,
      },
      providerWebhookId: {
        type: String,
      },
      lastReceivedAt: Date,
      provisionError: {
        message: String,
        at: Date,
      },
      totalReceived: {
        type: Number,
        default: 0,
      },
      enabled: {
        type: Boolean,
        default: true,
      },
      boxBatchSize: Number,
    },
    entityFilter: [String],
    connectorRuntime: { type: String, enum: ["builtin", "boxed"] },
    boxedConnector: {
      type: String,
      trim: true,
      match: /^[a-z0-9][a-z0-9_-]*$/,
    },
    shadowOf: { type: Schema.Types.ObjectId, ref: "Flow" },
    replaces: { type: Schema.Types.ObjectId, ref: "Flow" },
    boxedSwitch: {
      type: new Schema(
        {
          to: { type: Schema.Types.ObjectId, ref: "Flow" },
          by: String,
          at: Date,
          poll: { enabled: Boolean, cron: String, timezone: String },
          resync: {
            enabled: Boolean,
            cron: String,
            timezone: String,
            entities: [String],
          },
          webhook: Boolean,
        },
        { _id: false },
      ),
      required: false,
    },
    boxedApproval: {
      type: new Schema(
        {
          by: String,
          at: Date,
          kind: { type: String, enum: ["shadow", "switch"] },
          slug: String,
          connectionId: String,
          destination: String,
          shadowOf: String,
          sourceSha: String,
          registryHash: String,
        },
        { _id: false },
      ),
      required: false,
    },
    queries: [
      {
        name: { type: String, required: true },
        query: { type: String, required: true },
        variables: { type: Schema.Types.Mixed },
        dataPath: String,
        data_path: String,
        hasNextPagePath: String,
        has_next_page_path: String,
        cursorPath: String,
        cursor_path: String,
        totalCountPath: String,
        total_count_path: String,
        batchSize: Number,
        batch_size: Number,
      },
    ],
    syncMode: {
      type: String,
      enum: ["full", "incremental"],
      default: "full",
    },
    writeMode: {
      type: String,
      enum: ["append_dedup", "append", "overwrite"],
      default: "append_dedup",
    },
    // CDC is the only engine for connector flows (the legacy engine has
    // been removed). "legacy" remains only as the label of database-source
    // flows, which have their own write path.
    syncEngine: {
      type: String,
      enum: ["legacy", "cdc"],
      default: "cdc",
      required: true,
    },
    syncState: {
      type: String,
      enum: ["idle", "backfill", "catchup", "live", "paused", "degraded"],
      default: "idle",
    },
    syncStateUpdatedAt: {
      type: Date,
      default: Date.now,
    },
    syncStateMeta: {
      lastEvent: String,
      lastReason: String,
      lastErrorCode: String,
      lastErrorMessage: String,
    },
    streamState: {
      type: String,
      enum: ["idle", "active", "paused", "error"],
      default: "idle",
    },
    deleteMode: {
      type: String,
      enum: ["hard", "soft"],
    },
    entityLayouts: [
      {
        entity: { type: String, required: true },
        label: String,
        partitionField: { type: String, required: true },
        partitionGranularity: {
          type: String,
          enum: ["day", "hour", "month", "year"],
          default: "day",
        },
        clusterFields: [String],
        enabled: { type: Boolean, default: true },
      },
    ],
    // Incremental config for database sources
    incrementalConfig: {
      trackingColumn: String,
      trackingType: {
        type: String,
        enum: ["timestamp", "numeric"],
      },
      lastValue: String,
    },
    // Conflict resolution for upserts
    conflictConfig: {
      keyColumns: [String],
      strategy: {
        type: String,
        enum: ["update", "ignore", "replace", "upsert"],
        default: "update",
      },
    },
    // Pagination mode for database syncs
    paginationConfig: {
      mode: {
        type: String,
        enum: ["offset", "keyset"],
        default: "offset",
      },
      keysetColumn: String,
      keysetDirection: {
        type: String,
        enum: ["asc", "desc"],
        default: "asc",
      },
      lastKeysetValue: String,
    },
    // Type coercion rules for column mapping
    typeCoercions: [
      {
        column: { type: String, required: true },
        sourceType: String,
        targetType: { type: String, required: true },
        format: String,
        nullValue: Schema.Types.Mixed,
        transformer: {
          type: String,
          enum: [
            "lowercase",
            "uppercase",
            "trim",
            "json_parse",
            "json_stringify",
          ],
        },
      },
    ],
    batchSize: {
      type: Number,
      default: 2000,
      min: 100,
      max: 50000,
    },
    backfillState: {
      status: {
        type: String,
        enum: ["idle", "running", "paused", "completed", "error"],
        default: "idle",
      },
      runId: String,
      startedAt: Date,
      completedAt: Date,
      consecutiveFailures: { type: Number, default: 0 },
      scope: {
        mode: {
          type: String,
          enum: ["all", "subset"],
          default: "all",
        },
        entities: [String],
      },
      trigger: { type: String, enum: ["scheduled", "manual"] },
    },
    lastRunAt: Date,
    lastScheduledDispatchAt: Date,
    lastSuccessAt: Date,
    lastError: String,
    nextRunAt: Date,
    runCount: {
      type: Number,
      default: 0,
    },
    avgDurationMs: Number,
    createdBy: {
      type: String,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
    collection: "flows",
  },
);

// Indexes
FlowSchema.index({ workspaceId: 1, "schedule.enabled": 1 });
// The poll scheduler's scan (buildScheduledFlowSelection) has no workspaceId.
FlowSchema.index({ "schedule.enabled": 1 });
// One file per slug per workspace. Sparse so rows awaiting the backfill
// (no slug yet) do not collide with each other on null.
FlowSchema.index({ workspaceId: 1, slug: 1 }, { unique: true, sparse: true });
FlowSchema.index({ workspaceId: 1, sourceType: 1 });
FlowSchema.index({ dataSourceId: 1 }, { sparse: true }); // Sparse since not required for database sources
FlowSchema.index({ "databaseSource.connectionId": 1 }, { sparse: true });
FlowSchema.index({ destinationDatabaseId: 1 });
FlowSchema.index({ "tableDestination.connectionId": 1 }, { sparse: true });
FlowSchema.index({ nextRunAt: 1 });
FlowSchema.index({ workspaceId: 1, syncEngine: 1 });
FlowSchema.index({ syncEngine: 1, "backfillSchedule.enabled": 1 });

export const Flow = mongoose.model<IFlow>("Flow", FlowSchema);

/**
 * FlowExecution model interface
 */
export interface IFlowExecution extends Document {
  _id: Types.ObjectId;
  flowId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  startedAt: Date;
  completedAt?: Date;
  lastHeartbeat?: Date;
  status: "running" | "completed" | "failed" | "cancelled" | "abandoned";
  success: boolean;
  duration?: number;
  logs: Array<{
    timestamp: Date;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    metadata?: unknown;
  }>;
  error?: {
    message: string;
    stack?: string;
    code?: string | number | null;
  } | null;
  context?: unknown;
  system?: unknown;
}

/**
 * FlowExecution Schema (binds to 'flow_executions' collection)
 */
const FlowExecutionSchema = new Schema<IFlowExecution>(
  {
    flowId: { type: Schema.Types.ObjectId, ref: "Flow", required: true },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    startedAt: { type: Date, required: true },
    completedAt: Date,
    lastHeartbeat: Date,
    status: {
      type: String,
      enum: ["running", "completed", "failed", "cancelled", "abandoned"],
      required: true,
    },
    success: { type: Boolean, required: true },
    duration: Number,
    logs: [
      {
        timestamp: { type: Date, required: true },
        level: {
          type: String,
          enum: ["debug", "info", "warn", "error"],
          required: true,
        },
        message: { type: String, required: true },
        metadata: Schema.Types.Mixed,
      },
    ],
    error: Schema.Types.Mixed,
    context: Schema.Types.Mixed,
    system: Schema.Types.Mixed,
  },
  {
    collection: "flow_executions",
    timestamps: false,
  },
);

// Indexes
FlowExecutionSchema.index({ flowId: 1, startedAt: -1 });
// cleanup-abandoned-flows scans `{ status: "running", lastHeartbeat < t }`
// every 5 minutes.
FlowExecutionSchema.index({ status: 1, lastHeartbeat: 1 });
// Run-history retention: finished runs expire FLOW_EXECUTION_RETENTION_DAYS
// (default 90) after completedAt; running ones never (partial on terminal
// statuses). See flow-execution-retention.ts.
FlowExecutionSchema.index(FLOW_EXECUTION_TTL_KEY, {
  name: FLOW_EXECUTION_TTL_INDEX_NAME,
  expireAfterSeconds: flowExecutionRetentionSeconds(),
  partialFilterExpression: FLOW_EXECUTION_TTL_PARTIAL_FILTER,
});

export const FlowExecution = mongoose.model<IFlowExecution>(
  "FlowExecution",
  FlowExecutionSchema,
);
