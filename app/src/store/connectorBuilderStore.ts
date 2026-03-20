import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import { apiClient } from "../lib/api-client";
import { z } from "zod";
import { createValidatedStorage, errorSchema } from "./store-validation";

// ── Types ──

export interface UserConnector {
  _id: string;
  workspaceId: string;
  name: string;
  description?: string;
  source: {
    code: string;
    resolvedDependencies?: Record<string, string>;
  };
  bundle?: {
    js?: string;
    sourceMap?: string;
    buildHash?: string;
    buildLog?: string;
    builtAt?: string;
    errors?: Array<{
      line?: number;
      column?: number;
      message: string;
      severity: "error" | "warning";
    }>;
  };
  metadata: {
    entities?: string[];
    configSchema?: Record<string, unknown>;
    secretKeys?: string[];
  };
  version: number;
  visibility: "private" | "workspace" | "public";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorInstance {
  _id: string;
  workspaceId: string;
  connectorId: string;
  name: string;
  config: Record<string, unknown>;
  output: {
    destinationConnectionId?: string;
    destinationDatabase?: string;
    schema?: string;
    tablePrefix?: string;
    schemaEvolutionMode: string;
  };
  triggers: Array<{
    type: "cron" | "webhook";
    cron?: string;
    timezone?: string;
    syncMode?: string;
    webhookPath?: string;
  }>;
  status: {
    enabled: boolean;
    lastRunAt?: string;
    lastSuccessAt?: string;
    lastError?: string;
    runCount: number;
    consecutiveFailures: number;
  };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface BuildState {
  building: boolean;
  buildLog?: string;
  errors: Array<{
    line?: number;
    column?: number;
    message: string;
    severity: "error" | "warning";
  }>;
}

export interface DevRunOutput {
  batches: Array<{
    entity: string;
    records: Record<string, unknown>[];
    schema?: {
      name: string;
      columns: Array<{
        name: string;
        type: string;
        nullable?: boolean;
        primaryKey?: boolean;
      }>;
    };
  }>;
  state: Record<string, unknown>;
  hasMore: boolean;
  logs: Array<{
    level: string;
    message: string;
    timestamp?: string;
    data?: unknown;
  }>;
}

export interface DevRunState {
  running: boolean;
  output?: DevRunOutput;
  logs?: string;
  error?: string;
  durationMs?: number;
  rowCount?: number;
}

// ── Zod Schemas for validation ──

const userConnectorSchema = z.object({
  _id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  source: z.object({
    code: z.string(),
    resolvedDependencies: z.record(z.string()).optional(),
  }),
  bundle: z
    .object({
      buildHash: z.string().optional(),
      buildLog: z.string().optional(),
      builtAt: z.string().optional(),
      errors: z
        .array(
          z.object({
            line: z.number().optional(),
            column: z.number().optional(),
            message: z.string(),
            severity: z.enum(["error", "warning"]),
          }),
        )
        .optional(),
    })
    .optional(),
  metadata: z
    .object({
      entities: z.array(z.string()).optional(),
      configSchema: z.record(z.unknown()).optional(),
      secretKeys: z.array(z.string()).optional(),
    })
    .optional()
    .default({}),
  version: z.number(),
  visibility: z.enum(["private", "workspace", "public"]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const storeStateSchema = z.object({
  connectors: z.record(z.array(userConnectorSchema)),
  selectedConnectorId: z.string().nullable(),
  loading: z.record(z.boolean()).optional().default({}),
  error: z.record(errorSchema.nullable()).optional().default({}),
});

type StoreState = z.infer<typeof storeStateSchema>;

// ── Store Interface ──

interface ConnectorBuilderStore extends StoreState {
  buildState: Record<string, BuildState>;
  devRunState: Record<string, DevRunState>;
  instances: Record<string, ConnectorInstance[]>;

  // Connector actions
  fetchConnectors: (workspaceId: string) => Promise<UserConnector[]>;
  createConnector: (
    workspaceId: string,
    data?: Partial<{ name: string; description: string; code: string }>,
  ) => Promise<UserConnector>;
  updateConnector: (
    workspaceId: string,
    connectorId: string,
    data: Partial<{ name: string; description: string; code: string }>,
  ) => Promise<void>;
  deleteConnector: (workspaceId: string, connectorId: string) => Promise<void>;
  selectConnector: (connectorId: string | null) => void;
  getConnector: (
    workspaceId: string,
    connectorId: string,
  ) => UserConnector | undefined;

  // Build actions
  buildConnector: (workspaceId: string, connectorId: string) => Promise<void>;

  // Dev-run actions
  devRun: (
    workspaceId: string,
    connectorId: string,
    input?: {
      config?: Record<string, unknown>;
      secrets?: Record<string, string>;
      state?: Record<string, unknown>;
      trigger?: { type: string; payload?: unknown };
    },
  ) => Promise<void>;

  // Instance actions
  fetchInstances: (
    workspaceId: string,
    connectorId?: string,
  ) => Promise<ConnectorInstance[]>;
  createInstance: (
    workspaceId: string,
    data: Record<string, unknown>,
  ) => Promise<ConnectorInstance>;
  updateInstance: (
    workspaceId: string,
    instanceId: string,
    data: Record<string, unknown>,
  ) => Promise<void>;
  deleteInstance: (workspaceId: string, instanceId: string) => Promise<void>;
  toggleInstance: (workspaceId: string, instanceId: string) => Promise<void>;

  clearError: (workspaceId: string) => void;
  reset: () => void;
}

const initialState: StoreState = {
  connectors: {},
  selectedConnectorId: null,
  loading: {},
  error: {},
};

const normalizeError = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    if ("message" in error) return String((error as any).message);
    if ("error" in error) return String((error as any).error);
    return JSON.stringify(error);
  }
  return "Unknown error";
};

export const useConnectorBuilderStore = create<ConnectorBuilderStore>()(
  persist(
    immer((set, get) => ({
      ...initialState,
      buildState: {},
      devRunState: {},
      instances: {},

      fetchConnectors: async (workspaceId: string) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });

        try {
          const response = await apiClient.get<{
            success: boolean;
            data: UserConnector[];
            error?: string;
          }>(`/workspaces/${workspaceId}/connector-builder/connectors`);

          if (response.success) {
            set(state => {
              state.connectors[workspaceId] = response.data || [];
              state.error[workspaceId] = null;
            });
            return response.data || [];
          }
          throw new Error(response.error || "Failed to fetch connectors");
        } catch (error: unknown) {
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

      createConnector: async (workspaceId, data) => {
        set(state => {
          state.loading[workspaceId] = true;
          state.error[workspaceId] = null;
        });

        try {
          const response = await apiClient.post<{
            success: boolean;
            data: UserConnector;
            error?: string;
          }>(
            `/workspaces/${workspaceId}/connector-builder/connectors`,
            data || {},
          );

          if (response.success) {
            set(state => {
              if (!state.connectors[workspaceId]) {
                state.connectors[workspaceId] = [];
              }
              state.connectors[workspaceId].push(response.data);
            });
            return response.data;
          }
          throw new Error(response.error || "Failed to create connector");
        } catch (error: unknown) {
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

      updateConnector: async (workspaceId, connectorId, data) => {
        try {
          const response = await apiClient.put<{
            success: boolean;
            data: UserConnector;
            error?: string;
          }>(
            `/workspaces/${workspaceId}/connector-builder/connectors/${connectorId}`,
            data,
          );

          if (response.success) {
            set(state => {
              const list = state.connectors[workspaceId] || [];
              const idx = list.findIndex(c => c._id === connectorId);
              if (idx !== -1) {
                list[idx] = { ...list[idx], ...response.data };
              }
            });
          } else {
            throw new Error(response.error || "Failed to update connector");
          }
        } catch (error: unknown) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          throw error;
        }
      },

      deleteConnector: async (workspaceId, connectorId) => {
        try {
          const response = await apiClient.delete<{
            success: boolean;
            error?: string;
          }>(
            `/workspaces/${workspaceId}/connector-builder/connectors/${connectorId}`,
          );

          if (response.success) {
            set(state => {
              if (state.connectors[workspaceId]) {
                state.connectors[workspaceId] = state.connectors[
                  workspaceId
                ].filter(c => c._id !== connectorId);
              }
              if (state.selectedConnectorId === connectorId) {
                state.selectedConnectorId = null;
              }
              delete state.buildState[connectorId];
              delete state.devRunState[connectorId];
            });
          } else {
            throw new Error(response.error || "Failed to delete connector");
          }
        } catch (error: unknown) {
          set(state => {
            state.error[workspaceId] = normalizeError(error);
          });
          throw error;
        }
      },

      selectConnector: connectorId => {
        set(state => {
          state.selectedConnectorId = connectorId;
        });
      },

      getConnector: (workspaceId, connectorId) => {
        const list = get().connectors[workspaceId] || [];
        return list.find(c => c._id === connectorId);
      },

      buildConnector: async (workspaceId, connectorId) => {
        set(state => {
          state.buildState[connectorId] = {
            building: true,
            errors: [],
          };
        });

        try {
          const response = await apiClient.post<{
            success: boolean;
            data: {
              buildHash: string;
              buildLog: string;
              errors: Array<{
                line?: number;
                column?: number;
                message: string;
                severity: "error" | "warning";
              }>;
              resolvedDependencies: Record<string, string>;
            };
            error?: string;
          }>(
            `/workspaces/${workspaceId}/connector-builder/connectors/${connectorId}/build`,
          );

          set(state => {
            state.buildState[connectorId] = {
              building: false,
              buildLog: response.data?.buildLog,
              errors: response.data?.errors || [],
            };
          });

          // Refresh connector data after build
          await get().fetchConnectors(workspaceId);
        } catch (error: unknown) {
          set(state => {
            state.buildState[connectorId] = {
              building: false,
              errors: [
                {
                  message: normalizeError(error),
                  severity: "error",
                },
              ],
            };
          });
        }
      },

      devRun: async (workspaceId, connectorId, input) => {
        set(state => {
          state.devRunState[connectorId] = {
            running: true,
          };
        });

        try {
          const response = await apiClient.post<{
            success: boolean;
            data: {
              output: DevRunOutput;
              logs: string;
              durationMs: number;
              rowCount: number;
              buildErrors?: Array<{
                line?: number;
                column?: number;
                message: string;
                severity: "error" | "warning";
              }>;
              buildLog?: string;
            };
            error?: string;
          }>(
            `/workspaces/${workspaceId}/connector-builder/connectors/${connectorId}/dev-run`,
            input || {},
          );

          if (response.success) {
            set(state => {
              state.devRunState[connectorId] = {
                running: false,
                output: response.data.output,
                logs: response.data.logs,
                durationMs: response.data.durationMs,
                rowCount: response.data.rowCount,
              };
            });
          } else {
            // Build failure during dev-run
            set(state => {
              state.devRunState[connectorId] = {
                running: false,
                error: response.error || "Dev-run failed",
              };
              if (response.data?.buildErrors) {
                state.buildState[connectorId] = {
                  building: false,
                  buildLog: response.data.buildLog,
                  errors: response.data.buildErrors,
                };
              }
            });
          }
        } catch (error: unknown) {
          set(state => {
            state.devRunState[connectorId] = {
              running: false,
              error: normalizeError(error),
            };
          });
        }
      },

      fetchInstances: async (workspaceId, connectorId) => {
        try {
          const params: Record<string, string> = {};
          if (connectorId) params.connectorId = connectorId;

          const response = await apiClient.get<{
            success: boolean;
            data: ConnectorInstance[];
            error?: string;
          }>(`/workspaces/${workspaceId}/connector-builder/instances`, params);

          if (response.success) {
            set(state => {
              const key = connectorId || workspaceId;
              state.instances[key] = response.data || [];
            });
            return response.data || [];
          }
          return [];
        } catch {
          return [];
        }
      },

      createInstance: async (workspaceId, data) => {
        const response = await apiClient.post<{
          success: boolean;
          data: ConnectorInstance;
          error?: string;
        }>(`/workspaces/${workspaceId}/connector-builder/instances`, data);

        if (!response.success) {
          throw new Error(response.error || "Failed to create instance");
        }

        // Refresh instances
        const connectorId = data.connectorId as string;
        if (connectorId) {
          await get().fetchInstances(workspaceId, connectorId);
        }

        return response.data;
      },

      updateInstance: async (workspaceId, instanceId, data) => {
        const response = await apiClient.put<{
          success: boolean;
          data: ConnectorInstance;
          error?: string;
        }>(
          `/workspaces/${workspaceId}/connector-builder/instances/${instanceId}`,
          data,
        );

        if (!response.success) {
          throw new Error(response.error || "Failed to update instance");
        }
      },

      deleteInstance: async (workspaceId, instanceId) => {
        const response = await apiClient.delete<{
          success: boolean;
          error?: string;
        }>(
          `/workspaces/${workspaceId}/connector-builder/instances/${instanceId}`,
        );

        if (!response.success) {
          throw new Error(response.error || "Failed to delete instance");
        }
      },

      toggleInstance: async (workspaceId, instanceId) => {
        await apiClient.post(
          `/workspaces/${workspaceId}/connector-builder/instances/${instanceId}/toggle`,
        );
      },

      clearError: workspaceId => {
        set(state => {
          state.error[workspaceId] = null;
        });
      },

      reset: () => {
        set({
          ...initialState,
          buildState: {},
          devRunState: {},
          instances: {},
        });
      },
    })),
    {
      name: "connector-builder-store-v1",
      storage: createValidatedStorage(
        storeStateSchema,
        "connector-builder-store-v1",
        initialState,
      ),
      partialize: state => ({
        connectors: state.connectors,
        selectedConnectorId: state.selectedConnectorId,
      }),
    },
  ),
);
