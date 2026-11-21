/**
 * Flow store types: the persisted-state zod schemas (validated on rehydrate)
 * and the API payload shapes the actions return.
 */
import { z } from "zod";
import type { ScheduledQueryListItem } from "../../lib/api-types";
import { errorSchema } from "../store-validation";

// Zod schemas for validation
const flowDataSourceSchema = z.object({
  _id: z.string(),
  name: z.string(),
  type: z.string(),
});

const flowDestinationSchema = z.object({
  _id: z.string(),
  name: z.string(),
  type: z.string(),
});

// Allow schedule to be absent or partial (webhook flows have no schedule)
const flowScheduleSchema = z
  .object({
    enabled: z.boolean().optional(),
    cron: z.string().optional(),
    timezone: z.string().optional(),
  })
  .partial()
  .optional();

const webhookConfigSchema = z
  .object({
    endpoint: z.string().optional(),
    secret: z.string().optional(),
    enabled: z.boolean().optional(),
    lastReceivedAt: z.string().nullable().optional(),
    totalReceived: z.number().optional(),
    batchConfig: z
      .object({
        maxSize: z.number(),
        maxWaitMs: z.number(),
      })
      .optional(),
  })
  .optional();

// Query schema for GraphQL/PostHog flows
// Use coerce for numeric fields since they may come as strings from API
const flowQuerySchema = z.object({
  name: z.string(),
  query: z.string(),
  variables: z.record(z.string(), z.any()).optional(),
  dataPath: z.string().optional(),
  data_path: z.string().optional(),
  hasNextPagePath: z.string().optional(),
  has_next_page_path: z.string().optional(),
  cursorPath: z.string().optional(),
  cursor_path: z.string().optional(),
  totalCountPath: z.string().optional(),
  total_count_path: z.string().optional(),
  batchSize: z.coerce.number().optional(),
  batch_size: z.coerce.number().optional(),
});

export type FlowQuery = z.infer<typeof flowQuerySchema>;

