import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import { apiClient } from "../lib/api-client";
import { z } from "zod";
import { createValidatedStorage, errorSchema } from "./store-validation";

// Zod schemas for validation
const syncJobDataSourceSchema = z.object({
  _id: z.string(),
  name: z.string(),
  type: z.string(),
});

const syncJobDestinationSchema = z.object({
  _id: z.string(),
  name: z.string(),
  type: z.string(),
});

// Allow schedule to be absent or partial (webhook jobs have no schedule)
const syncJobScheduleSchema = z
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

// Query schema for GraphQL/PostHog transfers
const transferQuerySchema = z.object({
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

export type TransferQuery = z.infer<typeof transferQuerySchema>;

const syncJobSchema = z.object({
  _id: z.string(),
  workspaceId: z.string(),
  dataSourceId: syncJobDataSourceSchema,
  destinationDatabaseId: syncJobDestinationSchema,
  destinationDatabaseName: z.string().nullable().optional(),
  type: z.enum(["scheduled", "webhook"]).optional(), // Remove default to detect missing type
  schedule: syncJobScheduleSchema,
  webhookConfig: webhookConfigSchema,
  entityFilter: z.array(z.string()).nullable().optional(),
  queries: z.array(transferQuerySchema).nullable().optional(),
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

export type SyncJob = z.infer<typeof syncJobSchema>;

const syncJobExecutionHistorySchema = z.object({
  executedAt: z.string(),
  success: z.boolean(),
  error: z.string().nullable().optional(),
  duration: z.number().nullable().optional(),
});

export type SyncJobExecutionHistory = z.infer<
  typeof syncJobExecutionHistorySchema
>;

// Store state schema for validation
const syncJobStoreStateSchema = z.object({
  jobs: z.record(z.array(syncJobSchema)),
  loading: z.record(z.boolean()).optional().default({}),
  error: z.record(errorSchema.nullable()).optional().default({}),
  selectedJobId: z.string().nullable(),
  executionHistory: z.record(z.array(syncJobExecutionHistorySchema)),
});

type SyncJobStoreState = z.infer<typeof syncJobStoreStateSchema>;

interface SyncJobStore extends SyncJobStoreState {
  // Actions
  fetchJobs: (workspaceId: string) => Promise<SyncJob[]>;
  refresh: (workspaceId: string) => Promise<SyncJob[]>;
  init: (workspaceId: string) => Promise<void>;
  createJob: (workspaceId: string, data: Partial<SyncJob>) => Promise<SyncJob>;
  updateJob: (
    workspaceId: string,
    jobId: string,
    data: Partial<SyncJob>,
  ) => Promise<void>;
  deleteJob: (workspaceId: string, jobId: string) => Promise<void>;
  toggleJob: (workspaceId: string, jobId: string) => Promise<void>;
  runJob: (workspaceId: string, jobId: string) => Promise<void>;
  fetchJobHistory: (workspaceId: string, jobId: string) => Promise<void>;
  selectJob: (jobId: string | null) => void;
  clearError: (workspaceId: string) => void;
  reset: () => void;
}

const initialState: SyncJobStoreState = {
  jobs: {},
  loading: {},
  error: {},
  selectedJobId: null,
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

export const useSyncJobStore = create<SyncJobStore>()(
  persist(
    immer((set, get) => ({
      ...initialState,

      fetchJobs: async (workspaceId: string) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });

        try {
          const response = await apiClient.get<{
            success: boolean;
            data: SyncJob[];
            error?: string;
          }>(`/workspaces/${workspaceId}/sync-jobs`);

          if (response.success) {
            set(state => {
              state.jobs[workspaceId] = response.data || [];
              state.error[workspaceId] = null;
            });
            return response.data || [];
          } else {
            throw new Error(response.error || "Failed to fetch sync jobs");
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
        return await get().fetchJobs(workspaceId);
      },

      init: async (workspaceId: string) => {
        const existingJobs = get().jobs[workspaceId];

        // If we have cached jobs, check if any are missing the 'type' field
        // This indicates stale data from before webhooks were implemented
        if (existingJobs && existingJobs.length > 0) {
          const hasStaleData = existingJobs.some(job => job.type === undefined);
          if (hasStaleData) {
            // Clear stale data from the store before refreshing
            set(state => {
              state.jobs[workspaceId] = [];
            });
            // Now refresh from API
            await get().refresh(workspaceId);
            return;
          }
        }

        // If no data exists, fetch it
        if (!existingJobs || existingJobs.length === 0) {
          await get().refresh(workspaceId);
        }
      },

      createJob: async (workspaceId: string, data: Partial<SyncJob>) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });

        try {
          const response = await apiClient.post<{
            success: boolean;
            data: SyncJob;
            error?: string;
          }>(`/workspaces/${workspaceId}/sync-jobs`, data);

          if (response.success) {
            const newJob = response.data;
            set(state => {
              if (!state.jobs[workspaceId]) {
                state.jobs[workspaceId] = [];
              }
              state.jobs[workspaceId].push(newJob);
            });
            return newJob;
          } else {
            throw new Error(response.error || "Failed to create sync job");
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

      updateJob: async (
        workspaceId: string,
        jobId: string,
        data: Partial<SyncJob>,
      ) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });

        try {
          const response = await apiClient.put<{
            success: boolean;
            data: SyncJob;
            error?: string;
          }>(`/workspaces/${workspaceId}/sync-jobs/${jobId}`, data);

          if (response.success) {
            set(state => {
              const jobs = state.jobs[workspaceId] || [];
              const index = jobs.findIndex(job => job._id === jobId);
              if (index !== -1) {
                jobs[index] = response.data;
              }
            });
          } else {
            throw new Error(response.error || "Failed to update sync job");
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

      deleteJob: async (workspaceId: string, jobId: string) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });

        try {
          const response = await apiClient.delete<{
            success: boolean;
            error?: string;
            message?: string;
          }>(`/workspaces/${workspaceId}/sync-jobs/${jobId}`);

          if (response.success) {
            set(state => {
              if (state.jobs[workspaceId]) {
                state.jobs[workspaceId] = state.jobs[workspaceId].filter(
                  job => job._id !== jobId,
                );
              }
              if (state.selectedJobId === jobId) {
                state.selectedJobId = null;
              }
            });
          } else {
            throw new Error(response.error || "Failed to delete sync job");
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

      toggleJob: async (workspaceId: string, jobId: string) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });

        try {
          const response = await apiClient.post<{
            success: boolean;
            data: { enabled: boolean; message: string };
            error?: string;
          }>(`/workspaces/${workspaceId}/sync-jobs/${jobId}/toggle`);

          if (response.success) {
            set(state => {
              const jobs = state.jobs[workspaceId] || [];
              const index = jobs.findIndex(job => job._id === jobId);
              if (index !== -1) {
                jobs[index].enabled = response.data.enabled;
              }
            });
          } else {
            throw new Error(response.error || "Failed to toggle sync job");
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

      runJob: async (workspaceId: string, jobId: string) => {
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
          }>(`/workspaces/${workspaceId}/sync-jobs/${jobId}/run`);

          if (response.success) {
            // Refresh job data to get updated status
            await get().refresh(workspaceId);
          } else {
            throw new Error(response.error || "Failed to run sync job");
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

      fetchJobHistory: async (workspaceId: string, jobId: string) => {
        try {
          const response = await apiClient.get<{
            success: boolean;
            data: { history: SyncJobExecutionHistory[] };
            error?: string;
          }>(`/workspaces/${workspaceId}/sync-jobs/${jobId}/history`);

          if (response.success) {
            set(state => {
              state.executionHistory[jobId] = response.data.history;
            });
          }
        } catch (error: any) {
          console.error("Failed to fetch job history:", error);
        }
      },

      selectJob: (jobId: string | null) => {
        set(state => {
          state.selectedJobId = jobId;
        });
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
      name: "sync-job-store-v2", // Version bump to clear old persisted state
      storage: createValidatedStorage(
        syncJobStoreStateSchema,
        "sync-job-store-v2",
        initialState,
      ),
      partialize: state => ({
        jobs: state.jobs,
        selectedJobId: state.selectedJobId,
        executionHistory: state.executionHistory,
        // Don't persist loading or error states
      }),
    },
  ),
);
