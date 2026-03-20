import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { z } from "zod";
import { apiClient } from "../lib/api-client";

const connectorBuildErrorSchema = z.object({
  message: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
  raw: z.string().optional(),
  severity: z.enum(["error", "warning"]).optional(),
});

const connectorVersionSchema = z.object({
  version: z.number(),
  code: z.string(),
  buildHash: z.string().optional(),
  builtAt: z.string().optional(),
  createdAt: z.string(),
  createdBy: z.string(),
  resolvedDependencies: z.array(z.string()).default([]),
});

const connectorSchema = z.object({
  _id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  source: z.object({
    code: z.string(),
    resolvedDependencies: z.array(z.string()).default([]),
  }),
  bundle: z.object({
    js: z.string().optional(),
    sourceMap: z.string().optional(),
    buildHash: z.string().optional(),
    buildLog: z.string().optional(),
    errors: z.array(connectorBuildErrorSchema).default([]),
    builtAt: z.string().optional(),
    runtime: z.enum(["e2b", "local-fallback"]).optional(),
  }),
  metadata: z.object({
    language: z.literal("typescript"),
    entrypoint: z.string(),
    runtime: z.literal("nodejs"),
    tags: z.array(z.string()).default([]),
  }),
  version: z.number(),
  versions: z.array(connectorVersionSchema).default([]),
  visibility: z.enum(["workspace", "public"]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const connectorLogSchema = z.object({
  level: z.string(),
  message: z.string(),
  timestamp: z.string().optional(),
});

const connectorColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  nullable: z.boolean().optional(),
  description: z.string().optional(),
});

const connectorEntitySchema = z.object({
  entity: z.string(),
  description: z.string().optional(),
  primaryKey: z.array(z.string()).default([]),
  columns: z.array(connectorColumnSchema).default([]),
});

const connectorOutputSchema = z.object({
  hasMore: z.boolean().default(false),
  state: z.record(z.unknown()).default({}),
  batches: z
    .array(
      z.object({
        entity: z.string(),
        rows: z.array(z.record(z.unknown())).default([]),
        schema: connectorEntitySchema.optional(),
      }),
    )
    .default([]),
  schemas: z.array(connectorEntitySchema).default([]),
  logs: z.array(connectorLogSchema).default([]),
  metrics: z
    .object({
      rowCount: z.number().optional(),
      durationMs: z.number().optional(),
    })
    .optional(),
});

const connectorRuntimeErrorSchema = z.object({
  message: z.string(),
  originalLine: z.number().optional(),
  originalColumn: z.number().optional(),
  originalSource: z.string().optional(),
  stack: z.string().optional(),
});

const connectorInstanceTriggerSchema = z.object({
  type: z.enum(["manual", "schedule", "webhook"]),
  enabled: z.boolean(),
  cron: z.string().optional(),
  path: z.string().optional(),
});

const connectorInstanceSchema = z.object({
  _id: z.string(),
  workspaceId: z.string(),
  connectorId: z.string(),
  name: z.string(),
  secrets: z.record(z.unknown()).default({}),
  config: z.record(z.unknown()).default({}),
  output: z.object({
    destinationDatabaseId: z.string().optional(),
    destinationSchema: z.string().optional(),
    destinationTablePrefix: z.string().optional(),
    evolutionMode: z
      .enum(["strict", "append", "variant", "relaxed"])
      .optional(),
  }),
  triggers: z.array(connectorInstanceTriggerSchema).default([]),
  state: z.record(z.unknown()).default({}),
  status: z.enum(["idle", "active", "running", "error", "disabled"]),
  lastRunAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  lastError: z.string().optional(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const buildResponseSchema = z.object({
  build: z.object({
    js: z.string().optional(),
    sourceMap: z.string().optional(),
    buildHash: z.string(),
    buildLog: z.string(),
    errors: z.array(connectorBuildErrorSchema).default([]),
    resolvedDependencies: z.array(z.string()).default([]),
    runtime: z.enum(["e2b", "local-fallback"]),
    builtAt: z.string(),
  }),
  connector: connectorSchema,
});

const devRunResponseSchema = z.object({
  build: buildResponseSchema.shape.build,
  connector: connectorSchema,
  output: connectorOutputSchema.optional(),
  logs: z.array(connectorLogSchema).default([]),
  durationMs: z.number().optional(),
  runtime: z.enum(["e2b", "local-fallback"]).optional(),
  runtimeError: connectorRuntimeErrorSchema.optional(),
});

export type UserConnector = z.infer<typeof connectorSchema>;
export type ConnectorOutput = z.infer<typeof connectorOutputSchema>;
export type ConnectorRuntimeError = z.infer<typeof connectorRuntimeErrorSchema>;
export type ConnectorInstance = z.infer<typeof connectorInstanceSchema>;
export interface ConnectorTemplateSummary {
  id: string;
  name: string;
  description: string;
  category: string;
}
export interface ConnectorExecution {
  _id: string;
  workspaceId: string;
  connectorId: string;
  instanceId: string;
  triggerType: "manual" | "schedule" | "webhook";
  status: "running" | "completed" | "failed" | "cancelled";
  runtime?: "e2b" | "local-fallback";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  rowCount?: number;
  error?: {
    message?: string;
    stack?: string;
  };
  logs: Array<{
    level: string;
    message: string;
    timestamp?: string;
  }>;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export type ConnectorBuildState = {
  building: boolean;
  buildLog?: string;
  errors?: z.infer<typeof connectorBuildErrorSchema>[];
};
export type ConnectorDevRunState = {
  running: boolean;
  output?: ConnectorOutput;
  logs?: z.infer<typeof connectorLogSchema>[];
  error?: string | null;
  duration?: number;
  runtime?: "e2b" | "local-fallback";
  runtimeError?: ConnectorRuntimeError;
};

interface ConnectorBuilderStore {
  connectors: Record<string, UserConnector[]>;
  instances: Record<string, ConnectorInstance[]>;
  executionHistory: Record<string, ConnectorExecution[]>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  selectedConnectorId: string | null;
  buildState: Record<string, ConnectorBuildState>;
  devRunState: Record<string, ConnectorDevRunState>;
  fetchConnectors: (workspaceId: string) => Promise<UserConnector[]>;
  fetchTemplates: (workspaceId: string) => Promise<ConnectorTemplateSummary[]>;
  createConnector: (
    workspaceId: string,
    input: {
      name: string;
      description?: string;
      code?: string;
      visibility?: "workspace" | "public";
    },
  ) => Promise<UserConnector>;
  createConnectorFromTemplate: (
    workspaceId: string,
    input: {
      templateId: string;
      name?: string;
      visibility?: "workspace" | "public";
    },
  ) => Promise<UserConnector>;
  updateConnector: (
    workspaceId: string,
    connectorId: string,
    input: Partial<{
      name: string;
      description: string;
      code: string;
      visibility: "workspace" | "public";
    }>,
  ) => Promise<UserConnector>;
  deleteConnector: (workspaceId: string, connectorId: string) => Promise<void>;
  buildConnector: (
    workspaceId: string,
    connectorId: string,
  ) => Promise<z.infer<typeof buildResponseSchema>>;
  devRun: (
    workspaceId: string,
    connectorId: string,
    input?: {
      config?: Record<string, unknown>;
      secrets?: Record<string, unknown>;
      state?: Record<string, unknown>;
      trigger?: {
        type?: "manual" | "webhook" | "schedule";
        payload?: unknown;
      };
    },
  ) => Promise<z.infer<typeof devRunResponseSchema>>;
  fetchInstances: (
    workspaceId: string,
    connectorId?: string,
  ) => Promise<ConnectorInstance[]>;
  createInstance: (
    workspaceId: string,
    input: {
      connectorId: string;
      name: string;
      secrets?: Record<string, unknown>;
      config?: Record<string, unknown>;
      output?: {
        destinationDatabaseId?: string;
        destinationSchema?: string;
        destinationTablePrefix?: string;
        evolutionMode?: "strict" | "append" | "variant" | "relaxed";
      };
      triggers?: Array<{
        type: "manual" | "schedule" | "webhook";
        enabled?: boolean;
        cron?: string;
        path?: string;
      }>;
      state?: Record<string, unknown>;
      status?: "idle" | "active" | "running" | "error" | "disabled";
    },
  ) => Promise<ConnectorInstance>;
  updateInstance: (
    workspaceId: string,
    instanceId: string,
    input: Partial<{
      connectorId: string;
      name: string;
      secrets: Record<string, unknown>;
      config: Record<string, unknown>;
      output: {
        destinationDatabaseId?: string;
        destinationSchema?: string;
        destinationTablePrefix?: string;
        evolutionMode?: "strict" | "append" | "variant" | "relaxed";
      };
      triggers: Array<{
        type: "manual" | "schedule" | "webhook";
        enabled?: boolean;
        cron?: string;
        path?: string;
      }>;
      state: Record<string, unknown>;
      status: "idle" | "active" | "running" | "error" | "disabled";
    }>,
  ) => Promise<ConnectorInstance>;
  deleteInstance: (
    workspaceId: string,
    instanceId: string,
    connectorId?: string,
  ) => Promise<void>;
  toggleInstance: (
    workspaceId: string,
    instanceId: string,
    connectorId?: string,
  ) => Promise<ConnectorInstance>;
  runInstance: (
    workspaceId: string,
    instanceId: string,
  ) => Promise<{ instanceId: string; eventId?: string; startedAt?: string }>;
  cancelInstanceRun: (
    workspaceId: string,
    instanceId: string,
  ) => Promise<{ instanceId: string; eventId?: string }>;
  fetchInstanceHistory: (
    workspaceId: string,
    instanceId: string,
  ) => Promise<ConnectorExecution[]>;
  selectConnector: (connectorId: string | null) => void;
}

function upsertConnector(
  connectors: UserConnector[],
  nextConnector: UserConnector,
): UserConnector[] {
  const index = connectors.findIndex(
    connector => connector._id === nextConnector._id,
  );
  if (index === -1) {
    return [nextConnector, ...connectors];
  }

  const next = [...connectors];
  next[index] = nextConnector;
  return next;
}

function upsertInstance(
  instances: ConnectorInstance[],
  nextInstance: ConnectorInstance,
): ConnectorInstance[] {
  const index = instances.findIndex(
    instance => instance._id === nextInstance._id,
  );
  if (index === -1) {
    return [nextInstance, ...instances];
  }

  const next = [...instances];
  next[index] = nextInstance;
  return next;
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}

function makeInstancesKey(workspaceId: string, connectorId?: string): string {
  return connectorId ? `${workspaceId}:${connectorId}` : `${workspaceId}:all`;
}

const connectorExecutionSchema = z.object({
  _id: z.string(),
  workspaceId: z.string(),
  connectorId: z.string(),
  instanceId: z.string(),
  triggerType: z.enum(["manual", "schedule", "webhook"]),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  runtime: z.enum(["e2b", "local-fallback"]).optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  rowCount: z.number().optional(),
  error: z
    .object({
      message: z.string().optional(),
      stack: z.string().optional(),
    })
    .optional(),
  logs: z
    .array(
      z.object({
        level: z.string(),
        message: z.string(),
        timestamp: z.string().optional(),
      }),
    )
    .default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const useConnectorBuilderStore = create<ConnectorBuilderStore>()(
  immer(set => ({
    connectors: {},
    instances: {},
    executionHistory: {},
    loading: {},
    error: {},
    selectedConnectorId: null,
    buildState: {},
    devRunState: {},

    fetchConnectors: async workspaceId => {
      set(state => {
        state.loading[workspaceId] = true;
        state.error[workspaceId] = null;
      });

      try {
        const response = await apiClient.get<{
          success: boolean;
          data: unknown[];
          error?: string;
        }>(`/workspaces/${workspaceId}/connector-builder/connectors`);

        if (!response.success) {
          throw new Error(response.error || "Failed to fetch connectors");
        }

        const connectors = z.array(connectorSchema).parse(response.data ?? []);
        set(state => {
          state.connectors[workspaceId] = connectors;
        });

        return connectors;
      } catch (error) {
        const message = normalizeError(error);
        set(state => {
          state.error[workspaceId] = message;
        });
        throw error;
      } finally {
        set(state => {
          delete state.loading[workspaceId];
        });
      }
    },

    fetchTemplates: async workspaceId => {
      const response = await apiClient.get<{
        success: boolean;
        data: ConnectorTemplateSummary[];
        error?: string;
      }>(`/workspaces/${workspaceId}/connector-builder/templates`);

      if (!response.success) {
        throw new Error(response.error || "Failed to fetch templates");
      }

      return response.data || [];
    },

    createConnector: async (workspaceId, input) => {
      const response = await apiClient.post<{
        success: boolean;
        data: unknown;
        error?: string;
      }>(`/workspaces/${workspaceId}/connector-builder/connectors`, input);

      if (!response.success) {
        throw new Error(response.error || "Failed to create connector");
      }

      const connector = connectorSchema.parse(response.data);
      set(state => {
        state.connectors[workspaceId] = upsertConnector(
          state.connectors[workspaceId] || [],
          connector,
        );
        state.selectedConnectorId = connector._id;
      });

      return connector;
    },

    createConnectorFromTemplate: async (workspaceId, input) => {
      const response = await apiClient.post<{
        success: boolean;
        data: unknown;
        error?: string;
      }>(
        `/workspaces/${workspaceId}/connector-builder/connectors/from-template`,
        input,
      );

      if (!response.success) {
        throw new Error(response.error || "Failed to create connector");
      }

      const connector = connectorSchema.parse(response.data);
      set(state => {
        state.connectors[workspaceId] = upsertConnector(
          state.connectors[workspaceId] || [],
          connector,
        );
        state.selectedConnectorId = connector._id;
      });
      return connector;
    },

    updateConnector: async (workspaceId, connectorId, input) => {
      const response = await apiClient.put<{
        success: boolean;
        data: unknown;
        error?: string;
      }>(
        `/workspaces/${workspaceId}/connector-builder/connectors/${connectorId}`,
        input,
      );

      if (!response.success) {
        throw new Error(response.error || "Failed to update connector");
      }

      const connector = connectorSchema.parse(response.data);
      set(state => {
        state.connectors[workspaceId] = upsertConnector(
          state.connectors[workspaceId] || [],
          connector,
        );
      });

      return connector;
    },

    deleteConnector: async (workspaceId, connectorId) => {
      const response = await apiClient.delete<{
        success: boolean;
        error?: string;
      }>(
        `/workspaces/${workspaceId}/connector-builder/connectors/${connectorId}`,
      );

      if (!response.success) {
        throw new Error(response.error || "Failed to delete connector");
      }

      set(state => {
        state.connectors[workspaceId] = (
          state.connectors[workspaceId] || []
        ).filter(connector => connector._id !== connectorId);
        delete state.instances[makeInstancesKey(workspaceId, connectorId)];
        if (state.selectedConnectorId === connectorId) {
          state.selectedConnectorId = null;
        }
      });
    },

    buildConnector: async (workspaceId, connectorId) => {
      set(state => {
        state.buildState[connectorId] = {
          ...state.buildState[connectorId],
          building: true,
        };
      });

      try {
        const response = await apiClient.post<{
          success: boolean;
          data: unknown;
          error?: string;
        }>(
          `/workspaces/${workspaceId}/connector-builder/connectors/${connectorId}/build`,
        );

        const parsed = buildResponseSchema.parse(response.data);
        if (!response.success) {
          set(state => {
            state.connectors[workspaceId] = upsertConnector(
              state.connectors[workspaceId] || [],
              parsed.connector,
            );
            state.buildState[connectorId] = {
              building: false,
              buildLog: parsed.build.buildLog,
              errors: parsed.build.errors,
            };
          });
          throw new Error(response.error || "Failed to build connector");
        }

        set(state => {
          state.connectors[workspaceId] = upsertConnector(
            state.connectors[workspaceId] || [],
            parsed.connector,
          );
          state.buildState[connectorId] = {
            building: false,
            buildLog: parsed.build.buildLog,
            errors: parsed.build.errors,
          };
        });

        return parsed;
      } catch (error: any) {
        const buildLog =
          error?.data?.build?.buildLog ||
          error?.message ||
          "Failed to build connector";
        const buildErrors = error?.data?.build?.errors;

        set(state => {
          state.buildState[connectorId] = {
            building: false,
            buildLog,
            errors: buildErrors,
          };
        });

        throw error;
      }
    },

    devRun: async (workspaceId, connectorId, input) => {
      set(state => {
        state.devRunState[connectorId] = {
          ...state.devRunState[connectorId],
          running: true,
          error: null,
          runtimeError: undefined,
        };
      });

      try {
        const response = await apiClient.post<{
          success: boolean;
          data: unknown;
          error?: string;
        }>(
          `/workspaces/${workspaceId}/connector-builder/connectors/${connectorId}/dev-run`,
          input,
        );

        const parsed = devRunResponseSchema.parse(response.data);
        if (!response.success) {
          set(state => {
            state.connectors[workspaceId] = upsertConnector(
              state.connectors[workspaceId] || [],
              parsed.connector,
            );
            state.buildState[connectorId] = {
              building: false,
              buildLog: parsed.build.buildLog,
              errors: parsed.build.errors,
            };
            state.devRunState[connectorId] = {
              ...state.devRunState[connectorId],
              running: false,
              error: response.error || "Failed to run connector",
              runtimeError: parsed.runtimeError,
            };
          });
          throw new Error(response.error || "Failed to run connector");
        }

        set(state => {
          state.connectors[workspaceId] = upsertConnector(
            state.connectors[workspaceId] || [],
            parsed.connector,
          );
          state.buildState[connectorId] = {
            building: false,
            buildLog: parsed.build.buildLog,
            errors: parsed.build.errors,
          };
          state.devRunState[connectorId] = {
            running: false,
            output: parsed.output,
            logs: parsed.logs,
            error: null,
            duration: parsed.durationMs,
            runtime: parsed.runtime,
            runtimeError: parsed.runtimeError,
          };
        });

        return parsed;
      } catch (error) {
        set(state => {
          state.devRunState[connectorId] = {
            ...state.devRunState[connectorId],
            running: false,
            error: normalizeError(error),
          };
        });
        throw error;
      }
    },

    fetchInstances: async (workspaceId, connectorId) => {
      const key = makeInstancesKey(workspaceId, connectorId);
      set(state => {
        state.loading[key] = true;
        state.error[key] = null;
      });

      try {
        const response = await apiClient.get<{
          success: boolean;
          data: unknown[];
          error?: string;
        }>(
          `/workspaces/${workspaceId}/connector-builder/instances`,
          connectorId ? { connectorId } : undefined,
        );

        if (!response.success) {
          throw new Error(response.error || "Failed to fetch instances");
        }

        const instances = z
          .array(connectorInstanceSchema)
          .parse(response.data ?? []);
        set(state => {
          state.instances[key] = instances;
        });
        return instances;
      } catch (error) {
        set(state => {
          state.error[key] = normalizeError(error);
        });
        throw error;
      } finally {
        set(state => {
          delete state.loading[key];
        });
      }
    },

    createInstance: async (workspaceId, input) => {
      const response = await apiClient.post<{
        success: boolean;
        data: unknown;
        error?: string;
      }>(`/workspaces/${workspaceId}/connector-builder/instances`, input);

      if (!response.success) {
        throw new Error(response.error || "Failed to create instance");
      }

      const instance = connectorInstanceSchema.parse(response.data);
      set(state => {
        const key = makeInstancesKey(workspaceId, instance.connectorId);
        state.instances[key] = upsertInstance(
          state.instances[key] || [],
          instance,
        );
      });
      return instance;
    },

    updateInstance: async (workspaceId, instanceId, input) => {
      const response = await apiClient.put<{
        success: boolean;
        data: unknown;
        error?: string;
      }>(
        `/workspaces/${workspaceId}/connector-builder/instances/${instanceId}`,
        input,
      );

      if (!response.success) {
        throw new Error(response.error || "Failed to update instance");
      }

      const instance = connectorInstanceSchema.parse(response.data);
      set(state => {
        const key = makeInstancesKey(workspaceId, instance.connectorId);
        state.instances[key] = upsertInstance(
          state.instances[key] || [],
          instance,
        );
      });
      return instance;
    },

    deleteInstance: async (workspaceId, instanceId, connectorId) => {
      const response = await apiClient.delete<{
        success: boolean;
        error?: string;
      }>(
        `/workspaces/${workspaceId}/connector-builder/instances/${instanceId}`,
      );

      if (!response.success) {
        throw new Error(response.error || "Failed to delete instance");
      }

      set(state => {
        if (connectorId) {
          const key = makeInstancesKey(workspaceId, connectorId);
          state.instances[key] = (state.instances[key] || []).filter(
            instance => instance._id !== instanceId,
          );
          return;
        }

        Object.keys(state.instances).forEach(key => {
          state.instances[key] = (state.instances[key] || []).filter(
            instance => instance._id !== instanceId,
          );
        });
      });
    },

    toggleInstance: async (workspaceId, instanceId, connectorId) => {
      const response = await apiClient.post<{
        success: boolean;
        data: unknown;
        error?: string;
      }>(
        `/workspaces/${workspaceId}/connector-builder/instances/${instanceId}/toggle`,
      );

      if (!response.success) {
        throw new Error(response.error || "Failed to toggle instance");
      }

      const instance = connectorInstanceSchema.parse(response.data);
      set(state => {
        const key = makeInstancesKey(
          workspaceId,
          connectorId || instance.connectorId,
        );
        state.instances[key] = upsertInstance(
          state.instances[key] || [],
          instance,
        );
      });
      return instance;
    },

    runInstance: async (workspaceId, instanceId) => {
      const response = await apiClient.post<{
        success: boolean;
        data: { instanceId: string; eventId?: string; startedAt?: string };
        error?: string;
      }>(
        `/workspaces/${workspaceId}/connector-builder/instances/${instanceId}/run`,
      );

      if (!response.success) {
        throw new Error(response.error || "Failed to run instance");
      }

      return response.data;
    },

    cancelInstanceRun: async (workspaceId, instanceId) => {
      const response = await apiClient.post<{
        success: boolean;
        data: { instanceId: string; eventId?: string };
        error?: string;
      }>(
        `/workspaces/${workspaceId}/connector-builder/instances/${instanceId}/cancel`,
      );

      if (!response.success) {
        throw new Error(response.error || "Failed to cancel instance run");
      }

      return response.data;
    },

    fetchInstanceHistory: async (workspaceId, instanceId) => {
      const key = `${workspaceId}:${instanceId}:history`;
      set(state => {
        state.loading[key] = true;
        state.error[key] = null;
      });

      try {
        const response = await apiClient.get<{
          success: boolean;
          data: unknown[];
          error?: string;
        }>(
          `/workspaces/${workspaceId}/connector-builder/instances/${instanceId}/history`,
        );

        if (!response.success) {
          throw new Error(
            response.error || "Failed to fetch execution history",
          );
        }

        const history = z
          .array(connectorExecutionSchema)
          .parse(response.data ?? []);
        set(state => {
          state.executionHistory[key] = history;
        });
        return history;
      } catch (error) {
        set(state => {
          state.error[key] = normalizeError(error);
        });
        throw error;
      } finally {
        set(state => {
          delete state.loading[key];
        });
      }
    },

    selectConnector: connectorId => {
      set(state => {
        state.selectedConnectorId = connectorId;
      });
    },
  })),
);
