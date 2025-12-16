import { create } from "zustand";
import { persist, createJSONStorage, StateStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { get, set, del } from "idb-keyval";
import { apiClient } from "../lib/api-client";

// ============================================================================
// Types
// ============================================================================

/** Database connection/server */
export interface Connection {
  id: string;
  connectionId?: string;
  name: string;
  description: string;
  database: string;
  databaseName?: string;
  type: string;
  active: boolean;
  lastConnectedAt?: string;
  isClusterMode?: boolean;
  displayName: string;
  hostKey: string;
  hostName: string;
}

/** Tree node for databases, datasets, schemas, tables, etc. */
export interface TreeNode {
  id: string;
  label: string;
  kind: string;
  hasChildren?: boolean;
  icon?: string;
  metadata?: Record<string, unknown>;
}

/** Column information for autocomplete */
export interface ColumnInfo {
  name: string;
  type: string;
}

/** Autocomplete schema structure: dataset/schema -> table -> columns */
export type AutocompleteSchema = Record<string, Record<string, ColumnInfo[]>>;

// ============================================================================
// IndexedDB Storage Adapter
// ============================================================================

const indexedDBStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    return (await get(name)) || null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    await set(name, value);
  },
  removeItem: async (name: string): Promise<void> => {
    await del(name);
  },
};

// ============================================================================
// In-Flight Request Deduplication
// ============================================================================

const inFlight = new Map<string, Promise<unknown>>();

