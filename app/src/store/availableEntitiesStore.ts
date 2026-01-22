import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";

interface AvailableEntitiesState {
  byConnector: Record<string, string[]>; // key = `${workspaceId}:${connectorId}`
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  fetch: (
    workspaceId: string,
    connectorId: string,
    force?: boolean,
  ) => Promise<string[]>;
  clear: (workspaceId: string, connectorId: string) => void;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

function makeKey(workspaceId: string, connectorId: string) {
  return `${workspaceId}:${connectorId}`;
}

export const useAvailableEntitiesStore = create<AvailableEntitiesState>()(
  immer((set, get) => ({
    byConnector: {},
    loading: {},
    error: {},
    fetch: async (workspaceId, connectorId, force = false) => {
      const key = makeKey(workspaceId, connectorId);

      // Return cached unless forcing
      const cached = get().byConnector[key];
      if (cached && !force) return cached;

      set(state => {
        state.loading[key] = true;
        state.error[key] = null;
      });

      try {
        const json = await apiClient.get<ApiResponse<string[]>>(
          `/workspaces/${workspaceId}/connectors/${connectorId}/entities`,
        );
        if (json.success) {
          const list: string[] = json.data || [];
          set(state => {
            state.byConnector[key] = list;
            delete state.loading[key];
            state.error[key] = null;
          });
          return list;
        }
        throw new Error(json.error || "Failed to fetch entities");
      } catch (err: any) {
        set(state => {
          state.error[key] = err?.message || "Failed to fetch entities";
          delete state.loading[key];
        });
        return [];
      }
    },
    clear: (workspaceId, connectorId) =>
      set(state => {
        const key = makeKey(workspaceId, connectorId);
        delete state.byConnector[key];
        delete state.loading[key];
        delete state.error[key];
      }),
  })),
);
