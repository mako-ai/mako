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
const flowQuerySchema = z.object({
  name: z.string(),
  query: z.string(),
  variables: z.record(z.any()).optional(),
  dataPath: z.string().optional(),
  data_path: z.string().optional(),
  hasNextPagePath: z.string().optional(),
  has_next_page_path: z.string().optional(),
  cursorPath: z.string().optional(),
  cursor_path: z.string().optional(),
  totalCountPath: z.string().optional(),
  total_count_path: z.string().optional(),
  batchSize: z.number().optional(),
  batch_size: z.number().optional(),
});

export type FlowQuery = z.infer<typeof flowQuerySchema>;

/** @deprecated Use FlowQuery instead */
export type TransferQuery = FlowQuery;

const flowSchema = z.object({
  _id: z.string(),
  workspaceId: z.string(),
  dataSourceId: flowDataSourceSchema,
  destinationDatabaseId: flowDestinationSchema,
  destinationDatabaseName: z.string().nullable().optional(),
  type: z.enum(["scheduled", "webhook"]).optional(), // Remove default to detect missing type
  schedule: flowScheduleSchema,
  webhookConfig: webhookConfigSchema,
  entityFilter: z.array(z.string()).nullable().optional(),
  queries: z.array(flowQuerySchema).nullable().optional(),
  syncMode: z.enum(["full", "incremental"]),
  enabled: z.boolean(),
  lastRunAt: z.string().nullable().optional(),
  lastSuccessAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  nextRunAt: z.string().nullable().optional(),
  runCount: z.number(),
  avgDurationMs: z.number().nullable().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Flow = z.infer<typeof flowSchema>;

/** @deprecated Use Flow instead */
export type SyncJob = Flow;

const flowExecutionHistorySchema = z.object({
  executedAt: z.string(),
  success: z.boolean(),
  error: z.string().nullable().optional(),
  duration: z.number().nullable().optional(),
});

export type FlowExecutionHistory = z.infer<typeof flowExecutionHistorySchema>;

/** @deprecated Use FlowExecutionHistory instead */
export type SyncJobExecutionHistory = FlowExecutionHistory;

// Store state schema for validation
const flowStoreStateSchema = z.object({
  flows: z.record(z.array(flowSchema)),
  loading: z.record(z.boolean()).optional().default({}),
  error: z.record(errorSchema.nullable()).optional().default({}),
  selectedFlowId: z.string().nullable(),
  executionHistory: z.record(z.array(flowExecutionHistorySchema)),
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
  fetchFlowHistory: (workspaceId: string, flowId: string) => Promise<void>;
  selectFlow: (flowId: string | null) => void;
  clearError: (workspaceId: string) => void;
  reset: () => void;

  // Backwards compatibility aliases
  /** @deprecated Use flows instead */
  jobs: FlowStoreState["flows"];
  /** @deprecated Use selectedFlowId instead */
  selectedJobId: FlowStoreState["selectedFlowId"];
  /** @deprecated Use fetchFlows instead */
  fetchJobs: (workspaceId: string) => Promise<Flow[]>;
  /** @deprecated Use createFlow instead */
  createJob: (workspaceId: string, data: Partial<Flow>) => Promise<Flow>;
  /** @deprecated Use updateFlow instead */
  updateJob: (
    workspaceId: string,
    flowId: string,
    data: Partial<Flow>,
  ) => Promise<void>;
  /** @deprecated Use deleteFlow instead */
  deleteJob: (workspaceId: string, flowId: string) => Promise<void>;
  /** @deprecated Use toggleFlow instead */
  toggleJob: (workspaceId: string, flowId: string) => Promise<void>;
  /** @deprecated Use runFlow instead */
  runJob: (workspaceId: string, flowId: string) => Promise<void>;
  /** @deprecated Use fetchFlowHistory instead */
  fetchJobHistory: (workspaceId: string, flowId: string) => Promise<void>;
  /** @deprecated Use selectFlow instead */
  selectJob: (flowId: string | null) => void;
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

      // Backwards compatibility: jobs is an alias for flows
      get jobs() {
        return get().flows;
      },
      get selectedJobId() {
        return get().selectedFlowId;
      },

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

      // Backwards compatibility alias
      fetchJobs: async (workspaceId: string) => {
        return get().fetchFlows(workspaceId);
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

      // Backwards compatibility alias
      createJob: async (workspaceId: string, data: Partial<Flow>) => {
        return get().createFlow(workspaceId, data);
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

      // Backwards compatibility alias
      updateJob: async (
        workspaceId: string,
        flowId: string,
        data: Partial<Flow>,
      ) => {
        return get().updateFlow(workspaceId, flowId, data);
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

      // Backwards compatibility alias
      deleteJob: async (workspaceId: string, flowId: string) => {
        return get().deleteFlow(workspaceId, flowId);
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
                flows[index].enabled = response.data.enabled;
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

      // Backwards compatibility alias
      toggleJob: async (workspaceId: string, flowId: string) => {
        return get().toggleFlow(workspaceId, flowId);
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

      // Backwards compatibility alias
      runJob: async (workspaceId: string, flowId: string) => {
        return get().runFlow(workspaceId, flowId);
      },

      fetchFlowHistory: async (workspaceId: string, flowId: string) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: { history: FlowExecutionHistory[] };
            error?: string;
          }>(`/workspaces/${workspaceId}/flows/${flowId}/history`);

          if (response.success) {
            set(state => {
              state.executionHistory[flowId] = response.data.history;
            });
          }
        } catch (error: any) {
          console.error("Failed to fetch flow history:", error);
        }
      },

      // Backwards compatibility alias
      fetchJobHistory: async (workspaceId: string, flowId: string) => {
        return get().fetchFlowHistory(workspaceId, flowId);
      },

      selectFlow: (flowId: string | null) => {
        set(state => {
          state.selectedFlowId = flowId;
        });
      },

      // Backwards compatibility alias
      selectJob: (flowId: string | null) => {
        get().selectFlow(flowId);
      },

      clearError: (workspaceId: string) => {
        set(state => {
          state.error[workspaceId] = null;
        });
      },

      reset: () => {
        set(initialState);
      },
    })),
    {
      name: "flow-store-v1", // New storage key for fresh start
      storage: createValidatedStorage(
        flowStoreStateSchema,
        "flow-store-v1",
        initialState,
      ),
      partialize: state => ({
        flows: state.flows,
        selectedFlowId: state.selectedFlowId,
        executionHistory: state.executionHistory,
        // Don't persist loading or error states
      }),
    },
  ),
);

/** @deprecated Use useFlowStore instead */
export const useSyncJobStore = useFlowStore;