async function ensureWithDedup<T>(
  key: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fetcher().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

// ============================================================================
// Helper Functions
// ============================================================================

function makeNodeKey(node?: { id: string; kind: string }): string {
  if (!node) return "root";
  return `${node.kind}:${node.id}`;
}

// ============================================================================
// Store Types
// ============================================================================

interface SchemaState {
  // === Data ===
  /** workspaceId -> Connection[] */
  connections: Record<string, Connection[]>;

  /** connectionId -> nodeKey -> TreeNode[] (tree structure) */
  treeNodes: Record<string, Record<string, TreeNode[]>>;

  /** connectionId -> AutocompleteSchema (pre-loaded full schema for smaller databases) */
  autocompleteSchemas: Record<string, AutocompleteSchema>;

  /** connectionId:schemaId:tableId -> ColumnInfo[] */
  columns: Record<string, ColumnInfo[]>;

  // === Loading/Error State ===
  loading: Record<string, boolean>;
  error: Record<string, string | null>;

  // === Ensure Methods (return cached or fetch) ===
  ensureConnections: (workspaceId: string) => Promise<Connection[]>;
  ensureTreeRoot: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<TreeNode[]>;
  ensureTreeChildren: (
    workspaceId: string,
    connectionId: string,
    node: { id: string; kind: string; metadata?: Record<string, unknown> },
  ) => Promise<TreeNode[]>;
  ensureAutocompleteSchema: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<AutocompleteSchema | null>;
  ensureColumns: (
    workspaceId: string,
    connectionId: string,
    schemaId: string,
    tableId: string,
  ) => Promise<ColumnInfo[]>;

  // === Refresh Methods (force re-fetch) ===
  refreshConnections: (workspaceId: string) => Promise<Connection[]>;
  refreshTreeRoot: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<TreeNode[]>;
  refreshConnection: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<void>;

  // === Background Pre-loading ===
  preloadConnectionsAndDatabases: (workspaceId: string) => Promise<void>;

  // === Utility Methods ===
  getSchemaForAutocomplete: (connectionId: string) => AutocompleteSchema | null;
  clearConnectionData: (workspaceId: string) => void;
  deleteConnection: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<void>;

  // === Console Template ===
  fetchConsoleTemplate: (
    workspaceId: string,
    connectionId: string,
    node?: { id: string; kind: string; metadata?: Record<string, unknown> },
  ) => Promise<{ language: string; template: string } | null>;
}

// ============================================================================
// Store Implementation
// ============================================================================

export const useSchemaStore = create<SchemaState>()(
  persist(
    immer((set, get) => ({
      // === Initial State ===
      connections: {},
      treeNodes: {},
      autocompleteSchemas: {},
      columns: {},
      loading: {},
      error: {},

      // ========================================================================
      // Ensure Methods
      // ========================================================================

      ensureConnections: async (workspaceId: string) => {
        const cached = get().connections[workspaceId];
        if (cached) return cached;

        return ensureWithDedup(`connections:${workspaceId}`, async () => {
          const key = `connections:${workspaceId}`;
          set(s => {
            s.loading[key] = true;
            s.error[key] = null;
          });

          try {
            const res = await apiClient.get<{
              success: boolean;
              data: Connection[];
            }>(`/workspaces/${workspaceId}/databases`);

            if (res.success) {
              const connections = (res.data as Connection[]).sort((a, b) =>
                a.name.localeCompare(b.name),
              );
              set(s => {
                s.connections[workspaceId] = connections;
              });
              return connections;
            }
            return [];
          } catch (e: unknown) {
            const message =
              e instanceof Error ? e.message : "Failed to fetch connections";
            set(s => {
              s.error[key] = message;
            });
            return [];
          } finally {
            set(s => {
              delete s.loading[key];
            });
          }
        });
      },

      ensureTreeRoot: async (workspaceId: string, connectionId: string) => {
        const cached = get().treeNodes[connectionId]?.["root"];
        if (cached) return cached;

        return ensureWithDedup(`tree:${connectionId}:root`, async () => {
          const key = `tree:${connectionId}:root`;
          set(s => {
            s.loading[key] = true;
            s.error[key] = null;
          });

          try {
            const res = await apiClient.get<{
              success: boolean;
              data: TreeNode[];
            }>(`/workspaces/${workspaceId}/databases/${connectionId}/tree`);

            const data = res.success ? (res.data as TreeNode[]) : [];
            set(s => {
              s.treeNodes[connectionId] = s.treeNodes[connectionId] || {};
              s.treeNodes[connectionId]["root"] = data;
            });
            return data;
          } catch (e: unknown) {
            const message =
              e instanceof Error ? e.message : "Failed to load tree";
            set(s => {
              s.error[key] = message;
            });
            return [];
          } finally {
            set(s => {
              delete s.loading[key];
            });
          }
        });
      },

      ensureTreeChildren: async (
        workspaceId: string,
        connectionId: string,
        node: { id: string; kind: string; metadata?: Record<string, unknown> },
      ) => {
        const nodeKey = makeNodeKey(node);
        const cached = get().treeNodes[connectionId]?.[nodeKey];
        if (cached) return cached;

        return ensureWithDedup(`tree:${connectionId}:${nodeKey}`, async () => {
          const key = `tree:${connectionId}:${nodeKey}`;
          set(s => {
            s.loading[key] = true;
            s.error[key] = null;
          });

          try {
            const params = new URLSearchParams();
            params.set("nodeId", node.id);
            params.set("kind", node.kind);
            if (node.metadata) {
              params.set("metadata", JSON.stringify(node.metadata));
            }

            const res = await apiClient.get<{
              success: boolean;
              data: TreeNode[];
            }>(
              `/workspaces/${workspaceId}/databases/${connectionId}/tree?${params.toString()}`,
            );

            const data = res.success ? (res.data as TreeNode[]) : [];
            set(s => {
              s.treeNodes[connectionId] = s.treeNodes[connectionId] || {};
              s.treeNodes[connectionId][nodeKey] = data;
            });
            return data;
          } catch (e: unknown) {
            const message =
              e instanceof Error ? e.message : "Failed to load children";
            set(s => {
              s.error[key] = message;
            });
            return [];
          } finally {
            set(s => {
              delete s.loading[key];
            });
          }
        });
      },

      ensureAutocompleteSchema: async (
        workspaceId: string,
        connectionId: string,
      ) => {
        const cached = get().autocompleteSchemas[connectionId];
        if (cached) return cached;

        return ensureWithDedup(`autocomplete:${connectionId}`, async () => {
          const key = `autocomplete:${connectionId}`;
          set(s => {
            s.loading[key] = true;
            s.error[key] = null;
          });

          try {
            const res = await apiClient.get<{
              success: boolean;
              data: AutocompleteSchema;
            }>(
              `/workspaces/${workspaceId}/databases/${connectionId}/autocomplete`,
            );

            if (res.success && res.data) {
              const schema = res.data as AutocompleteSchema;
              set(s => {
                s.autocompleteSchemas[connectionId] = schema;
              });
              return schema;
            }
            return null;
          } catch (e: unknown) {
            // Autocomplete might not be supported
            console.warn(
              `Failed to fetch autocomplete data for ${connectionId}`,
              e,
            );
            return null;
          } finally {
            set(s => {
              delete s.loading[key];
            });
          }
        });
      },

      ensureColumns: async (
        workspaceId: string,
        connectionId: string,
        schemaId: string,
        tableId: string,
      ) => {
        const cacheKey = `${connectionId}:${schemaId}:${tableId}`;
        const cached = get().columns[cacheKey];
        if (cached) return cached;

        return ensureWithDedup(`columns:${cacheKey}`, async () => {
          const key = `columns:${cacheKey}`;
          set(s => {
            s.loading[key] = true;
            s.error[key] = null;
          });

          try {
            const params = new URLSearchParams();
            // API still uses datasetId for backwards compatibility
            params.set("datasetId", schemaId);
            params.set("tableId", tableId);
            params.set("limit", "500");

            const res = await apiClient.get<{
              success: boolean;
              data: {
                kind: "columns";
                datasetId: string;
                tableId: string;
                columns: ColumnInfo[];
              };
            }>(
              `/workspaces/${workspaceId}/databases/${connectionId}/autocomplete?${params.toString()}`,
            );

            const columns = res.success
              ? (res.data as { columns: ColumnInfo[] }).columns || []
              : [];

            set(s => {
              s.columns[cacheKey] = columns;
            });
            return columns;
          } catch (e: unknown) {
            const message =
              e instanceof Error ? e.message : "Failed to fetch columns";
            set(s => {
              s.error[key] = message;
            });
            return [];
          } finally {
            set(s => {
              delete s.loading[key];
            });
          }
        });
      },

      // ========================================================================
      // Refresh Methods
      // ========================================================================

      refreshConnections: async (workspaceId: string) => {
        // Clear connection data first
        get().clearConnectionData(workspaceId);

        // Force fetch
        const key = `connections:${workspaceId}`;
        set(s => {
          s.loading[key] = true;
          s.error[key] = null;
        });

        try {
          const res = await apiClient.get<{
            success: boolean;
            data: Connection[];
          }>(`/workspaces/${workspaceId}/databases`);

          if (res.success) {
            const connections = (res.data as Connection[]).sort((a, b) =>
              a.name.localeCompare(b.name),
            );
            set(s => {
              s.connections[workspaceId] = connections;
            });
            return connections;
          }
          return [];
        } catch (e: unknown) {
          const message =
            e instanceof Error ? e.message : "Failed to fetch connections";
          set(s => {
            s.error[key] = message;
          });
          return [];
        } finally {
          set(s => {
            delete s.loading[key];
          });
        }
      },

      refreshTreeRoot: async (workspaceId: string, connectionId: string) => {
        // Clear tree cache for this connection
        set(s => {
          delete s.treeNodes[connectionId];
        });

        // Force fetch
        const key = `tree:${connectionId}:root`;
        set(s => {
          s.loading[key] = true;
          s.error[key] = null;
        });

        try {
          const res = await apiClient.get<{
            success: boolean;
            data: TreeNode[];
          }>(`/workspaces/${workspaceId}/databases/${connectionId}/tree`);

          const data = res.success ? (res.data as TreeNode[]) : [];
          set(s => {
            s.treeNodes[connectionId] = s.treeNodes[connectionId] || {};
            s.treeNodes[connectionId]["root"] = data;
          });
          return data;
        } catch (e: unknown) {
          const message =
            e instanceof Error ? e.message : "Failed to load tree";
          set(s => {
            s.error[key] = message;
          });
          return [];
        } finally {
          set(s => {
            delete s.loading[key];
          });
        }
      },

      refreshConnection: async (workspaceId: string, connectionId: string) => {
        // Clear all cached data for this connection
        set(s => {
          delete s.treeNodes[connectionId];
          delete s.autocompleteSchemas[connectionId];

          // Clear columns for this connection
          const columnKeysToDelete = Object.keys(s.columns).filter(k =>
            k.startsWith(`${connectionId}:`),
          );
          columnKeysToDelete.forEach(k => delete s.columns[k]);
        });

        // Re-fetch tree root
        await get().ensureTreeRoot(workspaceId, connectionId);
      },

      // ========================================================================
      // Background Pre-loading
      // ========================================================================

      preloadConnectionsAndDatabases: async (workspaceId: string) => {
        // First, load connections
        const connections = await get().ensureConnections(workspaceId);

        // Then, preload tree roots for each connection in the background
        // Use Promise.allSettled to continue even if some fail
        await Promise.allSettled(
          connections.map(conn => get().ensureTreeRoot(workspaceId, conn.id)),
        );
      },

      // ========================================================================
      // Utility Methods
      // ========================================================================

      getSchemaForAutocomplete: (connectionId: string) => {
        return get().autocompleteSchemas[connectionId] || null;
      },

      clearConnectionData: (workspaceId: string) => {
        const connections = get().connections[workspaceId] || [];
        const connectionIds = connections.map(c => c.id);

        if (connectionIds.length === 0) return;

        set(s => {
          connectionIds.forEach(connId => {
            delete s.treeNodes[connId];
            delete s.autocompleteSchemas[connId];

            // Clear columns
            const columnKeysToDelete = Object.keys(s.columns).filter(k =>
              k.startsWith(`${connId}:`),
            );
            columnKeysToDelete.forEach(k => delete s.columns[k]);
          });
        });
      },

      deleteConnection: async (workspaceId: string, connectionId: string) => {
        const res = await apiClient.delete<{ success: boolean }>(
          `/workspaces/${workspaceId}/databases/${connectionId}`,
        );

        if (res.success) {
          // Clear cached data for this connection
          set(s => {
            delete s.treeNodes[connectionId];
            delete s.autocompleteSchemas[connectionId];

            const columnKeysToDelete = Object.keys(s.columns).filter(k =>
              k.startsWith(`${connectionId}:`),
            );
            columnKeysToDelete.forEach(k => delete s.columns[k]);
          });

          // Refresh connections list
          await get().refreshConnections(workspaceId);
        }
      },

      fetchConsoleTemplate: async (
        workspaceId: string,
        connectionId: string,
        node?: { id: string; kind: string; metadata?: Record<string, unknown> },
      ) => {
        try {
          const params: Record<string, string> = {};
          if (node) {
            params.nodeId = node.id;
            params.kind = node.kind;
            if (node.metadata) {
              params.metadata = JSON.stringify(node.metadata);
            }
          }

          const res = await apiClient.get<{
            success: boolean;
            data: { language: string; template: string };
          }>(
            `/workspaces/${workspaceId}/databases/${connectionId}/console-template`,
            params,
          );

          if (res.success) {
            return res.data as { language: string; template: string };
          }
        } catch {
          // Fallback handled by caller
        }
        return null;
      },
    })),
    {
      name: "mako-schema-store",
      version: 1,
      storage: createJSONStorage(() => indexedDBStorage),
      partialize: state => ({
        // Only persist the data, not loading/error states
        connections: state.connections,
        treeNodes: state.treeNodes,
        autocompleteSchemas: state.autocompleteSchemas,
        columns: state.columns,
      }),
    },
  ),
);
