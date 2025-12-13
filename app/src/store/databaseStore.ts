import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";

export interface CollectionInfo {
  name: string;
  type: string;
  options: any;
}

/**
 * DatabaseConnection represents a saved connection to a database server.
 * When isClusterMode is true, the connection can access multiple databases.
 */
export interface DatabaseConnection {
  id: string;
  connectionId?: string; // Explicit connection ID (same as id) - optional for backward compat
  name: string;
  description: string;
  database: string; // Deprecated: use databaseName
  databaseName?: string; // Specific database within the server (if any)
  type: string;
  active: boolean;
  lastConnectedAt?: string;
  isClusterMode?: boolean; // true when connection can access multiple databases - optional for backward compat
  displayName: string;
  hostKey: string;
  hostName: string;
}

/** @deprecated Use DatabaseConnection instead */
export type Database = DatabaseConnection;

/** Tree node representing a database within a server connection */
export interface DatabaseTreeNode {
  id: string;
  label: string;
  kind: string;
  hasChildren: boolean;
  metadata?: Record<string, any>;
}

interface DatabaseState {
  databases: Record<string, DatabaseConnection[]>; // workspaceId => database connections array
  collections: Record<string, CollectionInfo[]>; // connectionId => collections
  views: Record<string, CollectionInfo[]>; // connectionId => views
  databasesInConnection: Record<string, DatabaseTreeNode[]>; // connectionId => databases within that connection
  autocompleteData: Record<string, Record<string, any>>; // connectionId => autocomplete data
  loading: Record<string, boolean>; // workspace or connection ids
  error: Record<string, string | null>;
  fetchServers: (workspaceId: string) => Promise<DatabaseConnection[]>;
  refreshServers: (workspaceId: string) => Promise<DatabaseConnection[]>;
  initServers: (workspaceId: string) => Promise<void>;
  fetchDatabaseData: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<void>;
  fetchDatabasesForConnection: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<DatabaseTreeNode[]>;
  fetchAutocompleteData: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<Record<string, any> | null>;
  clearDatabaseData: (workspaceId: string) => void;
  fetchDatabases: () => Promise<void>;
  deleteDatabase: (workspaceId: string, connectionId: string) => Promise<void>;
}

export const useDatabaseStore = create<DatabaseState>()(
  immer((set, get) => ({
    databases: {},
    collections: {},
    views: {},
    databasesInConnection: {},
    autocompleteData: {},
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
          data: DatabaseConnection[];
        }>(`/workspaces/${workspaceId}/databases`);
        if (data.success) {
          const databases = (data.data as DatabaseConnection[]).sort((a, b) =>
            a.name.localeCompare(b.name),
          );

          set(state => {
            state.databases[workspaceId] = databases;
          });
          return databases;
        }
        return [];
      } catch (err: any) {
        console.error("Failed to fetch database connections", err);
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
     * Fetches the list of databases within a server connection (for cluster mode).
     * Uses the tree endpoint to get root-level database nodes.
     */
    fetchDatabasesForConnection: async (workspaceId, connectionId) => {
      const loadingKey = `dbs-in:${connectionId}`;

      // Return cached if available
      const cached = get().databasesInConnection[connectionId];
      if (cached) return cached;

      set(state => {
        state.loading[loadingKey] = true;
      });
      try {
        const data = await apiClient.get<{
          success: boolean;
          data: DatabaseTreeNode[];
        }>(`/workspaces/${workspaceId}/databases/${connectionId}/tree`);

        if (data.success) {
          const nodes = data.data || [];
          set(state => {
            state.databasesInConnection[connectionId] = nodes;
          });
          return nodes;
        }
        return [];
      } catch (err) {
        console.error(
          `Failed to fetch databases for connection ${connectionId}`,
          err,
        );
        return [];
      } finally {
        set(state => {
          delete state.loading[loadingKey];
        });
      }
    },
    fetchAutocompleteData: async (workspaceId, connectionId) => {
      const loadingKey = `autocomplete:${connectionId}`;
      const cached = get().autocompleteData[connectionId];
      if (cached) return cached;

      set(state => {
        state.loading[loadingKey] = true;
      });

      try {
        const data = await apiClient.get<{
          success: boolean;
          data: Record<string, any>;
        }>(`/workspaces/${workspaceId}/databases/${connectionId}/autocomplete`);

        if (data.success) {
          const schema = data.data || {};
          set(state => {
            state.autocompleteData[connectionId] = schema;
          });
          return schema;
        }
        return null;
      } catch (err) {
        // Autocomplete might not be supported, so we just log warning
        console.warn(
          `Failed to fetch autocomplete data for connection ${connectionId}`,
          err,
        );
        return null;
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
          delete state.databasesInConnection[dbId];
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
