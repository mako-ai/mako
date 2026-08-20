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
import { api, ApiError, toLoadError, unwrapBody, type LoadError } from "../api";
import { apiClient } from "../lib/api-client";
import {
  containsDbtSchemaToken,
  normalizeAppFiles,
  resolveDbtSchemaToken,
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
  /** EntityVersion number last published (draft/published split). */
  publishedVersion?: number;
  publishedAt?: string;
  /** True when the working draft differs from the published version. */
  hasUnpublishedChanges?: boolean;
  access: "private" | "workspace";
  /** Role granted to workspace members when access is "workspace". */
  workspaceRole?: "viewer" | "editor";
  /** Per-user collaborators (viewer/editor). */
  sharedWith?: Array<{
    userId: string;
    role: "viewer" | "editor";
    addedAt?: string;
  }>;
  /** Public link sharing metadata (no secrets). */
  publicShare?: {
    enabled: boolean;
    token?: string;
    hasPassword?: boolean;
    createdAt?: string;
  };
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

/** dbt environment summary used by the preview environment switcher. */
export interface AppDbtEnvSummary {
  name: string;
  targetSchema: string;
  ownerUserId?: string;
}

export interface AppDbtEnvInfo {
  environments: AppDbtEnvSummary[];
  defaultEnvironment: string;
}

/**
 * Prod-like environment for `{{ dbt_schema }}` resolution: `prod` when it
 * exists, else the project default. Mirrors the server rule
 * (api/src/dbt/dbt-environments.service.ts) — published apps, materialized
 * artifacts, and public shares always resolve to this environment.
 */
export function prodLikeDbtEnvironment(info: AppDbtEnvInfo): string {
  return info.environments.some(env => env.name === "prod")
    ? "prod"
    : info.defaultEnvironment;
}

const previewDbtEnvStorageKey = (appId: string) =>
  `mako:appPreviewDbtEnv:${appId}`;

function readStoredPreviewDbtEnv(appId: string): string | null {
  try {
    return localStorage.getItem(previewDbtEnvStorageKey(appId));
  } catch {
    return null;
  }
}

/**
 * Per-user, per-app viewport override for the DRAFT PREVIEW (view state,
 * mirrors previewDbtEnv). The iframe is laid out at exactly this size so
 * media queries render the true mobile/tablet layout; null = fill the pane.
 */
export interface AppPreviewViewport {
  width: number;
  height: number;
  /** Named preset ("phone" / "tablet") or undefined for a custom size. */
  preset?: string;
}

const previewViewportStorageKey = (appId: string) =>
  `mako:appPreviewViewport:${appId}`;

function readStoredPreviewViewport(appId: string): AppPreviewViewport | null {
  try {
    const raw = localStorage.getItem(previewViewportStorageKey(appId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AppPreviewViewport>;
    if (
      typeof parsed.width === "number" &&
      typeof parsed.height === "number" &&
      parsed.width > 0 &&
      parsed.height > 0
    ) {
      return {
        width: parsed.width,
        height: parsed.height,
        ...(typeof parsed.preset === "string" ? { preset: parsed.preset } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

interface AppState {
  myApps: Record<string, AppListItem[]>;
  workspaceApps: Record<string, AppListItem[]>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;

  openApps: Record<string, AppEntity>;
  /**
   * Per-app load failure (404 / 403 / transport) from `fetchApp`. Views use
   * this to render "not found" / "no access" instead of loading forever.
   */
  openAppErrors: Record<string, LoadError>;
  activeAppId: string | null;

  /** Bumping the nonce forces the renderer to rebuild that app's preview. */
  previewNonce: Record<string, number>;
  /**
   * Bumping the nonce tells the renderer to reload DuckDB tables from the
   * latest artifacts, then post a data-refresh to the running preview (data
   * first, then UI — never a mid-flight iframe reboot).
   */
  dataRefreshNonce: Record<string, number>;
  previewErrors: Record<string, AppPreviewError[]>;
  /**
   * Preview lifecycle per app: "building" from bumpPreview until the iframe
   * bootstrap posts ready/error (which lands via setPreviewErrors — [] on
   * ready, non-empty on error). Undefined until the first build/report. The
   * run_app executor awaits this instead of sleeping a fixed delay.
   */
  previewStatus: Record<string, "building" | "ready" | "error">;

  /**
   * Per-user, per-app dbt environment override for the DRAFT PREVIEW only
   * (view state, persisted in localStorage — never part of the app
   * definition). null/undefined = default (prod). Published/shared viewers
   * are unaffected: server paths always resolve to prod.
   */
  previewDbtEnv: Record<string, string | null>;
  /** Cached dbt project environments for binding resolution (by projectId). */
  dbtEnvInfo: Record<string, AppDbtEnvInfo>;

  /**
   * Per-user, per-app preview viewport override (view state, persisted in
   * localStorage). null/undefined = fill the pane (desktop). AppRenderer
   * lays the iframe out at exactly this size (scaled to fit visually), so
   * media queries render the true responsive layout.
   */
  previewViewport: Record<string, AppPreviewViewport | null>;
}

interface AppActions {
  fetchList: (workspaceId: string) => Promise<void>;
  fetchApp: (workspaceId: string, appId: string) => Promise<AppEntity | null>;
  createApp: (workspaceId: string, title: string) => Promise<AppEntity | null>;
  deleteApp: (workspaceId: string, appId: string) => Promise<boolean>;
  persistApp: (workspaceId: string, appId: string) => Promise<void>;
  /**
   * Ask the server for an AI-suggested commit message for the app's pending
   * draft changes (diffed against the last saved version). Callers should
   * `persistApp` first so the server-side draft matches what's on screen.
   */
  generateSaveComment: (
    workspaceId: string,
    appId: string,
    signal?: AbortSignal,
  ) => Promise<{ comment: string | null; diff: string | null }>;
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
  /**
   * Ask the open preview to reload data into DuckDB and re-query — without
   * rebuilding the iframe. Used after an explicit binding refresh settles.
   */
  requestDataRefresh: (appId: string) => void;
  setPreviewErrors: (appId: string, errors: AppPreviewError[]) => void;

  /** Sync sharing settings updated by the ShareDialog into the open app. */
  applySharingChanges: (
    appId: string,
    changes: {
      access?: AppEntity["access"];
      workspaceRole?: AppEntity["workspaceRole"];
      publicShare?: AppEntity["publicShare"];
    },
  ) => void;

  runBinding: (
    workspaceId: string,
    appId: string,
    bindingName: string,
  ) => Promise<{ success: boolean; rows?: unknown[]; error?: string }>;

  /**
   * Switch which dbt environment the app's draft preview reads (per-user view
   * state). Pass null to reset to the default (prod). Bumps the preview so
   * data hooks re-run against the new schema.
   */
  setPreviewDbtEnvironment: (appId: string, environment: string | null) => void;

  /**
   * Switch the app preview's viewport (per-user view state; null = fill the
   * pane). No rebuild — the iframe resizes and the app re-lays out live.
   */
  setPreviewViewport: (
    appId: string,
    viewport: AppPreviewViewport | null,
  ) => void;

  /** Fetch (and cache) a dbt project's environments for binding resolution. */
  fetchDbtEnvInfo: (
    workspaceId: string,
    dbtProjectId: string,
  ) => Promise<AppDbtEnvInfo | null>;

  /**
   * Resolve `{{ dbt_schema }}` in dbt-linked binding code for the DRAFT
   * preview: the per-user preview override when set (and still valid), else
   * the prod-like environment. Non-linked / token-free code passes through.
   */
  resolveDbtCodeForPreview: (
    workspaceId: string,
    appId: string,
    dbtProjectId: string | undefined,
    code: string,
  ) => Promise<string>;

  /**
   * Queue a parquet binding build (server-side, background) and poll until it
   * is ready, fails, or the bounded wait elapses. Never hangs: `timeoutMs`
   * caps the wait and `signal` aborts the polling (the build itself keeps
   * running server-side either way).
   *
   * `refreshPreview` (default true) refetches the app and requests a
   * data-then-UI refresh (DuckDB load + data-refresh) when the binding
   * becomes ready. Bulk rematerialize passes false so the caller applies
   * data once after every binding settles.
   */
  materializeBinding: (
    workspaceId: string,
    appId: string,
    bindingId: string,
    options?: {
      force?: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
      refreshPreview?: boolean;
    },
  ) => Promise<{
    success: boolean;
    status: "ready" | "building" | "error";
    error?: string;
  }>;

  /**
   * (Re)materialize every parquet binding in an app in one shot. Runs each
   * binding's build concurrently through `materializeBinding` (force rebuild by
   * default) and returns an aggregate summary. Used by the "Rebuild data"
   * toolbar action to recover an app whose artifact cache was lost (e.g. a DB
   * restore) without deleting/recreating bindings.
   *
   * Does not bump the preview mid-flight — callers should load fresh DuckDB
   * tables and post a data-refresh (or bumpPreview) only after this resolves.
   * `onProgress` reports settled binding counts while builds are still running.
   */
  materializeAllBindings: (
    workspaceId: string,
    appId: string,
    options?: {
      force?: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
      onProgress?: (progress: {
        total: number;
        settled: number;
        ready: number;
        failed: number;
      }) => void;
    },
  ) => Promise<{
    total: number;
    ready: number;
    failed: number;
    errors: string[];
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
  openAppErrors: {},
  activeAppId: null,
  previewNonce: {},
  dataRefreshNonce: {},
  previewErrors: {},
  previewStatus: {},
  previewViewport: {},
  previewDbtEnv: {},
  dbtEnvInfo: {},
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

// One save pipeline per app. Calls made while a request is in flight coalesce
// into one follow-up write that snapshots the latest local state and uses the
// version returned by the accepted write.
const appSavePipelines = new Map<string, Promise<void>>();
const appSavePending = new Set<string>();

export const useAppStore = create<AppStore>()(
  immer((set, get) => ({
    ...initialState,

    fetchList: async workspaceId => {
      set(state => {
        state.loading[workspaceId] = true;
        state.error[workspaceId] = null;
      });
      try {
        const res = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps", {
            params: { path: { workspaceId } },
          }),
        ) as {
          success: boolean;
          myApps: AppListItem[];
          workspaceApps: AppListItem[];
          error?: string;
        };
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
        const res = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps/{id}", {
            params: { path: { workspaceId, id: appId } },
          }),
        ) as { success: boolean; app: AppEntity };
        if (!res.success || !res.app) {
          set(state => {
            state.openAppErrors[appId] = { message: "Failed to load app" };
          });
          return null;
        }
        set(state => {
          state.openApps[appId] = res.app;
          delete state.openAppErrors[appId];
          if (state.previewNonce[appId] === undefined) {
            state.previewNonce[appId] = 0;
          }
          // Hydrate the per-user preview dbt env override from localStorage
          // once per open app (view state survives reloads).
          if (state.previewDbtEnv[appId] === undefined) {
            state.previewDbtEnv[appId] = readStoredPreviewDbtEnv(appId);
          }
          if (state.previewViewport[appId] === undefined) {
            state.previewViewport[appId] = readStoredPreviewViewport(appId);
          }
        });
        return res.app;
      } catch (e) {
        set(state => {
          state.openAppErrors[appId] = toLoadError(e, "Failed to load app");
        });
        return null;
      }
    },

    createApp: async (workspaceId, title) => {
      try {
        const { createAppScaffold } = await import("@mako/schemas");
        const scaffold = createAppScaffold(title || "Untitled App");
        const res = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps", {
            params: { path: { workspaceId } },
            body: scaffold,
          }),
        ) as { success: boolean; app: AppEntity };
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
        unwrapBody(
          await api.DELETE("/api/workspaces/{workspaceId}/apps/{id}", {
            params: { path: { workspaceId, id: appId } },
          }),
        );
        set(state => {
          delete state.openApps[appId];
          delete state.openAppErrors[appId];
          delete state.previewNonce[appId];
          delete state.dataRefreshNonce[appId];
          delete state.previewErrors[appId];
          delete state.previewStatus[appId];
          delete state.previewViewport[appId];
        });
        void get().fetchList(workspaceId);
        return true;
      } catch {
        return false;
      }
    },

    persistApp: async (workspaceId, appId) => {
      const active = appSavePipelines.get(appId);
      if (active) {
        appSavePending.add(appId);
        return active;
      }

      const run = async () => {
        do {
          appSavePending.delete(appId);
          const appEntity = get().openApps[appId];
          if (!appEntity) return;
          try {
            const res = unwrapBody(
              await api.PUT("/api/workspaces/{workspaceId}/apps/{id}", {
                params: { path: { workspaceId, id: appId } },
                body: {
                  title: appEntity.title,
                  description: appEntity.description,
                  runtime: appEntity.runtime,
                  entrypoint: appEntity.entrypoint,
                  files: appEntity.files,
                  dependencies: appEntity.dependencies,
                  dataBindings: appEntity.dataBindings,
                  expectedVersion: appEntity.version,
                },
              }),
            ) as { success: boolean; app: AppEntity };
            if (!res.success || !res.app) return;
            set(state => {
              const current = state.openApps[appId];
              if (current) {
                current.version = res.app.version;
                // Autosave bumps the draft; mirror the server-computed publish
                // state so the preview toolbar's Publish button reflects whether
                // the draft now differs from the published version.
                current.publishedVersion = res.app.publishedVersion;
                current.publishedAt = res.app.publishedAt;
                current.hasUnpublishedChanges = res.app.hasUnpublishedChanges;
              }
            });
          } catch (error) {
            // A 409 is an external edit, not a transient request failure. Do
            // not retry stale local state over the newer server definition.
            if (error instanceof ApiError && error.status === 409) {
              appSavePending.delete(appId);
            }
            // Surface persistence failures as a preview error so they are visible.
            set(state => {
              state.previewErrors[appId] = [
                {
                  message:
                    error instanceof ApiError && error.status === 409
                      ? "App changed elsewhere. Reload it before saving again."
                      : "Failed to save app changes to the server.",
                  source: "build",
                  at: Date.now(),
                },
              ];
            });
            return;
          }
        } while (appSavePending.has(appId));
      };

      const pipeline = run().finally(() => {
        appSavePipelines.delete(appId);
      });
      appSavePipelines.set(appId, pipeline);
      return pipeline;
    },

    generateSaveComment: async (workspaceId, appId, signal) => {
      try {
        const res = unwrapBody(
          await api.POST(
            "/api/workspaces/{workspaceId}/apps/{id}/version-comment",
            {
              params: { path: { workspaceId, id: appId } },
              signal,
            },
          ),
        ) as { success: boolean; comment: string | null; diff: string | null };
        return res.success
          ? { comment: res.comment ?? null, diff: res.diff ?? null }
          : { comment: null, diff: null };
      } catch {
        return { comment: null, diff: null };
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
        unwrapBody(
          await api.PUT("/api/workspaces/{workspaceId}/apps/{id}", {
            params: { path: { workspaceId, id: appId } },
            body: { access },
          }),
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
        state.previewStatus[appId] = "building";
      }),

    requestDataRefresh: appId =>
      set(state => {
        state.dataRefreshNonce[appId] =
          (state.dataRefreshNonce[appId] || 0) + 1;
      }),

    applySharingChanges: (appId, changes) =>
      set(state => {
        const appEntity = state.openApps[appId];
        if (!appEntity) return;
        if (changes.access) appEntity.access = changes.access;
        if (changes.workspaceRole) {
          appEntity.workspaceRole = changes.workspaceRole;
        }
        if (changes.publicShare !== undefined) {
          appEntity.publicShare = changes.publicShare;
        }
      }),

    setPreviewErrors: (appId, errors) =>
      set(state => {
        state.previewErrors[appId] = errors;
        // The iframe bootstrap reports exactly one of ready ([]) or error
        // (non-empty), so error presence IS the settled preview status.
        state.previewStatus[appId] = errors.length > 0 ? "error" : "ready";
      }),

    setPreviewDbtEnvironment: (appId, environment) => {
      set(state => {
        state.previewDbtEnv[appId] = environment;
      });
      try {
        if (environment) {
          localStorage.setItem(previewDbtEnvStorageKey(appId), environment);
        } else {
          localStorage.removeItem(previewDbtEnvStorageKey(appId));
        }
      } catch {
        /* view state only — losing persistence is harmless */
      }
      // No preview bump here: AppRenderer watches this state and posts a
      // data-refresh into the booted iframe, so data hooks re-run against the
      // new schema without a (slow) srcdoc rebuild or losing app UI state.
    },

    setPreviewViewport: (appId, viewport) => {
      set(state => {
        state.previewViewport[appId] = viewport;
      });
      try {
        if (viewport) {
          localStorage.setItem(
            previewViewportStorageKey(appId),
            JSON.stringify(viewport),
          );
        } else {
          localStorage.removeItem(previewViewportStorageKey(appId));
        }
      } catch {
        /* view state only — losing persistence is harmless */
      }
      // No preview bump: resizing the iframe re-lays the app out live and
      // media queries re-evaluate — a rebuild would only add a flash.
    },

    fetchDbtEnvInfo: async (workspaceId, dbtProjectId) => {
      const cached = get().dbtEnvInfo[dbtProjectId];
      if (cached) return cached;
      try {
        const res = await apiClient.get<{
          success: boolean;
          project?: {
            environments?: AppDbtEnvSummary[];
            defaultEnvironment: string;
          };
        }>(`/workspaces/${workspaceId}/dbt/projects/${dbtProjectId}`);
        const project = res.project;
        if (!project) return null;
        const info: AppDbtEnvInfo = {
          environments: (project.environments ?? []).map(env => ({
            name: env.name,
            targetSchema: env.targetSchema,
            ownerUserId: env.ownerUserId,
          })),
          defaultEnvironment: project.defaultEnvironment,
        };
        set(state => {
          state.dbtEnvInfo[dbtProjectId] = info;
        });
        return info;
      } catch {
        return null;
      }
    },

    resolveDbtCodeForPreview: async (
      workspaceId,
      appId,
      dbtProjectId,
      code,
    ) => {
      if (!dbtProjectId || !containsDbtSchemaToken(code)) return code;
      const info = await get().fetchDbtEnvInfo(workspaceId, dbtProjectId);
      // Unresolvable link: pass the raw code through so the warehouse fails
      // loudly instead of silently querying the wrong schema.
      if (!info || info.environments.length === 0) return code;
      const override = get().previewDbtEnv[appId];
      const envName =
        override && info.environments.some(env => env.name === override)
          ? override
          : prodLikeDbtEnvironment(info);
      const env = info.environments.find(e => e.name === envName);
      if (!env) return code;
      return resolveDbtSchemaToken(code, env.targetSchema);
    },

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
        // dbt-linked bindings: resolve {{ dbt_schema }} against the preview
        // environment (override or prod default) before executing.
        const query = await get().resolveDbtCodeForPreview(
          workspaceId,
          appId,
          binding.dbtProjectId,
          binding.code,
        );
        // 400/403 carry a structured error body (validation / permission), so
        // read the parsed body regardless of HTTP status instead of throwing.
        const result = await api.POST("/api/workspaces/{workspaceId}/execute", {
          params: { path: { workspaceId } },
          body: {
            connectionId: binding.connectionId,
            query,
            databaseId: binding.databaseId,
            databaseName: binding.databaseName,
            mode: "preview",
            source: "app_runtime",
            // Per-app cost attribution (query_executions.appId/bindingId)
            appId,
            bindingId: binding.id,
          },
        });
        const status = result.response.status;
        const body = (result.data ?? result.error) as QueryExecuteResponse;
        if (status === 400 || status === 403 || !body?.success) {
          return { success: false, error: body?.error || "Query failed" };
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
      const refreshPreview = options?.refreshPreview !== false;

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
        if (refreshPreview) {
          // Data first, then UI: refetch binding caches, then ask the renderer
          // to load DuckDB and post data-refresh. Do NOT bumpPreview — that
          // reboots the iframe before tables are ready.
          await get().fetchApp(workspaceId, appId);
          get().requestDataRefresh(appId);
        }
        return { success: true, status: "ready" as const };
      };

      try {
        const res = unwrapBody(
          await api.POST(
            "/api/workspaces/{workspaceId}/apps/{id}/bindings/{bindingId}/materialize",
            {
              params: { path: { workspaceId, id: appId, bindingId } },
              body: options?.force ? { force: true } : undefined,
              signal,
            },
          ),
        ) as {
          success: boolean;
          queued?: boolean;
          status?: { status: string; error?: string };
          app?: AppEntity;
          error?: string;
        };
        if (!res.success) {
          const error =
            res.status?.error || res.error || "Materialization failed";
          setLocalStatus("error", error);
          return { success: false, status: "error", error };
        }
        // Cache hit — artifact already built, nothing queued.
        if (res.status?.status === "ready") {
          if (res.app) {
            // Only replace the open app when refreshing the preview. During
            // bulk rematerialize, a cache-hit response may carry stale sibling
            // binding caches and would clobber in-flight status updates.
            if (refreshPreview) {
              set(state => {
                state.openApps[appId] = res.app as AppEntity;
              });
              get().requestDataRefresh(appId);
            } else {
              setLocalStatus("ready");
            }
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
          const poll = unwrapBody(
            await api.GET(
              "/api/workspaces/{workspaceId}/apps/{id}/bindings/{bindingId}/materialization",
              {
                params: { path: { workspaceId, id: appId, bindingId } },
                signal,
              },
            ),
          ) as {
            success: boolean;
            data?: BindingMaterializationStatus;
          };
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

    materializeAllBindings: async (workspaceId, appId, options) => {
      const appEntity = get().openApps[appId];
      const parquetBindings = (appEntity?.dataBindings ?? []).filter(
        b => b.materialization === "parquet",
      );
      if (parquetBindings.length === 0) {
        return { total: 0, ready: 0, failed: 0, errors: [] };
      }

      const total = parquetBindings.length;
      let settled = 0;
      let ready = 0;
      let failed = 0;
      options?.onProgress?.({ total, settled, ready, failed });

      // Build every binding concurrently. Each call queues a background build
      // and polls to completion; the shared per-binding claim on the server
      // dedupes against any build already in flight. Default to a force rebuild
      // so a lost/stale cache is always regenerated. Skip per-binding preview
      // refreshes — the caller applies data once after every binding settles.
      const results = await Promise.all(
        parquetBindings.map(binding =>
          get()
            .materializeBinding(workspaceId, appId, binding.id, {
              force: options?.force ?? true,
              signal: options?.signal,
              timeoutMs: options?.timeoutMs,
              refreshPreview: false,
            })
            .then(result => {
              settled += 1;
              if (result.status === "ready") {
                ready += 1;
              } else {
                failed += 1;
              }
              options?.onProgress?.({ total, settled, ready, failed });
              return { name: binding.name, ...result };
            }),
        ),
      );

      // Ensure the open app reflects the freshly hydrated cache (parquetUrl)
      // once all builds settle, so the preview can load every table. Do not
      // bumpPreview here — AppRenderer loads DuckDB then posts data-refresh.
      await get().fetchApp(workspaceId, appId);

      const failures = results.filter(r => r.status !== "ready");
      return {
        total,
        ready: results.length - failures.length,
        failed: failures.length,
        errors: failures.map(f => `${f.name}: ${f.error ?? f.status}`),
      };
    },

    reset: () => set(() => ({ ...initialState })),
  })),
);
