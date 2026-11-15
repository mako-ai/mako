/**
 * CDC (change-data-capture) controls and diagnostics for a flow.
 */
import { api, unwrapBody, toErrorMessage as normalizeError } from "../../api";
import { runFlowCommand, type FlowSlice } from "./slice";
import type { CdcStatus, FlowCdcActions } from "./types";

export const createFlowCdcSlice: FlowSlice<FlowCdcActions> = (set, get) => ({
  setSyncEngine: (workspaceId, flowId, syncEngine) =>
    runFlowCommand(
      set,
      workspaceId,
      "Failed to update sync engine",
      () =>
        api.POST("/api/workspaces/{workspaceId}/flows/{flowId}/sync-engine", {
          params: { path: { workspaceId, flowId } },
          body: { syncEngine },
        }),
      () => get().refresh(workspaceId),
    ),

  startCdcBackfill: (workspaceId, flowId, entities) =>
    runFlowCommand(set, workspaceId, "Failed to start CDC backfill", () =>
      api.POST(
        "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/backfill/start",
        {
          params: { path: { workspaceId, flowId } },
          body: entities?.length ? { entities } : undefined,
        },
      ),
    ),

  resetCdcEntityColumn: (workspaceId, flowId, params) =>
    runFlowCommand(set, workspaceId, "Failed to reset column", () =>
      api.POST(
        "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/reset-column",
        {
          params: { path: { workspaceId, flowId } },
          body: {
            entity: params.entity,
            column: params.column,
            forceReplay: params.forceReplay !== false,
            startBackfill: params.startBackfill !== false,
          },
        },
      ),
    ),

  resetCdcEntityTable: (workspaceId, flowId, entity) =>
    runFlowCommand(set, workspaceId, "Failed to reset entity table", () =>
      api.POST(
        "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/reset-entity",
        {
          params: { path: { workspaceId, flowId } },
          body: { entity },
        },
      ),
    ),

  startCdcStream: (workspaceId, flowId) =>
    runFlowCommand(set, workspaceId, "Failed to start CDC stream", () =>
      api.POST(
        "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/stream/start",
        { params: { path: { workspaceId, flowId } } },
      ),
    ),

  pauseCdcStream: (workspaceId, flowId) =>
    runFlowCommand(set, workspaceId, "Failed to pause CDC stream", () =>
      api.POST(
        "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/stream/pause",
        { params: { path: { workspaceId, flowId } } },
      ),
    ),

  pauseCdcFlow: (workspaceId, flowId) =>
    runFlowCommand(set, workspaceId, "Failed to pause CDC flow", () =>
      api.POST("/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/pause", {
        params: { path: { workspaceId, flowId } },
      }),
    ),

  cancelCdcBackfill: (workspaceId, flowId) =>
    runFlowCommand(set, workspaceId, "Failed to cancel CDC backfill", () =>
      api.POST(
        "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/backfill/cancel",
        { params: { path: { workspaceId, flowId } } },
      ),
    ),

  resumeCdcFlow: (workspaceId, flowId) =>
    runFlowCommand(set, workspaceId, "Failed to resume CDC flow", () =>
      api.POST("/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/resume", {
        params: { path: { workspaceId, flowId } },
      }),
    ),

  resyncCdcFlow: (workspaceId, flowId, options) =>
    runFlowCommand(set, workspaceId, "Failed to resync CDC flow", () =>
      api.POST("/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/resync", {
        params: { path: { workspaceId, flowId } },
        body: {
          deleteDestination: options?.deleteDestination === true,
          clearWebhookEvents: options?.clearWebhookEvents === true,
          ...(options?.entities && options.entities.length > 0
            ? { entities: options.entities }
            : {}),
        },
      }),
    ),

  recoverCdcFlow: (workspaceId, flowId, options) =>
    runFlowCommand(set, workspaceId, "Failed to recover CDC flow", () =>
      api.POST(
        "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/recover",
        {
          params: { path: { workspaceId, flowId } },
          body: {
            retryFailedMaterialization:
              options?.retryFailedMaterialization !== false,
            resumeBackfill: options?.resumeBackfill !== false,
            entity: options?.entity,
          },
        },
      ),
    ),

  recoverCdcStream: (workspaceId, flowId, options) =>
    runFlowCommand(set, workspaceId, "Failed to recover CDC stream", () =>
      api.POST(
        "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/recover-stream",
        {
          params: { path: { workspaceId, flowId } },
          body: {
            retryFailedMaterialization:
              options?.retryFailedMaterialization !== false,
            entity: options?.entity,
          },
        },
      ),
    ),

  recoverCdcBackfill: (workspaceId, flowId) =>
    runFlowCommand(set, workspaceId, "Failed to recover CDC backfill", () =>
      api.POST(
        "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/recover-backfill",
        { params: { path: { workspaceId, flowId } } },
      ),
    ),

  reprocessStaleEvents: (workspaceId, flowId) =>
    runFlowCommand(set, workspaceId, "Failed to reprocess stale events", () =>
      api.POST(
        "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/reprocess-stale",
        { params: { path: { workspaceId, flowId } } },
      ),
    ),

  retryFailedCdcMaterialization: (workspaceId, flowId, entity) =>
    runFlowCommand(
      set,
      workspaceId,
      "Failed to retry failed CDC materialization",
      () =>
        api.POST(
          "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/materialize/retry-failed",
          {
            params: { path: { workspaceId, flowId } },
            body: { entity },
          },
        ),
      () => get().refresh(workspaceId),
    ),

  fetchCdcStatus: async (workspaceId, flowId) => {
    try {
      const response = unwrapBody(
        await api.GET(
          "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/status",
          { params: { path: { workspaceId, flowId } } },
        ),
      ) as {
        success: boolean;
        data: CdcStatus;
        error?: string;
      };
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
      const response = unwrapBody(
        await api.GET(
          "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/destination-counts",
          { params: { path: { workspaceId, flowId } } },
        ),
      ) as {
        success: boolean;
        data: Record<string, number | null>;
      };
      return response.success ? response.data : null;
    } catch {
      return null;
    }
  },

  fetchEntitySchema: async (workspaceId, flowId, entity) => {
    try {
      const response = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/flows/{flowId}/schema", {
          params: { path: { workspaceId, flowId }, query: { entity } },
        }),
      ) as {
        success: boolean;
        data: {
          entity: string;
          fields: Record<
            string,
            { type: string; nullable?: boolean; required?: boolean }
          >;
        };
      };
      return response.success ? response.data : null;
    } catch {
      return null;
    }
  },

  fetchEntitySchemaHealth: async (workspaceId, flowId, entity) => {
    try {
      const response = unwrapBody(
        await api.GET(
          "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/schema-health",
          {
            params: {
              path: { workspaceId, flowId },
              query: entity ? { entity } : {},
            },
          },
        ),
      ) as {
        success: boolean;
        data: {
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
        };
      };
      return response.success ? response.data : null;
    } catch {
      return null;
    }
  },
});
