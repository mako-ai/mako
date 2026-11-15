import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { api, unwrapBody } from "../api";
import {
  isLocalConnectionId,
  localAgentClient,
} from "../lib/local-agent-client";

import {
  indexedDBStorage,
  ensureWithDedup,
  makeNodeKey,
  fetchLocalConnections,
  mergeConnections,
} from "./schema/helpers";
import type {
  SchemaState,
  ConnectionWriters,
  Connection,
  TreeNode,
  DatabaseCollectionInfo,
  DatabaseViewInfo,
  ColumnInfo,
  AutocompleteSchema,
} from "./schema/types";

export type {
  ConnectionWriter,
  ConnectionRecentWriter,
  ConnectionWriters,
  Connection,
  TreeNode,
  DatabaseCollectionInfo,
  DatabaseViewInfo,
  ColumnInfo,
  AutocompleteSchema,
} from "./schema/types";

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
            // A refresh retries trees that failed to load (the explorer
            // skips errored roots until then).
            Object.keys(s.error)
              .filter(k => k.startsWith(`tree:${connId}:`))
              .forEach(k => delete s.error[k]);

            // Clear columns
            const columnKeysToDelete = Object.keys(s.columns).filter(k =>
              k.startsWith(`${connId}:`),
            );
            columnKeysToDelete.forEach(k => delete s.columns[k]);
          });
        });
      },

      createDemoDatabase: async (workspaceId: string) => {
        unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/databases/demo", {
            params: { path: { workspaceId } },
          }),
        );
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

      getConnectionWriters: async (workspaceId, connectionId) => {
        const res = unwrapBody(
          await api.GET(
            "/api/workspaces/{workspaceId}/databases/{id}/writers",
            { params: { path: { workspaceId, id: connectionId } } },
          ),
        ) as { success: boolean; data?: ConnectionWriters; error?: string };
        if (!res.success || !res.data) {
          throw new Error(res.error ?? "Couldn't load who can write.");
        }
        return res.data;
      },

      setConnectionWriters: async (workspaceId, connectionId, writers) => {
        const res = unwrapBody(
          await api.PUT(
            "/api/workspaces/{workspaceId}/databases/{id}/writers",
            {
              params: { path: { workspaceId, id: connectionId } },
              body: { writers },
            },
          ),
        ) as { success: boolean; error?: string };
        if (!res.success) throw new Error(res.error ?? "Couldn't save.");
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
      // Without a migrate, zustand logs an error on a version bump and
      // drops everything. Keep what is still valid; drop only the tree
      // cache the v3 bump was meant to invalidate.
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        if (version < 3) {
          const { treeNodes: _staleTrees, ...rest } = state;
          return { ...rest, treeNodes: {} } as never;
        }
        return state as never;
      },
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
