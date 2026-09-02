import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, unwrapBody } from "../api";
import { reconcileSourceConnectionTabs } from "../lib/source-connection-tabs";

interface SourceConnectionEntity {
  _id: string;
  name: string;
  description?: string;
  type: string;
  isActive: boolean;
  config: Record<string, unknown>;
  settings: Record<string, unknown>;
  targetDatabases?: string[];
  createdAt: string;
  updatedAt: string;
  workspaceId: string;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

interface EntitiesState {
  entities: Record<string, SourceConnectionEntity>; // key = `${workspaceId}:${connectorId}`
  loading: Record<string, boolean>; // key same as entities key
  fetchOne: (
    workspaceId: string,
    connectorId: string,
  ) => Promise<SourceConnectionEntity | null>;
  fetchAll: (workspaceId: string) => Promise<SourceConnectionEntity[]>;
  upsert: (entity: SourceConnectionEntity) => void;
  remove: (workspaceId: string, connectorId: string) => void;
  init: (workspaceId: string) => Promise<void>;
  refresh: (workspaceId: string) => Promise<SourceConnectionEntity[]>;
  create: (
    workspaceId: string,
    payload: Record<string, any>,
  ) => Promise<{ data: SourceConnectionEntity | null; error: string | null }>;
  update: (
    workspaceId: string,
    connectorId: string,
    payload: Record<string, any>,
  ) => Promise<{ data: SourceConnectionEntity | null; error: string | null }>;
  delete: (
    workspaceId: string,
    connectorId: string,
  ) => Promise<{ success: boolean; error: string | null }>;
}

function makeKey(workspaceId: string, connectorId: string) {
  return `${workspaceId}:${connectorId}`;
}

export const useSourceConnectionEntitiesStore = create<EntitiesState>()(
  immer((set, get) => ({
    entities: {},
    loading: {},
    fetchOne: async (workspaceId, connectorId) => {
      const key = makeKey(workspaceId, connectorId);
      let entity: SourceConnectionEntity | undefined;
      set(state => {
        entity = state.entities[key];
        if (!entity) state.loading[key] = true;
      });
      if (entity) return entity;
      try {
        const data = unwrapBody(
          await api.GET(
            "/api/workspaces/{workspaceId}/connections/sources/{id}",
            {
              params: { path: { workspaceId, id: connectorId } },
            },
          ),
        ) as ApiResponse<SourceConnectionEntity>;
        if (data.success) {
          const entity: SourceConnectionEntity = { ...data.data, workspaceId };
          set(state => {
            state.entities[key] = entity;
            delete state.loading[key];
          });
          return entity;
        }
      } catch (err) {
        console.error("Failed to fetch connector", err);
      } finally {
        set(state => {
          delete state.loading[key];
        });
      }
      return null;
    },
    fetchAll: async workspaceId => {
      set(state => {
        state.loading[workspaceId] = true;
      });

      try {
        const data = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/connections/sources", {
            params: { path: { workspaceId } },
          }),
        ) as ApiResponse<SourceConnectionEntity[]>;
        if (data.success) {
          set(state => {
            data.data.forEach(ds => {
              const key = makeKey(workspaceId, ds._id);
              state.entities[key] = { ...ds, workspaceId };
            });
          });
          // Persisted tabs outlive the row. Only after a successful list —
          // an empty set from a failed request would close every tab.
          reconcileSourceConnectionTabs(new Set(data.data.map(ds => ds._id)));
          return data.data;
        }
      } catch (err) {
        console.error("Failed to fetch source connections list", err);
      } finally {
        set(state => {
          delete state.loading[workspaceId];
        });
      }

      return [];
    },
    upsert: entity =>
      set(state => {
        const key = makeKey(entity.workspaceId, entity._id);
        state.entities[key] = entity;
      }),
    remove: (workspaceId, connectorId) =>
      set(state => {
        const key = makeKey(workspaceId, connectorId);
        delete state.entities[key];
      }),
    init: async (workspaceId: string) => {
      let hasEntities = false;
      set(state => {
        hasEntities = Object.values(state.entities).some(
          e => e.workspaceId === workspaceId,
        );
      });

      if (!hasEntities) {
        await get().fetchAll(workspaceId);
      }
    },
    refresh: async (workspaceId: string) => {
      return await get().fetchAll(workspaceId);
    },
    create: async (
      workspaceId: string,
      payload: Record<string, any>,
    ): Promise<{
      data: SourceConnectionEntity | null;
      error: string | null;
    }> => {
      try {
        const data = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/connections/sources", {
            params: { path: { workspaceId } },
            body: payload,
          }),
        ) as ApiResponse<SourceConnectionEntity>;
        if (data.success) {
          const entity: SourceConnectionEntity = {
            ...data.data,
            workspaceId,
          };
          set(state => {
            const key = makeKey(workspaceId, entity._id);
            state.entities[key] = entity;
          });
          return { data: entity, error: null };
        }
        return { data: null, error: data.error || "Failed to create" };
      } catch (err: any) {
        console.error("Create connector failed", err);
        return {
          data: null,
          error: err?.message || "Failed to create",
        };
      }
    },
    update: async (
      workspaceId: string,
      connectorId: string,
      payload: Record<string, any>,
    ): Promise<{
      data: SourceConnectionEntity | null;
      error: string | null;
    }> => {
      try {
        const data = unwrapBody(
          await api.PUT(
            "/api/workspaces/{workspaceId}/connections/sources/{id}",
            {
              params: { path: { workspaceId, id: connectorId } },
              body: payload,
            },
          ),
        ) as ApiResponse<SourceConnectionEntity>;
        if (data.success) {
          const entity: SourceConnectionEntity = {
            ...data.data,
            workspaceId,
          };
          set(state => {
            const key = makeKey(workspaceId, entity._id);
            state.entities[key] = entity;
          });
          return { data: entity, error: null };
        }
        return { data: null, error: data.error || "Failed to update" };
      } catch (err: any) {
        console.error("Update connector failed", err);
        return {
          data: null,
          error: err?.message || "Failed to update",
        };
      }
    },
    delete: async (
      workspaceId: string,
      connectorId: string,
    ): Promise<{ success: boolean; error: string | null }> => {
      try {
        const data = unwrapBody(
          await api.DELETE(
            "/api/workspaces/{workspaceId}/connections/sources/{id}",
            {
              params: { path: { workspaceId, id: connectorId } },
            },
          ),
        ) as ApiResponse<null>;
        if (data.success) {
          set(state => {
            const key = makeKey(workspaceId, connectorId);
            delete state.entities[key];
          });
          return { success: true, error: null };
        }
        return {
          success: false,
          error: data.error || "Failed to delete",
        };
      } catch (err: any) {
        console.error("Delete connector failed", err);
        return {
          success: false,
          error: err?.message || "Failed to delete",
        };
      }
    },
  })),
);

/** @deprecated use useSourceConnectionEntitiesStore */
export const useConnectorEntitiesStore = useSourceConnectionEntitiesStore;
