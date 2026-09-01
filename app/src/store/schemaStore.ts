import { create } from "zustand";
import { persist, createJSONStorage, StateStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { get, set, del } from "idb-keyval";
import { api, unwrapBody } from "../api";
import {
  isLocalConnectionId,
  localAgentClient,
} from "../lib/local-agent-client";

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
  isDemo?: boolean;
  /** True when served by the Mako Local Agent on this machine. */
  isLocal?: boolean;
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

export interface DatabaseCollectionInfo {
  name: string;
  type: string;
  options?: {
    capped?: boolean;
    [key: string]: unknown;
  };
  info?: unknown;
}

export interface DatabaseViewInfo {
  name: string;
  type: string;
  options: {
    viewOn?: string;
    pipeline?: unknown[];
    [key: string]: unknown;
  };
  info?: unknown;
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

/**
 * Local connections registered with the Mako Local Agent. Returns [] when the
 * agent is not running so cloud connections are unaffected.
 */
async function fetchLocalConnections(): Promise<Connection[]> {
  try {
    const res = await localAgentClient.get<{
      success: boolean;
      data: Connection[];
    }>("/connections", undefined, { timeoutMs: 2000 });
    return res.success ? res.data : [];
  } catch {
    return [];
  }
}

function mergeConnections(
  cloud: Connection[],
  local: Connection[],
): Connection[] {
  return [...cloud, ...local].sort((a, b) => a.name.localeCompare(b.name));
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
  testConnection: (
    workspaceId: string,
    payload: {
      type: string;
      connection: Record<string, unknown>;
      /**
       * Set when testing an edit of a saved connection: the form holds
       * sentinels in place of its secrets, and the API resolves them from
       * the stored row.
       */
      connectionId?: string;
    },
    options?: { local?: boolean },
  ) => Promise<{ success: boolean; error?: string }>;
  fetchDatabase: (
    workspaceId: string,
    databaseId: string,
  ) => Promise<unknown | null>;
  saveDatabase: (
    workspaceId: string,
    payload: Record<string, unknown>,
    databaseId?: string,
    options?: { local?: boolean; verifyBeforeSave?: boolean },
  ) => Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
    // Set by the cloud API when verifyBeforeSave is requested: the connection
    // test ran before persisting.
    verified?: boolean;
    // "connection_test_failed" when verifyBeforeSave rejected the save because
    // the pre-save connection test did not succeed (record NOT created).
    code?: string;
  }>;
  fetchCollections: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<DatabaseCollectionInfo[]>;
  fetchCollectionInfo: (
    workspaceId: string,
    connectionId: string,
    collectionName: string,
  ) => Promise<unknown | null>;
  fetchViews: (
    workspaceId: string,
    connectionId: string,
  ) => Promise<DatabaseViewInfo[]>;

  // === Console Template ===
  fetchConsoleTemplate: (
    workspaceId: string,
    connectionId: string,
    node?: { id: string; kind: string; metadata?: Record<string, unknown> },
  ) => Promise<{ language: string; template: string } | null>;

  // === Table Definition (DDL) ===
  fetchTableDefinition: (
    workspaceId: string,
    connectionId: string,
    params: { schema: string; table: string; database?: string },
  ) => Promise<{ definition?: string; error?: string }>;

  // === Table Existence Check ===
  checkTableExists: (
    workspaceId: string,
    connectionId: string,
    tableName: string,
    options?: { schema?: string; database?: string },
  ) => Promise<{
    exists: boolean;
    columns: Array<{ name: string; type: string; nullable?: boolean }>;
    supported?: boolean;
    error?: string;
  }>;
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
            const [apiRes, localConnections] = await Promise.all([
              api.GET("/api/workspaces/{workspaceId}/databases", {
                params: { path: { workspaceId } },
              }),
              fetchLocalConnections(),
            ]);
            const res = unwrapBody(apiRes) as {
              success: boolean;
              data: Connection[];
            };

            if (res.success) {
              const connections = mergeConnections(
                res.data as Connection[],
                localConnections,
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
            const res = isLocalConnectionId(connectionId)
              ? await localAgentClient.get<{
                  success: boolean;
                  data: TreeNode[];
                }>(`/connections/${connectionId}/tree`)
              : (unwrapBody(
                  await api.GET(
                    "/api/workspaces/{workspaceId}/databases/{id}/tree",
                    { params: { path: { workspaceId, id: connectionId } } },
                  ),
                ) as { success: boolean; data: TreeNode[] });

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
            const params: Record<string, string> = {
              nodeId: node.id,
              kind: node.kind,
            };
            if (node.metadata) {
              params.metadata = JSON.stringify(node.metadata);
            }

            const res = isLocalConnectionId(connectionId)
              ? await localAgentClient.get<{
                  success: boolean;
                  data: TreeNode[];
                }>(`/connections/${connectionId}/tree`, params)
              : (unwrapBody(
                  await api.GET(
                    "/api/workspaces/{workspaceId}/databases/{id}/tree",
                    {
                      params: {
                        path: { workspaceId, id: connectionId },
                        query: params,
                      },
                    },
                  ),
                ) as { success: boolean; data: TreeNode[] });

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
            const res = isLocalConnectionId(connectionId)
              ? await localAgentClient.get<{
                  success: boolean;
                  data: AutocompleteSchema;
                }>(`/connections/${connectionId}/autocomplete`)
              : (unwrapBody(
                  await api.GET(
                    "/api/workspaces/{workspaceId}/databases/{id}/autocomplete",
                    { params: { path: { workspaceId, id: connectionId } } },
                  ),
                ) as { success: boolean; data: AutocompleteSchema });

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

        // Incremental column fetch is a BigQuery-only cloud path; local
        // connections preload full schemas via ensureAutocompleteSchema.
        if (isLocalConnectionId(connectionId)) return [];

        return ensureWithDedup(`columns:${cacheKey}`, async () => {
          const key = `columns:${cacheKey}`;
          set(s => {
            s.loading[key] = true;
            s.error[key] = null;
          });

          try {
            const res = unwrapBody(
              await api.GET(
                "/api/workspaces/{workspaceId}/databases/{id}/autocomplete",
                {
                  params: {
                    path: { workspaceId, id: connectionId },
                    // API still uses datasetId for backwards compatibility
                    query: { datasetId: schemaId, tableId, limit: "500" },
                  },
                },
              ),
            ) as {
              success: boolean;
              data: {
                kind: "columns";
                datasetId: string;
                tableId: string;
                columns: ColumnInfo[];
              };
            };

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
          const [apiRes, localConnections] = await Promise.all([
            api.GET("/api/workspaces/{workspaceId}/databases", {
              params: { path: { workspaceId } },
            }),
            fetchLocalConnections(),
          ]);
          const res = unwrapBody(apiRes) as {
            success: boolean;
            data: Connection[];
          };

          if (res.success) {
            const connections = mergeConnections(
              res.data as Connection[],
              localConnections,
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
          const res = isLocalConnectionId(connectionId)
            ? await localAgentClient.get<{
                success: boolean;
                data: TreeNode[];
              }>(`/connections/${connectionId}/tree`)
            : (unwrapBody(
                await api.GET(
                  "/api/workspaces/{workspaceId}/databases/{id}/tree",
                  { params: { path: { workspaceId, id: connectionId } } },
                ),
              ) as { success: boolean; data: TreeNode[] });

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
        const res = isLocalConnectionId(connectionId)
          ? await localAgentClient.delete<{ success: boolean }>(
              `/connections/${connectionId}`,
            )
          : (unwrapBody(
              await api.DELETE("/api/workspaces/{workspaceId}/databases/{id}", {
                params: { path: { workspaceId, id: connectionId } },
              }),
            ) as { success: boolean });

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

      testConnection: async (workspaceId, payload, options) => {
        try {
          const res = options?.local
            ? await localAgentClient.post<{
                success: boolean;
                error?: string;
              }>("/test-connection", payload)
            : (unwrapBody(
                await api.POST(
                  "/api/workspaces/{workspaceId}/databases/test-connection",
                  { params: { path: { workspaceId } }, body: payload },
                ),
              ) as { success: boolean; error?: string });
          return res;
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error ? error.message : "Connection test failed",
          };
        }
      },

      fetchDatabase: async (workspaceId, databaseId) => {
        try {
          const res = isLocalConnectionId(databaseId)
            ? await localAgentClient.get<{
                success: boolean;
                data: unknown;
              }>(`/connections/${databaseId}`)
            : (unwrapBody(
                await api.GET("/api/workspaces/{workspaceId}/databases/{id}", {
                  params: { path: { workspaceId, id: databaseId } },
                }),
              ) as { success: boolean; data: unknown });

          return res.success ? res.data : null;
        } catch (error) {
          console.error("Failed to fetch database details:", error);
          return null;
        }
      },

      saveDatabase: async (workspaceId, payload, databaseId, options) => {
        try {
          const isLocalTarget =
            options?.local || isLocalConnectionId(databaseId);

          type SaveResponse = {
            success: boolean;
            data?: unknown;
            error?: string;
            verified?: boolean;
            code?: string;
          };
          let res: SaveResponse;
          if (isLocalTarget) {
            res = databaseId
              ? await localAgentClient.put<SaveResponse>(
                  `/connections/${databaseId}`,
                  payload,
                )
              : await localAgentClient.post<SaveResponse>(
                  "/connections",
                  payload,
                );
          } else {
            // The cloud API tests-before-save when verifyBeforeSave is set, so
            // pass it through in the request body.
            const body =
              options?.verifyBeforeSave === undefined
                ? payload
                : { ...payload, verifyBeforeSave: options.verifyBeforeSave };
            res = databaseId
              ? (unwrapBody(
                  await api.PUT(
                    "/api/workspaces/{workspaceId}/databases/{id}",
                    {
                      params: { path: { workspaceId, id: databaseId } },
                      body,
                    },
                  ),
                ) as SaveResponse)
              : (unwrapBody(
                  await api.POST("/api/workspaces/{workspaceId}/databases", {
                    params: { path: { workspaceId } },
                    body,
                  }),
                ) as SaveResponse);
          }

          if (res.success) {
            await get().refreshConnections(workspaceId);
          }

          return res;
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : "Failed to save database",
          };
        }
      },

      fetchCollections: async (workspaceId, connectionId) => {
        // Local-agent connections expose collections through the schema tree
        // only; the flat collections endpoint is not implemented yet.
        if (isLocalConnectionId(connectionId)) return [];
        const res = unwrapBody(
          await api.GET(
            "/api/workspaces/{workspaceId}/databases/{id}/collections",
            { params: { path: { workspaceId, id: connectionId } } },
          ),
        ) as {
          success: boolean;
          data: DatabaseCollectionInfo[];
          error?: string;
        };

        if (!res.success) {
          throw new Error(res.error || "Failed to fetch collections");
        }

        return res.data;
      },

      fetchCollectionInfo: async (
        workspaceId,
        connectionId,
        collectionName,
      ) => {
        if (isLocalConnectionId(connectionId)) {
          throw new Error(
            "Collection details are not supported for local connections yet",
          );
        }
        const res = unwrapBody(
          await api.GET(
            "/api/workspaces/{workspaceId}/databases/{id}/collections/{name}/info",
            {
              params: {
                path: { workspaceId, id: connectionId, name: collectionName },
              },
            },
          ),
        ) as {
          success: boolean;
          data: unknown;
          error?: string;
        };

        if (!res.success) {
          throw new Error(res.error || "Failed to fetch collection info");
        }

        return res.data;
      },

      fetchViews: async (workspaceId, connectionId) => {
        if (isLocalConnectionId(connectionId)) return [];
        const res = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/databases/{id}/views", {
            params: { path: { workspaceId, id: connectionId } },
          }),
        ) as {
          success: boolean;
          data: DatabaseViewInfo[];
          error?: string;
        };

        if (!res.success) {
          throw new Error(res.error || "Failed to fetch views");
        }

        return res.data;
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

          const res = isLocalConnectionId(connectionId)
            ? await localAgentClient.get<{
                success: boolean;
                data: { language: string; template: string };
              }>(`/connections/${connectionId}/console-template`, params)
            : (unwrapBody(
                await api.GET(
                  "/api/workspaces/{workspaceId}/databases/{id}/console-template",
                  {
                    params: {
                      path: { workspaceId, id: connectionId },
                      query: params,
                    },
                  },
                ),
              ) as {
                success: boolean;
                data: { language: string; template: string };
              });

          if (res.success) {
            return res.data as { language: string; template: string };
          }
        } catch {
          // Fallback handled by caller
        }
        return null;
      },

      fetchTableDefinition: async (
        workspaceId: string,
        connectionId: string,
        params: { schema: string; table: string; database?: string },
      ) => {
        try {
          const query: Record<string, string> = {
            schema: params.schema,
            table: params.table,
          };
          if (params.database) query.database = params.database;

          const res = isLocalConnectionId(connectionId)
            ? await localAgentClient.get<{
                success: boolean;
                data?: { definition: string };
                error?: string;
              }>(`/connections/${connectionId}/table-definition`, query)
            : (unwrapBody(
                await api.GET(
                  "/api/workspaces/{workspaceId}/databases/{id}/table-definition",
                  {
                    params: {
                      path: { workspaceId, id: connectionId },
                      query,
                    },
                  },
                ),
              ) as {
                success: boolean;
                data?: { definition: string };
                error?: string;
              });

          if (res.success && res.data?.definition) {
            return { definition: res.data.definition };
          }
          return { error: res.error || "Failed to fetch table definition" };
        } catch (error) {
          return {
            error:
              error instanceof Error
                ? error.message
                : "Failed to fetch table definition",
          };
        }
      },

      checkTableExists: async (
        workspaceId: string,
        connectionId: string,
        tableName: string,
        options?: { schema?: string; database?: string },
      ) => {
        if (isLocalConnectionId(connectionId)) {
          return {
            exists: false,
            columns: [],
            supported: false,
            error: "Table checks are not supported for local connections yet",
          };
        }
        try {
          const params: Record<string, string> = { tableName };
          if (options?.schema) params.schema = options.schema;
          if (options?.database) params.database = options.database;

          const res = unwrapBody(
            await api.GET(
              "/api/workspaces/{workspaceId}/databases/{id}/table-exists",
              {
                params: {
                  path: { workspaceId, id: connectionId },
                  query: params,
                },
              },
            ),
          ) as {
            success: boolean;
            data: {
              exists: boolean;
              columns: Array<{
                name: string;
                type: string;
                nullable?: boolean;
              }>;
              supported?: boolean;
              message?: string;
            };
            error?: string;
          };

          if (res.success && res.data) {
            return {
              exists: res.data.exists,
              columns: res.data.columns || [],
              supported: res.data.supported,
            };
          }

          return {
            exists: false,
            columns: [],
            error: res.error || "Failed to check table existence",
          };
        } catch (error) {
          return {
            exists: false,
            columns: [],
            error:
              error instanceof Error
                ? error.message
                : "Failed to check table existence",
          };
        }
      },
    })),
    {
      name: "mako-schema-store",
      // v3: Postgres tables now expand to grouped folders (columns / keys /
      // indexes / triggers) instead of a flat column list; discard older
      // cached trees so stale children don't linger.
      version: 3,
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
