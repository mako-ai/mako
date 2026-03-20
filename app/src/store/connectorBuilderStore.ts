import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { z } from "zod";
import { apiClient } from "../lib/api-client";

const connectorBuildErrorSchema = z.object({
  message: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
  raw: z.string().optional(),
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
  output: connectorOutputSchema,
  logs: z.array(connectorLogSchema).default([]),
  durationMs: z.number(),
  runtime: z.enum(["e2b", "local-fallback"]),
});

export type UserConnector = z.infer<typeof connectorSchema>;
export type ConnectorOutput = z.infer<typeof connectorOutputSchema>;
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
};

interface ConnectorBuilderStore {
  connectors: Record<string, UserConnector[]>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  selectedConnectorId: string | null;
  buildState: Record<string, ConnectorBuildState>;
  devRunState: Record<string, ConnectorDevRunState>;
  fetchConnectors: (workspaceId: string) => Promise<UserConnector[]>;
  createConnector: (
    workspaceId: string,
    input: {
      name: string;
      description?: string;
      code?: string;
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

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}

export const useConnectorBuilderStore = create<ConnectorBuilderStore>()(
  immer(set => ({
    connectors: {},
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

    selectConnector: connectorId => {
      set(state => {
        state.selectedConnectorId = connectorId;
      });
    },
  })),
);
