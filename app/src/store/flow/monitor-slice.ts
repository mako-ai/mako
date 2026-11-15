/**
 * Flow monitoring: webhook events, run status/logs, connectors and
 * query validation. Request-only actions (they return results).
 */
import { api, unwrapBody, toErrorMessage as normalizeError } from "../../api";
import type { ScheduledQueryListResponse } from "../../lib/api-types";
import type { FlowSlice } from "./slice";
import type {
  ConnectorInfo,
  ExecutionDetails,
  FlowMonitorActions,
  FlowStatusResponse,
  ProvisionedWebhook,
  WebhookEvent,
} from "./types";

export const createFlowMonitorSlice: FlowSlice<FlowMonitorActions> = set => ({
  fetchConnectors: async (workspaceId: string) => {
    const key = `connectors:${workspaceId}`;
    set(state => {
      state.loading[key] = true;
      state.error[key] = null;
    });

    try {
      const response = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/connections/sources", {
          params: { path: { workspaceId } },
        }),
      ) as {
        success: boolean;
        data: ConnectorInfo[];
        error?: string;
      };

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

  fetchWebhookEvents: async (workspaceId, flowId, limit, offset, filters) => {
    try {
      const response = unwrapBody(
        await api.GET(
          "/api/workspaces/{workspaceId}/flows/{flowId}/webhook/events",
          {
            params: {
              path: { workspaceId, flowId },
              query: {
                limit: String(limit),
                offset: String(offset),
                ...(filters?.status ? { status: filters.status } : {}),
                ...(filters?.applyStatus
                  ? { applyStatus: filters.applyStatus }
                  : {}),
              },
            },
          },
        ),
      ) as {
        success: boolean;
        data: {
          total: number;
          events: WebhookEvent[];
        };
      };

      return response.success ? response.data : null;
    } catch (error) {
      console.error("Failed to fetch webhook events:", error);
      return null;
    }
  },

  fetchWebhookEventDetails: async (workspaceId, flowId, eventId) => {
    try {
      const response = unwrapBody(
        await api.GET(
          "/api/workspaces/{workspaceId}/flows/{flowId}/webhook/events/{eventId}",
          { params: { path: { workspaceId, flowId, eventId } } },
        ),
      ) as {
        success: boolean;
        data: unknown;
      };

      return response.success ? response.data : null;
    } catch (error) {
      console.error("Failed to fetch event details:", error);
      return null;
    }
  },

  retryAllFailedWebhookEvents: async (workspaceId, flowId) => {
    try {
      const response = unwrapBody(
        await api.POST(
          "/api/workspaces/{workspaceId}/flows/{flowId}/webhook/events/retry-all-failed",
          { params: { path: { workspaceId, flowId } } },
        ),
      ) as {
        success: boolean;
        data: { retried: number; total: number };
      };
      return response.success ? response.data : null;
    } catch (error) {
      console.error("Failed to retry all failed webhook events:", error);
      return null;
    }
  },

  retryWebhookEvent: async (workspaceId, flowId, eventId) => {
    try {
      const response = unwrapBody(
        await api.POST(
          "/api/workspaces/{workspaceId}/flows/{flowId}/webhook/events/{eventId}/retry",
          { params: { path: { workspaceId, flowId, eventId } } },
        ),
      ) as { success: boolean };
      return response.success;
    } catch (error) {
      console.error("Failed to retry webhook event:", error);
      return false;
    }
  },

  provisionFlowWebhook: async (workspaceId, flowId, options) => {
    try {
      const response = unwrapBody(
        await api.POST(
          "/api/workspaces/{workspaceId}/flows/{flowId}/webhook/provision",
          {
            params: { path: { workspaceId, flowId } },
            body: {
              verifySsl: options?.verifySsl,
              events: options?.events,
              publicBaseUrl: options?.publicBaseUrl,
            },
          },
        ),
      ) as {
        success: boolean;
        data: ProvisionedWebhook;
        error?: string;
      };
      if (!response.success) {
        throw new Error(response.error || "Failed to provision webhook");
      }
      return response.data;
    } catch (error) {
      console.error("Failed to provision webhook:", error);
      throw new Error(normalizeError(error), { cause: error });
    }
  },

  fetchFlowStatus: async (workspaceId, flowId) => {
    try {
      const response = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/flows/{flowId}/status", {
          params: { path: { workspaceId, flowId } },
        }),
      ) as {
        success: boolean;
        data: FlowStatusResponse;
      };

      return response.success ? response.data : null;
    } catch (error) {
      console.error("Failed to check flow status", error);
      return null;
    }
  },

  fetchExecutionDetails: async (workspaceId, flowId, executionId) => {
    try {
      const response = unwrapBody(
        await api.GET(
          "/api/workspaces/{workspaceId}/flows/{flowId}/executions/{executionId}",
          { params: { path: { workspaceId, flowId, executionId } } },
        ),
      ) as {
        success: boolean;
        data: ExecutionDetails;
      };

      return response.success ? response.data : null;
    } catch (error) {
      console.error("Failed to fetch execution details", error);
      return null;
    }
  },

  cancelFlowExecution: async (workspaceId, flowId, executionId) => {
    try {
      const response = unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/flows/{flowId}/cancel", {
          params: { path: { workspaceId, flowId } },
          body: { executionId },
        }),
      ) as {
        success: boolean;
        message?: string;
      };
      return response.success;
    } catch (error) {
      console.error("Failed to cancel flow execution", error);
      return false;
    }
  },

  validateDbQuery: async (workspaceId, connectionId, query, database) => {
    try {
      const response = unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/flows/validate-query", {
          params: { path: { workspaceId } },
          body: { connectionId, query, database },
        }),
      ) as {
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
      };

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
          error instanceof Error ? error.message : "Query validation failed",
      };
    }
  },

  fetchScheduledQueries: async workspaceId => {
    const response = unwrapBody(
      await api.GET("/api/workspaces/{workspaceId}/scheduled-queries", {
        params: { path: { workspaceId } },
      }),
    ) as ScheduledQueryListResponse;
    return response.scheduledQueries || [];
  },
});
