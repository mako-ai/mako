import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";

export interface CollectionInfo {
  name: string;
  type: string;
  options: any;
}

export interface Database {
  id: string;
  name: string;
  description: string;
  database: string;
  type: string;
  active: boolean;
  lastConnectedAt?: string;
  displayName: string;
  hostKey: string;
  hostName: string;
}

interface DatabaseState {
  databases: Record<string, Database[]>; // workspaceId => databases array
  collections: Record<string, CollectionInfo[]>; // databaseId => collections
  views: Record<string, CollectionInfo[]>; // databaseId => views
  loading: Record<string, boolean>; // workspace or database ids
  error: Record<string, string | null>;
  fetchServers: (workspaceId: string) => Promise<Database[]>;
  refreshServers: (workspaceId: string) => Promise<Database[]>;
  initServers: (workspaceId: string) => Promise<void>;
  fetchDatabaseData: (workspaceId: string, databaseId: string) => Promise<void>;
  clearDatabaseData: (workspaceId: string) => void;
  fetchDatabases: () => Promise<void>;
  deleteDatabase: (workspaceId: string, databaseId: string) => Promise<void>;
}

export const useDatabaseStore = create<DatabaseState>()(
  immer((set, get) => ({
    databases: {},
    collections: {},
    views: {},
    loading: {},
    error: {},
    fetchServers: async workspaceId => {
      set(state => {
        state.loading[workspaceId] = true;
        state.error[workspaceId] = null;
      });
      try {
        const data = await apiClient.get<{
          success: boolean;
          data: Database[];
        }>(`/workspaces/${workspaceId}/databases`);
        if (data.success) {
          const databases = (data.data as Database[]).sort((a, b) =>
            a.name.localeCompare(b.name),
          );

          set(state => {
            state.databases[workspaceId] = databases;
          });
          return databases;
        }
        return [];
      } catch (err: any) {
        console.error("Failed to fetch databases", err);
        set(state => {
          state.error[workspaceId] = err?.message || "Failed to fetch";
        });
        return [];
      } finally {
        set(state => {
          delete state.loading[workspaceId];
        });
      }
    },
    refreshServers: async workspaceId => {
      // Clear cached collections/views first so any new server state triggers fresh fetches
      get().clearDatabaseData(workspaceId);
      return await get().fetchServers(workspaceId);
    },
    initServers: async workspaceId => {
      const hasDatabases = !!get().databases[workspaceId];
      if (!hasDatabases) {
        await get().fetchServers(workspaceId);
      }
    },
    fetchDatabaseData: async (workspaceId, databaseId) => {
      // mark loading
      const loadingKey = `db:${databaseId}`;
      set(state => {
        state.loading[loadingKey] = true;
      });
      try {
        const [collectionsData, viewsData] = await Promise.all([
          apiClient.get<{
            success: boolean;
            data: CollectionInfo[];
          }>(`/workspaces/${workspaceId}/databases/${databaseId}/collections`),
          apiClient.get<{
            success: boolean;
            data: CollectionInfo[];
          }>(`/workspaces/${workspaceId}/databases/${databaseId}/views`),
        ]);
        if (collectionsData.success) {
          set(state => {
            state.collections[databaseId] = collectionsData.data.sort(
              (a: CollectionInfo, b: CollectionInfo) =>
                a.name.localeCompare(b.name),
            );
          });
        }
        if (viewsData.success) {
          set(state => {
            state.views[databaseId] = viewsData.data.sort(
              (a: CollectionInfo, b: CollectionInfo) =>
                a.name.localeCompare(b.name),
            );
          });
        }
      } catch (err) {
        console.error(`Failed to fetch database data for ${databaseId}`, err);
      } finally {
        set(state => {
          delete state.loading[loadingKey];
        });
      }
    },
    /**
     * Clears cached collections and views that belong to the provided workspace.
     * This is useful when refreshing the list of databases to ensure nested data
     * is fetched again and reflects the latest state on the server.
     */
    clearDatabaseData: (workspaceId: string) => {
      const databasesForWorkspace = get().databases[workspaceId] || [];
      const dbIdsToClear = databasesForWorkspace.map(db => db.id);

      if (dbIdsToClear.length === 0) return;

      set(state => {
        dbIdsToClear.forEach(dbId => {
          delete state.collections[dbId];
          delete state.views[dbId];
        });
      });
    },

    fetchDatabases: async () => {
      // This is a simplified method that just ensures we have databases loaded
      // It uses the already loaded databases from fetchServers
      const workspaceId = localStorage.getItem("activeWorkspaceId");
      if (workspaceId && !get().databases[workspaceId]) {
        await get().fetchServers(workspaceId);
      }
    },

    deleteDatabase: async (workspaceId: string, databaseId: string) => {
      const response = await apiClient.delete<{ success: boolean }>(
        `/workspaces/${workspaceId}/databases/${databaseId}`,
      );

      if (response.success) {
        // Refresh the databases list to reflect the deletion
        await get().refreshServers(workspaceId);
      }
    },
  })),
);
