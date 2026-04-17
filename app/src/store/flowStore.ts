import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import { apiClient } from "../lib/api-client";
import { z } from "zod";
import { createValidatedStorage, errorSchema } from "./store-validation";

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
  dataSourceId: flowDataSourceSchema.optional(), // Optional for database-to-database flows
  destinationDatabaseId: flowDestinationSchema.optional(), // Optional for database-to-database flows
  destinationDatabaseName: z.string().nullable().optional(),
  type: z.enum(["scheduled", "webhook"]).optional(), // Remove default to detect missing type
  schedule: flowScheduleSchema,
  webhookConfig: webhookConfigSchema,
  entityFilter: z.array(z.string()).nullable().optional(),
  queries: z.array(flowQuerySchema).nullable().optional(),
  syncMode: z.enum(["full", "incremental"]),
  syncEngine: z.enum(["legacy", "cdc"]).optional(),
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
      tableName: z.string(),
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
  bulkConfig: z
    .object({
      mode: z.enum(["auto", "on", "off"]).optional(),
      slicing: z.enum(["auto", "off"]).optional(),
    })
    .optional(),
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

interface ConnectorInfo {
  _id: string;
  name: string;
  type: string;
  workspaceId?: string;
}

interface WebhookEvent {
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

interface WebhookStats {
  webhookUrl: string;
  lastReceived: string | null;
  totalReceived: number;
  eventsToday: number;
  deferredCount?: number;
  backfillActive?: boolean;
  cdc?: {
    enabled: boolean;
    mode: "steady" | "backfill";
    entities: number;
    backlogCount: number;
    lagSeconds: number | null;
  };
  successRate: number;
  recentEvents: WebhookEvent[];
}

interface ProvisionedWebhook {
  endpoint: string;
  webhookSecret: string | null;
  providerWebhookId: string;
  connectorType: string;
}

interface FlowStatusResponse {
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
interface QueryValidationResult {
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

interface ExecutionDetails {
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
    recordsProcessed?: number;
    entityStats?: Record<string, unknown>;
    entityStatus?: Record<string, unknown>;
    plannedEntities?: string[];
    completedEntities?: string[];
    failedEntities?: string[];
    [key: string]: unknown;
  };
}

// Store state schema for validation
const flowStoreStateSchema = z.object({
  flows: z.record(z.string(), z.array(flowSchema)),
  loading: z.record(z.string(), z.boolean()).optional().default({}),
  error: z.record(z.string(), errorSchema.nullable()).optional().default({}),
  selectedFlowId: z.string().nullable(),
  executionHistory: z.record(z.string(), z.array(flowExecutionHistorySchema)),
});

type FlowStoreState = z.infer<typeof flowStoreStateSchema>;

interface FlowStore extends FlowStoreState {
  // Actions
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
  fetchFlowHistory: (
    workspaceId: string,
    flowId: string,
    limit?: number,
  ) => Promise<FlowExecutionHistory[]>;
  selectFlow: (flowId: string | null) => void;
  clearError: (workspaceId: string) => void;

  // Connector listing for flows
  fetchConnectors: (workspaceId: string) => Promise<ConnectorInfo[]>;

  // Webhook flow monitoring
  fetchWebhookStats: (
    workspaceId: string,
    flowId: string,
  ) => Promise<WebhookStats | null>;
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

  // Flow logs and status
  fetchFlowDetails: (
    workspaceId: string,
    flowId: string,
  ) => Promise<Flow | null>;
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

  // Database query validation
  validateDbQuery: (
    workspaceId: string,
    connectionId: string,
    query: string,
    database?: string,
  ) => Promise<QueryValidationResult>;

  reset: () => void;
}

const initialState: FlowStoreState = {
  flows: {},
  loading: {},
  error: {},
  selectedFlowId: null,
  executionHistory: {},
};

// Helper to ensure error is always a string
const normalizeError = (error: any): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    if ("message" in error) return String(error.message);
    if ("error" in error) return String(error.error);
    return JSON.stringify(error);
  }
  return "Unknown error";
};