const flowSchema = z.object({
  _id: z.string(),
  workspaceId: z.string(),
  /** Editable display name; absent on rows predating RFC #904's backfill. */
  name: z.string().nullable().optional(),
  /** Filename identity for `flows/<slug>.yml`. Never changes on rename. */
  slug: z.string().nullable().optional(),
  dataSourceId: flowDataSourceSchema.optional(), // Optional for database-to-database flows
  destinationDatabaseId: flowDestinationSchema.optional(), // Optional for database-to-database flows
  destinationDatabaseName: z.string().nullable().optional(),
  /** Retired: display label only (never decides anything); triggers do. */
  type: z.enum(["scheduled", "webhook"]).optional(),
  schedule: flowScheduleSchema,
  webhookConfig: webhookConfigSchema,
  entityFilter: z.array(z.string()).nullable().optional(),
  queries: z.array(flowQuerySchema).nullable().optional(),
  syncMode: z.enum(["full", "incremental"]),
  writeMode: z.enum(["append_dedup", "append", "overwrite"]).optional(),
  syncEngine: z.enum(["legacy", "cdc"]).optional(),
  backfillSchedule: z
    .object({
      enabled: z.boolean().optional(),
      cron: z.string().nullable().optional(),
      timezone: z.string().nullable().optional(),
      lastRunAt: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  syncState: z
    .enum(["idle", "backfill", "catchup", "live", "paused", "degraded"])
    .optional(),
  syncStateUpdatedAt: z.string().nullable().optional(),
  syncStateMeta: z
    .object({
      lastEvent: z.string().optional(),
      lastReason: z.string().optional(),
      lastErrorCode: z.string().optional(),
      lastErrorMessage: z.string().optional(),
    })
    .optional(),
  lastRunAt: z.string().nullable().optional(),
  lastSuccessAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  nextRunAt: z.string().nullable().optional(),
  runCount: z.number(),
  avgDurationMs: z.number().nullable().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * Set when `flows/<slug>.yml` at main does not parse or apply. The rest
   * of the item is the last valid version (or a stub for a git-only file).
   */
  definitionInvalid: z
    .object({
      reason: z.string(),
      at: z.string().optional(),
      path: z.string().optional(),
    })
    .nullable()
    .optional(),
  // Database-to-database sync fields
  sourceType: z.enum(["connector", "database"]).optional(),
  databaseSource: z
    .object({
      connectionId: z.string(),
      database: z.string().optional(),
      query: z.string(),
    })
    .optional(),
  tableDestination: z
    .object({
      connectionId: z.string(),
      database: z.string().optional(),
      schema: z.string().optional(),
      // Connector flows write one table per entity under `schema`; only
      // database-source flows name a single table.
      tableName: z.string().optional(),
      createIfNotExists: z.boolean().optional(),
      partitioning: z
        .object({
          enabled: z.boolean().optional(),
          type: z.enum(["time", "ingestion"]).optional(),
          field: z.string().optional(),
          granularity: z.enum(["day", "hour", "month", "year"]).optional(),
          requirePartitionFilter: z.boolean().optional(),
        })
        .optional(),
      clustering: z
        .object({
          enabled: z.boolean().optional(),
          fields: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  deleteMode: z.enum(["hard", "soft"]).optional(),
  entityLayouts: z
    .array(
      z.object({
        entity: z.string(),
        label: z.string().optional(),
        partitionField: z.string(),
        partitionGranularity: z.enum(["day", "hour", "month", "year"]),
        clusterFields: z.array(z.string()),
        enabled: z.boolean().optional(),
      }),
    )
    .optional(),
  incrementalConfig: z
    .object({
      trackingColumn: z.string(),
      trackingType: z.enum(["numeric", "timestamp"]),
      lastValue: z.string().nullable().optional(),
    })
    .optional(),
  conflictConfig: z
    .object({
      keyColumns: z.array(z.string()),
      strategy: z.enum(["update", "ignore", "replace", "upsert"]),
    })
    .optional(),
  paginationConfig: z
    .object({
      mode: z.enum(["offset", "keyset"]),
      keysetColumn: z.string().optional(),
      keysetDirection: z.enum(["asc", "desc"]).optional(),
      lastKeysetValue: z.string().nullable().optional(),
    })
    .optional(),
  typeCoercions: z
    .array(
      z.object({
        column: z.string(),
        sourceType: z.string().optional(),
        targetType: z.string(),
        format: z.string().optional(),
        nullValue: z.unknown().optional(),
        transformer: z.string().optional(),
      }),
    )
    .optional(),
  batchSize: z.coerce.number().optional(),
});

export type Flow = z.infer<typeof flowSchema>;

const flowExecutionHistorySchema = z.object({
  executionId: z.string(),
  executedAt: z.string(),
  startedAt: z.string().optional(),
  lastHeartbeat: z.string().optional(),
  completedAt: z.string().optional(),
  status: z.enum(["running", "completed", "failed", "cancelled", "abandoned"]),
  success: z.boolean(),
  error: z
    .object({
      message: z.string(),
      stack: z.string().optional(),
      code: z.string().optional(),
    })
    .nullable()
    .optional(),
  duration: z.number().nullable().optional(),
  system: z
    .object({
      workerId: z.string(),
      workerVersion: z.string().optional(),
      nodeVersion: z.string(),
      hostname: z.string(),
    })
    .optional(),
  context: z
    .object({
      dataSourceId: z.string(),
      destinationDatabaseId: z.string().optional(),
      destinationDatabaseName: z.string().optional(),
      syncMode: z.string(),
      entityFilter: z.array(z.string()).optional(),
    })
    .optional(),
  stats: z.unknown().optional(),
  logs: z
    .array(
      z.object({
        timestamp: z.string(),
        level: z.string(),
        message: z.string(),
        metadata: z.unknown().optional(),
      }),
    )
    .optional(),
});

export type FlowExecutionHistory = z.infer<typeof flowExecutionHistorySchema>;

export interface ConnectorInfo {
  _id: string;
  name: string;
  type: string;
  workspaceId?: string;
}

export interface WebhookEvent {
  id: string;
  eventId: string;
  eventType: string;
  receivedAt: string;
  processedAt?: string;
  status: "pending" | "processing" | "completed" | "failed";
  applyStatus?: "pending" | "applied" | "failed" | "dropped";
  attempts: number;
  error?: unknown;
  processingDurationMs?: number;
}

export interface ProvisionedWebhook {
  endpoint: string;
  webhookSecret: string | null;
  providerWebhookId: string;
  connectorType: string;
}

export interface FlowStatusResponse {
  isRunning: boolean;
  runningExecution: {
    executionId: string;
    startedAt: string;
    lastHeartbeat: string;
  } | null;
}

export interface CdcStatus {
  /** @deprecated Use streamState + backfillStatus */
  syncState?: string;
  streamState: "idle" | "active" | "paused" | "error";
  backfillStatus: "idle" | "running" | "paused" | "completed" | "error";
  consecutiveFailures: number;
  lastError: {
    message: string | null;
    code: string | null;
    reason: string | null;
    event: string | null;
  } | null;
  backlogCount: number;
  webhookPendingCount: number;
  lagSeconds: number | null;
  lastMaterializedAt: string | null;
  entities: Array<{
    entity: string;
    lastIngestSeq: number;
    lastMaterializedSeq: number;
    backlogCount: number;
    lagSeconds: number | null;
    lastMaterializedAt: string | null;
    destinationRowCount?: number | null;
    lifetimeEventsProcessed?: number;
    lifetimeRowsApplied?: number;
    backfillDone?: boolean;
    repartition?: {
      status: "pending" | "running" | "done" | "failed";
      error: string | null;
    } | null;
  }>;
  pipeline: {
    cdcEventsByStatus: {
      pending: number;
      applied: number;
      failed: number;
      dropped: number;
    };
    cdcEventsBySource: {
      webhook: number;
      backfill: number;
    };
    materializationBacklog: number;
    lagSeconds: number | null;
  };
  transitions: Array<{
    machine?: string;
    fromState: string;
    event: string;
    toState: string;
    at: string;
    reason?: string;
  }>;
}

export type CdcSummary = CdcStatus;
export type CdcDiagnostics = CdcStatus;

// Query validation result
export interface QueryValidationResult {
  success: boolean;
  columns?: Array<{ name: string; type: string }>;
  sampleRow?: Record<string, unknown>;
  connectionName?: string;
  connectionType?: string;
  safetyCheck?: {
    safe: boolean;
    warnings: string[];
    errors: string[];
    suggestedFixes?: string[];
  };
  error?: string;
}

export interface ExecutionDetails {
  executionId: string;
  executedAt: string;
  startedAt?: string;
  lastHeartbeat?: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "abandoned";
  success: boolean;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  duration?: number;
  system?: {
    workerId: string;
    workerVersion?: string;
    nodeVersion: string;
    hostname: string;
  };
  context?: {
    dataSourceId: string;
    destinationDatabaseId?: string;
    destinationDatabaseName?: string;
    syncMode: string;
    entityFilter?: string[];
  };
  logs?: Array<{
    timestamp: string;
    level: string;
    message: string;
    metadata?: unknown;
  }>;
  stats?: {
    recordsProcessed?: number | null;
    entityStats?: Record<string, unknown>;
    entityStatus?: Record<string, unknown>;
    plannedEntities?: string[];
    completedEntities?: string[];
    failedEntities?: string[];
    [key: string]: unknown;
  };
}

// Store state schema for validation
export const flowStoreStateSchema = z.object({
  flows: z.record(z.string(), z.array(flowSchema)),
  loading: z.record(z.string(), z.boolean()).optional().default({}),
  error: z.record(z.string(), errorSchema.nullable()).optional().default({}),
  selectedFlowId: z.string().nullable(),
  executionHistory: z.record(z.string(), z.array(flowExecutionHistorySchema)),
});

export type FlowStoreState = z.infer<typeof flowStoreStateSchema>;

/** Flow list + lifecycle (owns the persisted state). */
export interface FlowListActions {
  fetchFlows: (workspaceId: string) => Promise<Flow[]>;
  refresh: (workspaceId: string) => Promise<Flow[]>;
  init: (workspaceId: string) => Promise<void>;
  createFlow: (workspaceId: string, data: Partial<Flow>) => Promise<Flow>;
  updateFlow: (
    workspaceId: string,
    flowId: string,
    data: Partial<Flow>,
  ) => Promise<void>;
  deleteFlow: (workspaceId: string, flowId: string) => Promise<void>;
  toggleFlow: (workspaceId: string, flowId: string) => Promise<void>;
  runFlow: (workspaceId: string, flowId: string) => Promise<void>;
  backfillFlow: (workspaceId: string, flowId: string) => Promise<void>;
  fetchFlowHistory: (
    workspaceId: string,
    flowId: string,
    limit?: number,
  ) => Promise<FlowExecutionHistory[]>;
  selectFlow: (flowId: string | null) => void;
  clearError: (workspaceId: string) => void;
  fetchFlowDetails: (
    workspaceId: string,
    flowId: string,
  ) => Promise<Flow | null>;
  reset: () => void;
}

/** CDC (change-data-capture) sync controls and diagnostics. */
export interface FlowCdcActions {
  setSyncEngine: (
    workspaceId: string,
    flowId: string,
    syncEngine: "legacy" | "cdc",
  ) => Promise<boolean>;
  startCdcBackfill: (
    workspaceId: string,
    flowId: string,
    entities?: string[],
  ) => Promise<boolean>;
  resetCdcEntityColumn: (
    workspaceId: string,
    flowId: string,
    params: {
      entity: string;
      column: string;
      forceReplay?: boolean;
      startBackfill?: boolean;
    },
  ) => Promise<boolean>;
  resetCdcEntityTable: (
    workspaceId: string,
    flowId: string,
    entity: string,
  ) => Promise<boolean>;
  startCdcStream: (workspaceId: string, flowId: string) => Promise<boolean>;
  pauseCdcStream: (workspaceId: string, flowId: string) => Promise<boolean>;
  pauseCdcFlow: (workspaceId: string, flowId: string) => Promise<boolean>;
  cancelCdcBackfill: (workspaceId: string, flowId: string) => Promise<boolean>;
  resumeCdcFlow: (workspaceId: string, flowId: string) => Promise<boolean>;
  resyncCdcFlow: (
    workspaceId: string,
    flowId: string,
    options?: {
      deleteDestination?: boolean;
      clearWebhookEvents?: boolean;
      /** Restrict the resync to these entities (recreate only their tables). */
      entities?: string[];
    },
  ) => Promise<boolean>;
  recoverCdcFlow: (
    workspaceId: string,
    flowId: string,
    options?: {
      retryFailedMaterialization?: boolean;
      resumeBackfill?: boolean;
      entity?: string;
    },
  ) => Promise<boolean>;
  recoverCdcStream: (
    workspaceId: string,
    flowId: string,
    options?: {
      retryFailedMaterialization?: boolean;
      entity?: string;
    },
  ) => Promise<boolean>;
  recoverCdcBackfill: (workspaceId: string, flowId: string) => Promise<boolean>;
  reprocessStaleEvents: (
    workspaceId: string,
    flowId: string,
  ) => Promise<boolean>;
  retryFailedCdcMaterialization: (
    workspaceId: string,
    flowId: string,
    entity?: string,
  ) => Promise<boolean>;
  fetchCdcStatus: (
    workspaceId: string,
    flowId: string,
  ) => Promise<CdcStatus | null>;
  fetchCdcDestinationCounts: (
    workspaceId: string,
    flowId: string,
  ) => Promise<Record<string, number | null> | null>;
  fetchEntitySchema: (
    workspaceId: string,
    flowId: string,
    entity: string,
  ) => Promise<{
    entity: string;
    fields: Record<
      string,
      { type: string; nullable?: boolean; required?: boolean }
    >;
  } | null>;
  fetchEntitySchemaHealth: (
    workspaceId: string,
    flowId: string,
    entity?: string,
  ) => Promise<{
    entities: Array<{
      entity: string;
      columns: Array<{
        column: string;
        liveType: string;
        expectedType: string;
        status: "match" | "drift";
      }>;
      hasDrift: boolean;
    }>;
    hasDrift: boolean;
  } | null>;
}

/** Webhooks, run status/logs, connectors, query validation. */
export interface FlowMonitorActions {
  fetchConnectors: (workspaceId: string) => Promise<ConnectorInfo[]>;
  fetchWebhookEvents: (
    workspaceId: string,
    flowId: string,
    limit: number,
    offset: number,
    filters?: { status?: string; applyStatus?: string },
  ) => Promise<{ total: number; events: WebhookEvent[] } | null>;
  fetchWebhookEventDetails: (
    workspaceId: string,
    flowId: string,
    eventId: string,
  ) => Promise<unknown | null>;
  retryAllFailedWebhookEvents: (
    workspaceId: string,
    flowId: string,
  ) => Promise<{ retried: number; total: number } | null>;
  retryWebhookEvent: (
    workspaceId: string,
    flowId: string,
    eventId: string,
  ) => Promise<boolean>;
  provisionFlowWebhook: (
    workspaceId: string,
    flowId: string,
    options?: {
      verifySsl?: boolean;
      events?: string[];
      publicBaseUrl?: string;
    },
  ) => Promise<ProvisionedWebhook | null>;
  fetchFlowStatus: (
    workspaceId: string,
    flowId: string,
  ) => Promise<FlowStatusResponse | null>;
  fetchExecutionDetails: (
    workspaceId: string,
    flowId: string,
    executionId: string,
  ) => Promise<ExecutionDetails | null>;
  cancelFlowExecution: (
    workspaceId: string,
    flowId: string,
    executionId?: string | null,
  ) => Promise<boolean>;
  validateDbQuery: (
    workspaceId: string,
    connectionId: string,
    query: string,
    database?: string,
  ) => Promise<QueryValidationResult>;
  /** Scheduled console queries, listed alongside flows in the explorer
   * (throws on failure). */
  fetchScheduledQueries: (
    workspaceId: string,
  ) => Promise<ScheduledQueryListItem[]>;
}

export type FlowStore = FlowStoreState &
  FlowListActions &
  FlowCdcActions &
  FlowMonitorActions;
