import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";

export interface ConnectorType {
  type: string;
  name: string;
  version: string;
  description: string;
  supportedEntities: string[];
}

export interface ConnectorSchemaResponse {
  fields: Array<any>;
  /** Schema for transfer-level queries (for connectors like GraphQL/PostHog) */
  transferQueries?: {
    label: string;
    required: boolean;
    fields: Array<any>;
  };
}

interface CatalogResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

interface CatalogState {
  types: ConnectorType[] | null;
  loading: boolean;
  error: string | null;
  schemas: Record<string, ConnectorSchemaResponse>;
  schemaLoading: Record<string, boolean>;
  /** Fetch types from the API (always fetches fresh data, not persisted) */
  fetchCatalog: (workspaceId: string, force?: boolean) => Promise<void>;
  /** Fetch schema for connector type (schemas are cached and persisted) */
  fetchSchema: (
    type: string,
    force?: boolean,
  ) => Promise<ConnectorSchemaResponse | null>;
  /** Clear types from memory (useful when logging out or switching workspaces) */
  clearTypes: () => void;
}

export const useConnectorCatalogStore = create<CatalogState>()(
  persist(
    immer((set, get) => ({
      types: null,
      loading: false,
      error: null,
      schemas: {},
      schemaLoading: {},
      fetchCatalog: async (_workspaceId: string, _force = false) => {
        // Always fetch fresh data from the API
        set(state => {
          state.loading = true;
          state.error = null;
        });
        try {
          const data =
            await apiClient.get<CatalogResponse<ConnectorType[]>>(
              "/connectors/types",
            );
          if (data.success) {
            set(state => {
              state.types = data.data;
              state.loading = false;
            });
          } else {
            set(state => {
              state.error = data.error || "Failed to load connector types";
              state.loading = false;
            });
          }
        } catch (err: any) {
          set(state => {
            state.error = err.message || "Failed to load connector types";
            state.loading = false;
          });
        }
      },
      fetchSchema: async (type: string, force = false) => {
        const stateSnapshot = get();
        if (stateSnapshot.schemas[type] && !force) {
          return stateSnapshot.schemas[type];
        }
        if (stateSnapshot.schemaLoading[type]) return null;

        set(state => {
          state.schemaLoading[type] = true;
        });

        try {
          const json = await apiClient.get<
            CatalogResponse<ConnectorSchemaResponse>
          >(`/connectors/${type}/schema`);
          if (json.success) {
            set(state => {
              state.schemas[type] = json.data;
              delete state.schemaLoading[type];
            });
            return json.data;
          }
        } catch (err) {
          console.error("Failed to fetch schema", err);
        } finally {
          set(state => {
            delete state.schemaLoading[type];
          });
        }
        return null;
      },
      clearTypes: () =>
        set(state => {
          state.types = null;
        }),
    })),
    {
      name: "connector-catalog-store",
      version: 2,
      partialize: state => ({ schemas: state.schemas }), // Only persist schemas, not types
    },
  ),
);