export const useFlowStore = create<FlowStore>()(
  persist(
    immer((set, get) => ({
      ...initialState,

      fetchFlows: async (workspaceId: string) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });

        try {
          const response = await apiClient.get<{
            success: boolean;
            data: Flow[];
            error?: string;
          }>(`/workspaces/${workspaceId}/flows`);

          if (response.success) {
            set(state => {
              state.flows[workspaceId] = response.data || [];
              state.error[workspaceId] = null;
            });
            return response.data || [];
          } else {
            throw new Error(response.error || "Failed to fetch flows");
          }
        } catch (error: any) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return [];
        } finally {
          set(state => {
            delete state.loading[workspaceId];
          });
        }
      },

      refresh: async (workspaceId: string) => {
        return await get().fetchFlows(workspaceId);
      },

      init: async (workspaceId: string) => {
        const existingFlows = get().flows[workspaceId];

        // If we have cached flows, check if any are missing the 'type' field
        // This indicates stale data from before webhooks were implemented
        if (existingFlows && existingFlows.length > 0) {
          const hasStaleData = existingFlows.some(
            flow => flow.type === undefined,
          );
          if (hasStaleData) {
            // Clear stale data from the store before refreshing
            set(state => {
              state.flows[workspaceId] = [];
            });
            // Now refresh from API
            await get().refresh(workspaceId);
            return;
          }
        }

        // If no data exists, fetch it
        if (!existingFlows || existingFlows.length === 0) {
          await get().refresh(workspaceId);
        }
      },

      createFlow: async (workspaceId: string, data: Partial<Flow>) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });

        try {
          const response = await apiClient.post<{
            success: boolean;
            data: Flow;
            error?: string;
          }>(`/workspaces/${workspaceId}/flows`, data);

          if (response.success) {
            const newFlow = response.data;
            set(state => {
              if (!state.flows[workspaceId]) {
                state.flows[workspaceId] = [];
              }
              state.flows[workspaceId].push(newFlow);
            });
            return newFlow;
          } else {
            throw new Error(response.error || "Failed to create flow");
          }
        } catch (error: any) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          throw error;
        } finally {
          set(state => {
            delete state.loading[workspaceId];
          });
        }
      },

      updateFlow: async (
        workspaceId: string,
        flowId: string,
        data: Partial<Flow>,
      ) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });

        try {
          const response = await apiClient.put<{
            success: boolean;
            data: Flow;
            error?: string;
          }>(`/workspaces/${workspaceId}/flows/${flowId}`, data);

          if (response.success) {
            set(state => {
              const flows = state.flows[workspaceId] || [];
              const index = flows.findIndex(flow => flow._id === flowId);
              if (index !== -1) {
                flows[index] = response.data;
              }
            });
          } else {
            throw new Error(response.error || "Failed to update flow");
          }
        } catch (error: any) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          throw error;
        } finally {
          set(state => {
            delete state.loading[workspaceId];
          });
        }
      },

      deleteFlow: async (workspaceId: string, flowId: string) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });

        try {
          const response = await apiClient.delete<{
            success: boolean;
            error?: string;
            message?: string;
          }>(`/workspaces/${workspaceId}/flows/${flowId}`);

          if (response.success) {
            set(state => {
              if (state.flows[workspaceId]) {
                state.flows[workspaceId] = state.flows[workspaceId].filter(
                  flow => flow._id !== flowId,
                );
              }
              if (state.selectedFlowId === flowId) {
                state.selectedFlowId = null;
              }
            });
          } else {
            throw new Error(response.error || "Failed to delete flow");
          }
        } catch (error: any) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          throw error;
        } finally {
          set(state => {
            delete state.loading[workspaceId];
          });
        }
      },

      toggleFlow: async (workspaceId: string, flowId: string) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });

        try {
          const response = await apiClient.post<{
            success: boolean;
            data: { enabled: boolean; message: string };
            error?: string;
          }>(`/workspaces/${workspaceId}/flows/${flowId}/toggle`);

          if (response.success) {
            set(state => {
              const flows = state.flows[workspaceId] || [];
              const index = flows.findIndex(flow => flow._id === flowId);
              if (index !== -1) {
                if (!flows[index].schedule) {
                  flows[index].schedule = {};
                }
                flows[index].schedule.enabled = response.data.enabled;
              }
            });
          } else {
            throw new Error(response.error || "Failed to toggle flow");
          }
        } catch (error: any) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
        } finally {
          set(state => {
            delete state.loading[workspaceId];
          });
        }
      },

      runFlow: async (workspaceId: string, flowId: string) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });

        try {
          const response = await apiClient.post<{
            success: boolean;
            message?: string;
            data?: any;
            error?: string;
          }>(`/workspaces/${workspaceId}/flows/${flowId}/run`);

          if (response.success) {
            // Refresh flow data to get updated status
            await get().refresh(workspaceId);
          } else {
            throw new Error(response.error || "Failed to run flow");
          }
        } catch (error: any) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
        } finally {
          set(state => {
            delete state.loading[workspaceId];
          });
        }
      },

      backfillFlow: async (workspaceId: string, flowId: string) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });

        try {
          const flow = get().flows[workspaceId]?.find(f => f._id === flowId);
          const endpoint =
            flow?.syncEngine === "cdc"
              ? `/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/backfill/start`
              : `/workspaces/${workspaceId}/flows/${flowId}/backfill`;
          const response = await apiClient.post<{
            success: boolean;
            message?: string;
            error?: string;
          }>(endpoint);

          if (response.success) {
            await get().refresh(workspaceId);
          } else {
            throw new Error(response.error || "Failed to start backfill");
          }
        } catch (error: any) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
        } finally {
          set(state => {
            delete state.loading[workspaceId];
          });
        }
      },

      setSyncEngine: async (workspaceId, flowId, syncEngine) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(`/workspaces/${workspaceId}/flows/${flowId}/sync-engine`, {
            syncEngine,
          });
          if (!response.success) {
            throw new Error(response.error || "Failed to update sync engine");
          }
          await get().refresh(workspaceId);
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      startCdcBackfill: async (workspaceId, flowId, entities) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/backfill/start`,
            entities?.length ? { entities } : undefined,
          );
          if (!response.success) {
            throw new Error(response.error || "Failed to start CDC backfill");
          }
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      resetCdcEntityColumn: async (workspaceId, flowId, params) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/reset-column`,
            {
              entity: params.entity,
              column: params.column,
              forceReplay: params.forceReplay !== false,
              startBackfill: params.startBackfill !== false,
            },
          );
          if (!response.success) {
            throw new Error(response.error || "Failed to reset column");
          }
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      resetCdcEntityTable: async (workspaceId, flowId, entity) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/reset-entity`,
            { entity },
          );
          if (!response.success) {
            throw new Error(response.error || "Failed to reset entity table");
          }
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      startCdcStream: async (workspaceId, flowId) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/stream/start`,
          );
          if (!response.success) {
            throw new Error(response.error || "Failed to start CDC stream");
          }
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      pauseCdcStream: async (workspaceId, flowId) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/stream/pause`,
          );
          if (!response.success) {
            throw new Error(response.error || "Failed to pause CDC stream");
          }
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      pauseCdcFlow: async (workspaceId, flowId) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(`/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/pause`);
          if (!response.success) {
            throw new Error(response.error || "Failed to pause CDC flow");
          }
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      cancelCdcBackfill: async (workspaceId, flowId) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/backfill/cancel`,
          );
          if (!response.success) {
            throw new Error(response.error || "Failed to cancel CDC backfill");
          }
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      resumeCdcFlow: async (workspaceId, flowId) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(`/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/resume`);
          if (!response.success) {
            throw new Error(response.error || "Failed to resume CDC flow");
          }
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      resyncCdcFlow: async (workspaceId, flowId, options) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(`/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/resync`, {
            deleteDestination: options?.deleteDestination === true,
            clearWebhookEvents: options?.clearWebhookEvents === true,
          });
          if (!response.success) {
            throw new Error(response.error || "Failed to resync CDC flow");
          }
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      recoverCdcFlow: async (workspaceId, flowId, options) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(`/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/recover`, {
            retryFailedMaterialization:
              options?.retryFailedMaterialization !== false,
            resumeBackfill: options?.resumeBackfill !== false,
            entity: options?.entity,
          });
          if (!response.success) {
            throw new Error(response.error || "Failed to recover CDC flow");
          }
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      recoverCdcStream: async (workspaceId, flowId, options) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/recover-stream`,
            {
              retryFailedMaterialization:
                options?.retryFailedMaterialization !== false,
              entity: options?.entity,
            },
          );
          if (!response.success) {
            throw new Error(response.error || "Failed to recover CDC stream");
          }
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      recoverCdcBackfill: async (workspaceId, flowId) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/recover-backfill`,
          );
          if (!response.success) {
            throw new Error(response.error || "Failed to recover CDC backfill");
          }
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      reprocessStaleEvents: async (workspaceId, flowId) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/reprocess-stale`,
          );
          if (!response.success) {
            throw new Error(
              response.error || "Failed to reprocess stale events",
            );
          }
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      retryFailedCdcMaterialization: async (workspaceId, flowId, entity) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            error?: string;
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/materialize/retry-failed`,
            {
              entity,
            },
          );
          if (!response.success) {
            throw new Error(
              response.error || "Failed to retry failed CDC materialization",
            );
          }
          await get().refresh(workspaceId);
          return true;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return false;
        }
      },

      fetchCdcStatus: async (workspaceId, flowId) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: CdcStatus;
            error?: string;
          }>(`/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/status`);
          return response.success ? response.data : null;
        } catch (error) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          return null;
        }
      },

      fetchCdcDestinationCounts: async (workspaceId, flowId) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: Record<string, number | null>;
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/sync-cdc/destination-counts`,
          );
          return response.success ? response.data : null;
        } catch {
          return null;
        }
      },

      fetchEntitySchema: async (workspaceId, flowId, entity) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: {
              entity: string;
              fields: Record<
                string,
                { type: string; nullable?: boolean; required?: boolean }
              >;
            };
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/schema?entity=${encodeURIComponent(entity)}`,
          );
          return response.success ? response.data : null;
        } catch {
          return null;
        }
      },

      fetchFlowHistory: async (workspaceId: string, flowId: string, limit) => {
        try {
          const params = limit ? { limit: String(limit) } : undefined;
          const response = await apiClient.get<{
            success: boolean;
            data: { history: FlowExecutionHistory[] };
            error?: string;
          }>(`/workspaces/${workspaceId}/flows/${flowId}/history`, params);

          if (response.success) {
            set(state => {
              state.executionHistory[flowId] = response.data.history;
            });
            return response.data.history;
          }
        } catch (error: any) {
          console.error("Failed to fetch flow history:", error);
        }
        return [];
      },

      selectFlow: (flowId: string | null) => {
        set(state => {
          state.selectedFlowId = flowId;
        });
      },

      clearError: (workspaceId: string) => {
        set(state => {
          state.error[workspaceId] = null;
        });
      },

      fetchConnectors: async (workspaceId: string) => {
        const key = `connectors:${workspaceId}`;
        set(state => {
          state.loading[key] = true;
          state.error[key] = null;
        });

        try {
          const response = await apiClient.get<{
            success: boolean;
            data: ConnectorInfo[];
            error?: string;
          }>(`/workspaces/${workspaceId}/connectors`);

          if (response.success) {
            return response.data || [];
          }
          throw new Error(response.error || "Failed to fetch connectors");
        } catch (error: any) {
          set(state => {
            state.error[key] = normalizeError(error);
          });
          return [];
        } finally {
          set(state => {
            delete state.loading[key];
          });
        }
      },

      fetchWebhookStats: async (workspaceId: string, flowId: string) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: WebhookStats;
          }>(`/workspaces/${workspaceId}/flows/${flowId}/webhook/stats`);

          return response.success ? response.data : null;
        } catch (error) {
          console.error("Failed to fetch webhook stats:", error);
          return null;
        }
      },

      fetchWebhookEvents: async (
        workspaceId,
        flowId,
        limit,
        offset,
        filters,
      ) => {
        try {
          const params = new URLSearchParams({
            limit: String(limit),
            offset: String(offset),
          });
          if (filters?.status) params.set("status", filters.status);
          if (filters?.applyStatus) {
            params.set("applyStatus", filters.applyStatus);
          }
          const response = await apiClient.get<{
            success: boolean;
            data: {
              total: number;
              events: WebhookEvent[];
            };
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/webhook/events?${params}`,
          );

          return response.success ? response.data : null;
        } catch (error) {
          console.error("Failed to fetch webhook events:", error);
          return null;
        }
      },

      fetchWebhookEventDetails: async (workspaceId, flowId, eventId) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: unknown;
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/webhook/events/${eventId}`,
          );

          return response.success ? response.data : null;
        } catch (error) {
          console.error("Failed to fetch event details:", error);
          return null;
        }
      },

      retryAllFailedWebhookEvents: async (workspaceId, flowId) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            data: { retried: number; total: number };
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/webhook/events/retry-all-failed`,
          );
          return response.success ? response.data : null;
        } catch (error) {
          console.error("Failed to retry all failed webhook events:", error);
          return null;
        }
      },

      retryWebhookEvent: async (workspaceId, flowId, eventId) => {
        try {
          const response = await apiClient.post<{ success: boolean }>(
            `/workspaces/${workspaceId}/flows/${flowId}/webhook/events/${eventId}/retry`,
          );
          return response.success;
        } catch (error) {
          console.error("Failed to retry webhook event:", error);
          return false;
        }
      },

      provisionFlowWebhook: async (workspaceId, flowId, options) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            data: ProvisionedWebhook;
            error?: string;
          }>(`/workspaces/${workspaceId}/flows/${flowId}/webhook/provision`, {
            verifySsl: options?.verifySsl,
            events: options?.events,
            publicBaseUrl: options?.publicBaseUrl,
          });
          if (!response.success) {
            throw new Error(response.error || "Failed to provision webhook");
          }
          return response.data;
        } catch (error) {
          console.error("Failed to provision webhook:", error);
          throw new Error(normalizeError(error));
        }
      },

      fetchFlowDetails: async (workspaceId, flowId) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: Flow;
          }>(`/workspaces/${workspaceId}/flows/${flowId}`);

          return response.success ? response.data : null;
        } catch (error) {
          console.error("Failed to fetch flow details:", error);
          return null;
        }
      },

      fetchFlowStatus: async (workspaceId, flowId) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: FlowStatusResponse;
          }>(`/workspaces/${workspaceId}/flows/${flowId}/status`);

          return response.success ? response.data : null;
        } catch (error) {
          console.error("Failed to check flow status", error);
          return null;
        }
      },

      fetchExecutionDetails: async (workspaceId, flowId, executionId) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: ExecutionDetails;
          }>(
            `/workspaces/${workspaceId}/flows/${flowId}/executions/${executionId}`,
          );

          return response.success ? response.data : null;
        } catch (error) {
          console.error("Failed to fetch execution details", error);
          return null;
        }
      },

      cancelFlowExecution: async (workspaceId, flowId, executionId) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            message?: string;
          }>(`/workspaces/${workspaceId}/flows/${flowId}/cancel`, {
            executionId,
          });
          return response.success;
        } catch (error) {
          console.error("Failed to cancel flow execution", error);
          return false;
        }
      },

      validateDbQuery: async (workspaceId, connectionId, query, database) => {
        try {
          const response = await apiClient.post<{
            success: boolean;
            data?: {
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
            };
            error?: string;
            safetyCheck?: {
              safe: boolean;
              warnings: string[];
              errors: string[];
              suggestedFixes?: string[];
            };
          }>(`/workspaces/${workspaceId}/flows/validate-query`, {
            connectionId,
            query,
            database,
          });

          if (response.success && response.data) {
            return {
              success: true,
              columns: response.data.columns,
              sampleRow: response.data.sampleRow,
              connectionName: response.data.connectionName,
              connectionType: response.data.connectionType,
              safetyCheck: response.data.safetyCheck,
            };
          }

          return {
            success: false,
            error: response.error || "Query validation failed",
            safetyCheck: response.safetyCheck,
          };
        } catch (error) {
          console.error("Failed to validate query:", error);
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Query validation failed",
          };
        }
      },

      reset: () => {
        set(initialState);
      },
    })),
    {
      name: "flow-store-v2",
      storage: createValidatedStorage(
        flowStoreStateSchema,
        "flow-store-v2",
        initialState,
      ),
      partialize: state => ({
        flows: state.flows,
        selectedFlowId: state.selectedFlowId,
        executionHistory: state.executionHistory,
      }),
    },
  ),
);
