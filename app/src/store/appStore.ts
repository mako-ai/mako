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
  renameApp: (
    workspaceId: string,
    appId: string,
    title: string,
  ) => Promise<void>;
  /**
   * Share an app to the workspace (or make it private again). Moves the app
   * between the "My Apps" / "Workspace" explorer sections optimistically and
   * persists the access change; refetches the list on failure.
   */
  setAppAccess: (
    workspaceId: string,
    appId: string,
    access: "private" | "workspace",
  ) => Promise<void>;

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
  updateBinding: (
    appId: string,
    bindingId: string,
    patch: Partial<Omit<AppDataBinding, "id" | "cache">>,
  ) => void;
  removeDataBinding: (appId: string, bindingId: string) => void;
  setRuntime: (appId: string, runtime: "cdn" | "webcontainer") => void;

  bumpPreview: (appId: string) => void;
  setPreviewErrors: (appId: string, errors: AppPreviewError[]) => void;

  runBinding: (
    workspaceId: string,
    appId: string,
    bindingName: string,
  ) => Promise<{ success: boolean; rows?: unknown[]; error?: string }>;

  /**
   * Queue a parquet binding build (server-side, background) and poll until it
   * is ready, fails, or the bounded wait elapses. Never hangs: `timeoutMs`
   * caps the wait and `signal` aborts the polling (the build itself keeps
   * running server-side either way).
   */
  materializeBinding: (
    workspaceId: string,
    appId: string,
    bindingId: string,
    options?: { force?: boolean; signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<{
    success: boolean;
    status: "ready" | "building" | "error";
    error?: string;
  }>;

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

const MATERIALIZE_POLL_INTERVAL_MS = 2500;
const MATERIALIZE_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface BindingMaterializationStatus {
  status: "missing" | "queued" | "building" | "ready" | "error";
  error?: string | null;
  rowCount?: number;
  artifactRevision?: string;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
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

    renameApp: async (workspaceId, appId, title) => {
      let appEntity: AppEntity | undefined = get().openApps[appId];
      if (!appEntity) {
        appEntity = (await get().fetchApp(workspaceId, appId)) ?? undefined;
      }
      if (!appEntity) return;
      set(state => {
        const current = state.openApps[appId];
        if (current) current.title = title;
      });
      await get().persistApp(workspaceId, appId);
      void get().fetchList(workspaceId);
    },

    setAppAccess: async (workspaceId, appId, access) => {
      const fromKey = access === "workspace" ? "myApps" : "workspaceApps";
      const toKey = access === "workspace" ? "workspaceApps" : "myApps";

      let moved = false;
      set(state => {
        const fromList = state[fromKey][workspaceId] || [];
        const index = fromList.findIndex(item => item.id === appId);
        if (index === -1) return; // already in the target section
        const [item] = fromList.splice(index, 1);
        item.access = access;
        const toList = state[toKey][workspaceId] || [];
        toList.unshift(item);
        state[toKey][workspaceId] = toList;
        const open = state.openApps[appId];
        if (open) open.access = access;
        moved = true;
      });
      if (!moved) return;

      try {
        await apiClient.put<{ success: boolean; app: AppEntity }>(
          `/workspaces/${workspaceId}/apps/${appId}`,
          { access },
        );
      } catch {
        // Revert to server truth on failure.
        void get().fetchList(workspaceId);
        set(state => {
          state.error[workspaceId] = "Failed to update app sharing";
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

    removeDataBinding: (appId, bindingId) => {
      set(state => {
        const appEntity = state.openApps[appId];
        if (!appEntity) return;
        appEntity.dataBindings = appEntity.dataBindings.filter(
          b => b.id !== bindingId,
        );
      });
      get().bumpPreview(appId);
    },

    updateBinding: (appId, bindingId, patch) => {
      set(state => {
        const appEntity = state.openApps[appId];
        if (!appEntity) return;
        const binding = appEntity.dataBindings.find(b => b.id === bindingId);
        if (!binding) return;
        Object.assign(binding, patch);
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
        materialization: binding.materialization || "live",
        cache: binding.cache,
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

    materializeBinding: async (workspaceId, appId, bindingId, options) => {
      const signal = options?.signal;
      const timeoutMs = options?.timeoutMs ?? MATERIALIZE_DEFAULT_TIMEOUT_MS;
      const base = `/workspaces/${workspaceId}/apps/${appId}/bindings/${bindingId}`;

      // Mirror the server-reported status onto the open app so UI chips
      // (binding editor, explorer) update live while the build runs.
      const setLocalStatus = (
        status: BindingMaterializationStatus["status"],
        error?: string | null,
      ) => {
        set(state => {
          const binding = state.openApps[appId]?.dataBindings.find(
            b => b.id === bindingId,
          );
          if (!binding) return;
          binding.cache = {
            ...(binding.cache ?? {}),
            parquetBuildStatus: status,
            parquetLastError: error ?? null,
          };
        });
      };

      const finishReady = async () => {
        await get().fetchApp(workspaceId, appId);
        get().bumpPreview(appId);
        return { success: true, status: "ready" as const };
      };

      try {
        const res = await apiClient.post<{
          success: boolean;
          queued?: boolean;
          status?: { status: string; error?: string };
          app?: AppEntity;
          error?: string;
        }>(
          `${base}/materialize`,
          options?.force ? { force: true } : undefined,
          { signal },
        );
        if (!res.success) {
          const error =
            res.status?.error || res.error || "Materialization failed";
          setLocalStatus("error", error);
          return { success: false, status: "error", error };
        }
        // Cache hit — artifact already built, nothing queued.
        if (res.status?.status === "ready") {
          if (res.app) {
            set(state => {
              state.openApps[appId] = res.app as AppEntity;
            });
            get().bumpPreview(appId);
            return { success: true, status: "ready" };
          }
          return await finishReady();
        }

        setLocalStatus(
          res.status?.status === "building" ? "building" : "queued",
        );

        // Poll the status endpoint until the background build terminates,
        // the bounded wait elapses, or the caller aborts.
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await abortableSleep(MATERIALIZE_POLL_INTERVAL_MS, signal);
          const poll = await apiClient.get<{
            success: boolean;
            data?: BindingMaterializationStatus;
          }>(`${base}/materialization`, undefined, { signal });
          const data = poll.data;
          if (!data) continue;
          setLocalStatus(data.status, data.error);
          if (data.status === "ready") {
            return await finishReady();
          }
          if (data.status === "error") {
            return {
              success: false,
              status: "error",
              error: data.error || "Materialization failed",
            };
          }
        }
        return {
          success: false,
          status: "building",
          error:
            "Materialization is still running in the background; it will finish server-side.",
        };
      } catch (e) {
        if (isAbortError(e)) {
          return {
            success: false,
            status: "building",
            error:
              "Stopped waiting; materialization continues in the background.",
          };
        }
        const error = e instanceof Error ? e.message : "Materialization failed";
        setLocalStatus("error", error);
        return { success: false, status: "error", error };
      }
    },

    reset: () => set(() => ({ ...initialState })),
  })),
);
