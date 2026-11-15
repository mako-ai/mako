/**
 * Flow list + lifecycle: the persisted `flows`, `loading`, `error`,
 * `selectedFlowId` and `executionHistory` state.
 */
import {
  api,
  ApiError,
  unwrapBody,
  toErrorMessage as normalizeError,
} from "../../api";
import { initialFlowState } from "./initial-state";
import type { FlowSlice } from "./slice";
import type { Flow, FlowExecutionHistory, FlowListActions } from "./types";

export const createFlowListSlice: FlowSlice<FlowListActions> = (set, get) => ({
  fetchFlows: async (workspaceId: string) => {
    set(state => {
      state.loading[workspaceId] = true;
      state.error[workspaceId] = null;
    });

    try {
      const response = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/flows", {
          params: { path: { workspaceId } },
        }),
      ) as {
        success: boolean;
        data: Flow[];
        error?: string;
      };

      if (response.success) {
        set(state => {
          state.flows[workspaceId] = response.data || [];
          state.error[workspaceId] = null;
        });
        return response.data || [];
      } else {
        throw new Error(response.error || "Failed to fetch flows");
      }
    } catch (error: unknown) {
      // Writes 412 without GitHub; GET/list is an empty explorer
      // (disconnect or never linked). A sticky error left the sidebar
      // populated after unlink until a full reload.
      if (error instanceof ApiError && error.status === 412) {
        set(state => {
          state.flows[workspaceId] = [];
          state.error[workspaceId] = null;
        });
        return [];
      }
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

    // If no data exists, fetch it (blocking — nothing to render yet).
    if (!existingFlows || existingFlows.length === 0) {
      await get().refresh(workspaceId);
      return;
    }

    // Stale-while-revalidate: render the persisted flows immediately, but
    // always refresh in the background. The persisted copy can lag the API
    // payload (e.g. fields added to the list projection like
    // `backfillSchedule`, or state changed by schedulers/migrations), and
    // trigger/engine displays depend on those fields being current.
    void get().refresh(workspaceId);
  },

  createFlow: async (workspaceId: string, data: Partial<Flow>) => {
    set(state => {
      state.loading[workspaceId] = true;
      state.error[workspaceId] = null;
    });

    try {
      const response = unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/flows", {
          params: { path: { workspaceId } },
          body: data,
        }),
      ) as {
        success: boolean;
        data: Flow;
        error?: string;
      };

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
      const response = unwrapBody(
        await api.PUT("/api/workspaces/{workspaceId}/flows/{flowId}", {
          params: { path: { workspaceId, flowId } },
          body: data,
        }),
      ) as {
        success: boolean;
        data: Flow;
        error?: string;
      };

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
      const response = unwrapBody(
        await api.DELETE("/api/workspaces/{workspaceId}/flows/{flowId}", {
          params: { path: { workspaceId, flowId } },
        }),
      ) as {
        success: boolean;
        error?: string;
        message?: string;
      };

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
      const response = unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/flows/{flowId}/toggle", {
          params: { path: { workspaceId, flowId } },
        }),
      ) as {
        success: boolean;
        data: { enabled: boolean; message: string };
        error?: string;
      };

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
      const response = unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/flows/{flowId}/run", {
          params: { path: { workspaceId, flowId } },
        }),
      ) as {
        success: boolean;
        message?: string;
        data?: any;
        error?: string;
      };

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
      const response = unwrapBody(
        flow?.syncEngine === "cdc"
          ? await api.POST(
              "/api/workspaces/{workspaceId}/flows/{flowId}/sync-cdc/backfill/start",
              { params: { path: { workspaceId, flowId } } },
            )
          : await api.POST(
              "/api/workspaces/{workspaceId}/flows/{flowId}/backfill",
              { params: { path: { workspaceId, flowId } } },
            ),
      ) as {
        success: boolean;
        message?: string;
        error?: string;
      };

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

  fetchFlowHistory: async (workspaceId: string, flowId: string, limit) => {
    try {
      const response = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/flows/{flowId}/history", {
          params: {
            path: { workspaceId, flowId },
            query: limit ? { limit: String(limit) } : {},
          },
        }),
      ) as {
        success: boolean;
        data: { history: FlowExecutionHistory[] };
        error?: string;
      };

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

  fetchFlowDetails: async (workspaceId, flowId) => {
    try {
      const response = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/flows/{flowId}", {
          params: { path: { workspaceId, flowId } },
        }),
      ) as {
        success: boolean;
        data: Flow;
      };

      return response.success ? response.data : null;
    } catch (error) {
      console.error("Failed to fetch flow details:", error);
      return null;
    }
  },

  reset: () => {
    set(initialFlowState);
  },
});
