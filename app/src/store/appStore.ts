/**
 * App Store
 *
 * State + persistence for the React Apps feature. Holds the per-workspace app
 * list (for the explorer), the full definitions of open apps (for tabs), and
 * the per-app preview status. Mutations to an open app update local state
 * optimistically and persist to the API.
 *
 * The data bridge (`runBinding`) executes a named data binding through Mako's
 * workspace-scoped execute endpoint — the generated app never sees DB
 * credentials.
 */

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";
import {
  normalizeAppFiles,
  type AppDataBinding,
  type AppFile,
} from "@mako/schemas";
import type { QueryExecuteResponse } from "../lib/api-types";

export interface AppEntity {
  _id: string;
  workspaceId: string;
  title: string;
  description?: string;
  template: string;
  runtime: "cdn" | "webcontainer";
  entrypoint: string;
  files: AppFile[];
  dependencies: Record<string, string>;
  dataBindings: AppDataBinding[];
  version: number;
  access: "private" | "workspace";
  owner_id?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppListItem {
  id: string;
  name: string;
  access: "private" | "workspace";
  owner_id?: string;
  fileCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface AppPreviewError {
  message: string;
  source?: "build" | "runtime";
  at: number;
}

interface AppState {
  myApps: Record<string, AppListItem[]>;
  workspaceApps: Record<string, AppListItem[]>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;

  openApps: Record<string, AppEntity>;
  activeAppId: string | null;

  /** Bumping the nonce forces the renderer to rebuild that app's preview. */
  previewNonce: Record<string, number>;
  previewErrors: Record<string, AppPreviewError[]>;
}

interface AppActions {
  fetchList: (workspaceId: string) => Promise<void>;
  fetchApp: (workspaceId: string, appId: string) => Promise<AppEntity | null>;
  createApp: (workspaceId: string, title: string) => Promise<AppEntity | null>;
  deleteApp: (workspaceId: string, appId: string) => Promise<boolean>;
  persistApp: (workspaceId: string, appId: string) => Promise<void>;

  setActiveApp: (appId: string | null) => void;

  writeFile: (appId: string, path: string, contents: string) => void;
  deleteFile: (appId: string, path: string) => void;
  renameFile: (appId: string, from: string, to: string) => void;
  addDependency: (appId: string, name: string, version?: string) => void;
  removeDependency: (appId: string, name: string) => void;
  addDataBinding: (
    appId: string,
    binding: Omit<AppDataBinding, "id"> & { id?: string },
  ) => AppDataBinding | null;
  setRuntime: (appId: string, runtime: "cdn" | "webcontainer") => void;

  bumpPreview: (appId: string) => void;
  setPreviewErrors: (appId: string, errors: AppPreviewError[]) => void;

  runBinding: (
    workspaceId: string,
    appId: string,
    bindingName: string,
  ) => Promise<{ success: boolean; rows?: unknown[]; error?: string }>;

  reset: () => void;
}

type AppStore = AppState & AppActions;

const initialState: AppState = {
  myApps: {},
  workspaceApps: {},
  loading: {},
  error: {},
  openApps: {},
  activeAppId: null,
  previewNonce: {},
  previewErrors: {},
};

function genId(): string {
  return Math.random().toString(36).slice(2, 12);
}

export const useAppStore = create<AppStore>()(
  immer((set, get) => ({
    ...initialState,

    fetchList: async workspaceId => {
      set(state => {
        state.loading[workspaceId] = true;
        state.error[workspaceId] = null;
      });
      try {
        const res = await apiClient.get<{
          success: boolean;
          myApps: AppListItem[];
          workspaceApps: AppListItem[];
          error?: string;
        }>(`/workspaces/${workspaceId}/apps`);
        set(state => {
          state.myApps[workspaceId] = res.myApps || [];
          state.workspaceApps[workspaceId] = res.workspaceApps || [];
          state.loading[workspaceId] = false;
        });
      } catch (e) {
        set(state => {
          state.loading[workspaceId] = false;
          state.error[workspaceId] =
            e instanceof Error ? e.message : "Failed to load apps";
        });
      }
    },

    fetchApp: async (workspaceId, appId) => {
      try {
        const res = await apiClient.get<{ success: boolean; app: AppEntity }>(
          `/workspaces/${workspaceId}/apps/${appId}`,
        );
        if (!res.success || !res.app) return null;
        set(state => {
          state.openApps[appId] = res.app;
          if (state.previewNonce[appId] === undefined) {
            state.previewNonce[appId] = 0;
          }
        });
        return res.app;
      } catch {
        return null;
      }
    },

    createApp: async (workspaceId, title) => {
      try {
        const { createAppScaffold } = await import("@mako/schemas");
        const scaffold = createAppScaffold(title || "Untitled App");
        const res = await apiClient.post<{ success: boolean; app: AppEntity }>(
          `/workspaces/${workspaceId}/apps`,
          scaffold,
        );
        if (!res.success || !res.app) return null;
        set(state => {
          state.openApps[res.app._id] = res.app;
          state.previewNonce[res.app._id] = 0;
        });
        void get().fetchList(workspaceId);
        return res.app;
      } catch {
        return null;
      }
    },

    deleteApp: async (workspaceId, appId) => {
      try {
        await apiClient.delete(`/workspaces/${workspaceId}/apps/${appId}`);
        set(state => {
          delete state.openApps[appId];
          delete state.previewNonce[appId];
          delete state.previewErrors[appId];
        });
        void get().fetchList(workspaceId);
        return true;
      } catch {
        return false;
      }
    },

    persistApp: async (workspaceId, appId) => {
      const appEntity = get().openApps[appId];
      if (!appEntity) return;
      try {
        const res = await apiClient.put<{ success: boolean; app: AppEntity }>(
          `/workspaces/${workspaceId}/apps/${appId}`,
          {
            title: appEntity.title,
            description: appEntity.description,
            runtime: appEntity.runtime,
            entrypoint: appEntity.entrypoint,
            files: appEntity.files,
            dependencies: appEntity.dependencies,
            dataBindings: appEntity.dataBindings,
          },
        );
        if (res.success && res.app) {
          set(state => {
            const current = state.openApps[appId];
            if (current) current.version = res.app.version;
          });
        }
      } catch {
        // Surface persistence failures as a preview error so they are visible.
        set(state => {
          state.previewErrors[appId] = [
            {
              message: "Failed to save app changes to the server.",
              source: "build",
              at: Date.now(),
            },
          ];
        });
      }
    },

    setActiveApp: appId =>
      set(state => {
        state.activeAppId = appId;
      }),

    writeFile: (appId, path, contents) => {
      set(state => {
        const appEntity = state.openApps[appId];
        if (!appEntity) return;
        appEntity.files = normalizeAppFiles([
          ...appEntity.files.filter(f => f.path !== path),
          { path, contents },
        ]);
      });
      get().bumpPreview(appId);
    },

    deleteFile: (appId, path) => {
      set(state => {
        const appEntity = state.openApps[appId];
        if (!appEntity) return;
        appEntity.files = appEntity.files.filter(f => f.path !== path);
      });
      get().bumpPreview(appId);
    },

    renameFile: (appId, from, to) => {
      set(state => {
        const appEntity = state.openApps[appId];
        if (!appEntity) return;
        const file = appEntity.files.find(f => f.path === from);
        if (!file) return;
        appEntity.files = normalizeAppFiles([
          ...appEntity.files.filter(f => f.path !== from && f.path !== to),
          { path: to, contents: file.contents },
        ]);
        if (appEntity.entrypoint === from) appEntity.entrypoint = to;
      });
      get().bumpPreview(appId);
    },

    addDependency: (appId, name, version) => {
      set(state => {
        const appEntity = state.openApps[appId];
        if (!appEntity) return;
        appEntity.dependencies = {
          ...appEntity.dependencies,
          [name]: version || "latest",
        };
      });
      get().bumpPreview(appId);
    },

    removeDependency: (appId, name) => {
      set(state => {
        const appEntity = state.openApps[appId];
        if (!appEntity) return;
        const next = { ...appEntity.dependencies };
        delete next[name];
        appEntity.dependencies = next;
      });
      get().bumpPreview(appId);
    },

    addDataBinding: (appId, binding) => {
      const id = binding.id || genId();
      const created: AppDataBinding = {
        id,
        name: binding.name,
        connectionId: binding.connectionId,
        language: binding.language || "sql",
        code: binding.code,
        databaseId: binding.databaseId,
        databaseName: binding.databaseName,
      };
      let ok = false;
      set(state => {
        const appEntity = state.openApps[appId];
        if (!appEntity) return;
        appEntity.dataBindings = [
          ...appEntity.dataBindings.filter(b => b.name !== created.name),
          created,
        ];
        ok = true;
      });
      if (!ok) return null;
      get().bumpPreview(appId);
      return created;
    },

    setRuntime: (appId, runtime) => {
      set(state => {
        const appEntity = state.openApps[appId];
        if (appEntity) appEntity.runtime = runtime;
      });
      get().bumpPreview(appId);
    },

    bumpPreview: appId =>
      set(state => {
        state.previewNonce[appId] = (state.previewNonce[appId] || 0) + 1;
      }),

    setPreviewErrors: (appId, errors) =>
      set(state => {
        state.previewErrors[appId] = errors;
      }),

    runBinding: async (workspaceId, appId, bindingName) => {
      const appEntity = get().openApps[appId];
      const binding = appEntity?.dataBindings.find(b => b.name === bindingName);
      if (!binding) {
        return {
          success: false,
          error: `No data binding named "${bindingName}"`,
        };
      }
      try {
        const { status, body } =
          await apiClient.postWithStatus<QueryExecuteResponse>(
            `/workspaces/${workspaceId}/execute`,
            {
              connectionId: binding.connectionId,
              query: binding.code,
              databaseId: binding.databaseId,
              databaseName: binding.databaseName,
              mode: "preview",
              source: "app_runtime",
            },
            { alsoOk: [400, 403] },
          );
        if (status === 400 || status === 403 || !body.success) {
          return { success: false, error: body.error || "Query failed" };
        }
        return { success: true, rows: body.rows || [] };
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : "Query failed",
        };
      }
    },

    reset: () => set(() => ({ ...initialState })),
  })),
);
