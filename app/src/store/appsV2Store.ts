/**
 * Apps v2 store — git-backed apps (experimental, parallel to apps v1).
 *
 * Backed by /api/workspaces/:id/apps-v2 (see api/src/apps-v2/**). All file
 * reads resolve through the durable worktree layer on the server (bare repo +
 * private WIP refs), so everything here renders identically whether the
 * app's sandbox session is warm or was rebuilt after eviction.
 *
 * Feature-gated: `enabled` is probed once per workspace via /status-probe and
 * drives the sidebar rail icon; every route except the probe 404s while the
 * server flag is off.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, unwrapBody, ApiError } from "../api";

export interface AppV2Meta {
  id: string;
  title: string;
  description?: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface AppV2FileEntry {
  path: string;
  size: number;
}

export interface AppV2Change {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface AppV2Status {
  branch: string;
  baseSha: string;
  wipOid?: string;
  revision: number;
  branchHead: string | null;
  behindBranch: boolean;
  changes: AppV2Change[];
}

export interface AppV2Commit {
  oid: string;
  author: string;
  timestamp: number;
  subject: string;
}

export interface AppV2TerminalEntry {
  id: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  durationMs?: number;
  running?: boolean;
  at: number;
}

export interface AppV2Branch {
  name: string;
  head: string;
  isDefault: boolean;
  aheadOfMain: number;
  lastCommit?: { subject: string; author: string; timestamp: number };
}

export interface AppV2Preview {
  url: string | null;
  building: boolean;
  error: string | null;
  buildOutput?: string;
  builtAt?: number;
}

interface AppsV2Store {
  /** undefined = probe pending; false = hidden; true = show the rail. */
  enabled: boolean | undefined;
  apps: AppV2Meta[];
  appsLoading: boolean;
  error: string | null;

  filesByApp: Record<string, AppV2FileEntry[]>;
  fileContents: Record<string, { contents: string; dirty: boolean }>;
  selectedFile: Record<string, string | null>;
  statusByApp: Record<string, AppV2Status | null>;
  historyByApp: Record<string, AppV2Commit[]>;
  branchesByApp: Record<string, AppV2Branch[]>;
  terminalByApp: Record<string, AppV2TerminalEntry[]>;
  execRunning: Record<string, boolean>;
  previewByApp: Record<string, AppV2Preview>;
  viewMode: Record<string, "code" | "preview">;

  probeEnabled: (workspaceId: string) => Promise<void>;
  fetchApps: (workspaceId: string) => Promise<void>;
  createApp: (
    workspaceId: string,
    title: string,
    description?: string,
  ) => Promise<AppV2Meta | null>;
  deleteApp: (workspaceId: string, appId: string) => Promise<boolean>;

  fetchFiles: (workspaceId: string, appId: string) => Promise<void>;
  openFile: (workspaceId: string, appId: string, path: string) => Promise<void>;
  updateFileLocal: (appId: string, path: string, contents: string) => void;
  saveFile: (workspaceId: string, appId: string, path: string) => Promise<void>;

  runCommand: (
    workspaceId: string,
    appId: string,
    command: string,
  ) => Promise<void>;
  clearTerminal: (appId: string) => void;

  fetchStatus: (workspaceId: string, appId: string) => Promise<void>;
  fetchHistory: (workspaceId: string, appId: string) => Promise<void>;
  fetchBranches: (workspaceId: string, appId: string) => Promise<void>;
  mergeBranch: (
    workspaceId: string,
    appId: string,
    branch: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  commit: (
    workspaceId: string,
    appId: string,
    message: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  discard: (workspaceId: string, appId: string) => Promise<void>;

  buildPreview: (workspaceId: string, appId: string) => Promise<void>;
  setViewMode: (appId: string, mode: "code" | "preview") => void;
  clearError: () => void;
}

const fileKey = (appId: string, path: string) => `${appId}\u0000${path}`;

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export const useAppsV2Store = create<AppsV2Store>()(
  immer((set, get) => ({
    enabled: undefined,
    apps: [],
    appsLoading: false,
    error: null,
    filesByApp: {},
    fileContents: {},
    selectedFile: {},
    statusByApp: {},
    historyByApp: {},
    branchesByApp: {},
    terminalByApp: {},
    execRunning: {},
    previewByApp: {},
    viewMode: {},

    probeEnabled: async workspaceId => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps-v2/status-probe", {
            params: { path: { workspaceId } },
          }),
        ) as { enabled?: boolean };
        set(s => {
          s.enabled = Boolean(body?.enabled);
        });
      } catch {
        // Older backend without the route (or transient failure): hide.
        set(s => {
          s.enabled = false;
        });
      }
    },

    fetchApps: async workspaceId => {
      set(s => {
        s.appsLoading = true;
        s.error = null;
      });
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps-v2", {
            params: { path: { workspaceId } },
          }),
        ) as { apps?: AppV2Meta[] };
        set(s => {
          s.apps = body.apps ?? [];
          s.appsLoading = false;
        });
      } catch (e) {
        set(s => {
          s.appsLoading = false;
          // A 404 here means the flag is off — not an error worth surfacing.
          if (!(e instanceof ApiError && e.status === 404)) {
            s.error = message(e, "Failed to load apps");
          }
        });
      }
    },

    createApp: async (workspaceId, title, description) => {
      try {
        const body = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps-v2", {
            params: { path: { workspaceId } },
            body: { title, description },
          }),
        ) as { app?: AppV2Meta };
        if (body.app) {
          set(s => {
            s.apps.unshift(body.app as AppV2Meta);
          });
          return body.app;
        }
        return null;
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to create app");
        });
        return null;
      }
    },

    deleteApp: async (workspaceId, appId) => {
      try {
        unwrapBody(
          await api.DELETE("/api/workspaces/{workspaceId}/apps-v2/{id}", {
            params: { path: { workspaceId, id: appId } },
          }),
        );
        set(s => {
          s.apps = s.apps.filter(a => a.id !== appId);
          delete s.filesByApp[appId];
          delete s.statusByApp[appId];
          delete s.historyByApp[appId];
          delete s.terminalByApp[appId];
          delete s.previewByApp[appId];
        });
        return true;
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to delete app");
        });
        return false;
      }
    },

    fetchFiles: async (workspaceId, appId) => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps-v2/{id}/files", {
            params: { path: { workspaceId, id: appId } },
          }),
        ) as { files?: AppV2FileEntry[] };
        set(s => {
          s.filesByApp[appId] = body.files ?? [];
        });
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to list files");
        });
      }
    },

    openFile: async (workspaceId, appId, path) => {
      set(s => {
        s.selectedFile[appId] = path;
      });
      const key = fileKey(appId, path);
      const cached = get().fileContents[key];
      if (cached?.dirty) return; // Never clobber unsaved local edits.
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps-v2/{id}/file", {
            params: { path: { workspaceId, id: appId }, query: { path } },
          }),
        ) as { file?: { contents: string; isBinary: boolean } };
        set(s => {
          s.fileContents[key] = {
            contents: body.file?.isBinary
              ? "(binary file)"
              : (body.file?.contents ?? ""),
            dirty: false,
          };
        });
      } catch (e) {
        set(s => {
          s.error = message(e, `Failed to read ${path}`);
        });
      }
    },

    updateFileLocal: (appId, path, contents) => {
      set(s => {
        s.fileContents[fileKey(appId, path)] = { contents, dirty: true };
      });
    },

    saveFile: async (workspaceId, appId, path) => {
      const entry = get().fileContents[fileKey(appId, path)];
      if (!entry?.dirty) return;
      try {
        unwrapBody(
          await api.PUT("/api/workspaces/{workspaceId}/apps-v2/{id}/file", {
            params: { path: { workspaceId, id: appId } },
            body: { path, contents: entry.contents },
          }),
        );
        set(s => {
          const cur = s.fileContents[fileKey(appId, path)];
          // Only clear dirty if no further local edits raced the save.
          if (cur && cur.contents === entry.contents) cur.dirty = false;
        });
        void get().fetchStatus(workspaceId, appId);
        void get().fetchFiles(workspaceId, appId);
      } catch (e) {
        set(s => {
          s.error = message(e, `Failed to save ${path}`);
        });
      }
    },

    runCommand: async (workspaceId, appId, command) => {
      const entryId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      set(s => {
        s.execRunning[appId] = true;
        (s.terminalByApp[appId] ??= []).push({
          id: entryId,
          command,
          stdout: "",
          stderr: "",
          exitCode: null,
          running: true,
          at: Date.now(),
        });
      });
      try {
        const body = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps-v2/{id}/exec", {
            params: { path: { workspaceId, id: appId } },
            body: { command },
          }),
        ) as {
          result?: {
            exitCode: number;
            stdout: string;
            stderr: string;
            timedOut: boolean;
            durationMs: number;
          };
        };
        set(s => {
          const entry = (s.terminalByApp[appId] ?? []).find(
            t => t.id === entryId,
          );
          if (entry && body.result) {
            entry.stdout = body.result.stdout;
            entry.stderr = body.result.stderr;
            entry.exitCode = body.result.exitCode;
            entry.timedOut = body.result.timedOut;
            entry.durationMs = body.result.durationMs;
            entry.running = false;
          }
          s.execRunning[appId] = false;
        });
        // A shell command can change anything: refresh the read model.
        void get().fetchFiles(workspaceId, appId);
        void get().fetchStatus(workspaceId, appId);
        const selected = get().selectedFile[appId];
        if (selected) {
          const key = fileKey(appId, selected);
          const cur = get().fileContents[key];
          if (cur && !cur.dirty) {
            void get().openFile(workspaceId, appId, selected);
          }
        }
      } catch (e) {
        set(s => {
          const entry = (s.terminalByApp[appId] ?? []).find(
            t => t.id === entryId,
          );
          if (entry) {
            entry.stderr = message(e, "Command failed");
            entry.exitCode = -1;
            entry.running = false;
          }
          s.execRunning[appId] = false;
        });
      }
    },

    clearTerminal: appId => {
      set(s => {
        s.terminalByApp[appId] = [];
      });
    },

    fetchStatus: async (workspaceId, appId) => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps-v2/{id}/status", {
            params: { path: { workspaceId, id: appId } },
          }),
        ) as { status?: AppV2Status | null };
        set(s => {
          s.statusByApp[appId] = body.status ?? null;
        });
      } catch {
        // Status is advisory; stale data is acceptable.
      }
    },

    fetchHistory: async (workspaceId, appId) => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps-v2/{id}/history", {
            params: { path: { workspaceId, id: appId } },
          }),
        ) as { commits?: AppV2Commit[] };
        set(s => {
          s.historyByApp[appId] = body.commits ?? [];
        });
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to load history");
        });
      }
    },

    fetchBranches: async (workspaceId, appId) => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps-v2/{id}/branches", {
            params: { path: { workspaceId, id: appId } },
          }),
        ) as { branches?: AppV2Branch[] };
        set(s => {
          s.branchesByApp[appId] = body.branches ?? [];
        });
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to load branches");
        });
      }
    },

    mergeBranch: async (workspaceId, appId, branch) => {
      try {
        const body = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps-v2/{id}/merge", {
            params: { path: { workspaceId, id: appId } },
            body: { branch },
          }),
        ) as { result?: { merged: boolean; reason?: string } };
        // Merge moves main: refresh everything the UI shows.
        void get().fetchBranches(workspaceId, appId);
        void get().fetchFiles(workspaceId, appId);
        void get().fetchStatus(workspaceId, appId);
        void get().fetchHistory(workspaceId, appId);
        const selected = get().selectedFile[appId];
        if (selected) void get().openFile(workspaceId, appId, selected);
        if (body.result?.merged) return { ok: true };
        return {
          ok: false,
          error: body.result?.reason ?? "Nothing to merge",
        };
      } catch (e) {
        return { ok: false, error: message(e, "Merge failed") };
      }
    },

    commit: async (workspaceId, appId, msg) => {
      try {
        const body = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps-v2/{id}/commit", {
            params: { path: { workspaceId, id: appId } },
            body: { message: msg },
          }),
        ) as { result?: { committed: boolean; reason?: string } };
        void get().fetchStatus(workspaceId, appId);
        void get().fetchHistory(workspaceId, appId);
        if (body.result?.committed) return { ok: true };
        return { ok: false, error: body.result?.reason ?? "Nothing to commit" };
      } catch (e) {
        return { ok: false, error: message(e, "Commit failed") };
      }
    },

    discard: async (workspaceId, appId) => {
      try {
        unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps-v2/{id}/discard", {
            params: { path: { workspaceId, id: appId } },
          }),
        );
        set(s => {
          // Drop caches — contents may have reverted.
          for (const key of Object.keys(s.fileContents)) {
            if (key.startsWith(`${appId}\u0000`)) delete s.fileContents[key];
          }
        });
        void get().fetchFiles(workspaceId, appId);
        void get().fetchStatus(workspaceId, appId);
        const selected = get().selectedFile[appId];
        if (selected) void get().openFile(workspaceId, appId, selected);
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to discard changes");
        });
      }
    },

    buildPreview: async (workspaceId, appId) => {
      set(s => {
        s.previewByApp[appId] = {
          ...(s.previewByApp[appId] ?? { url: null }),
          building: true,
          error: null,
        };
      });
      try {
        const res = await api.POST(
          "/api/workspaces/{workspaceId}/apps-v2/{id}/preview",
          { params: { path: { workspaceId, id: appId } } },
        );
        const raw = (res.data ?? res.error) as
          | {
              success?: boolean;
              url?: string;
              buildOutput?: string;
              error?: string;
              stdout?: string;
              stderr?: string;
            }
          | undefined;
        if (res.response.ok && raw?.url) {
          set(s => {
            s.previewByApp[appId] = {
              url: raw.url ?? null,
              building: false,
              error: null,
              buildOutput: raw.buildOutput,
              builtAt: Date.now(),
            };
            s.viewMode[appId] = "preview";
          });
        } else {
          const detail = [raw?.error, raw?.stdout, raw?.stderr]
            .filter(Boolean)
            .join("\n");
          set(s => {
            s.previewByApp[appId] = {
              ...(s.previewByApp[appId] ?? { url: null }),
              building: false,
              error: detail || "Build failed",
            };
          });
        }
        void get().fetchStatus(workspaceId, appId);
      } catch (e) {
        set(s => {
          s.previewByApp[appId] = {
            ...(s.previewByApp[appId] ?? { url: null }),
            building: false,
            error: message(e, "Build failed"),
          };
        });
      }
    },

    setViewMode: (appId, mode) => {
      set(s => {
        s.viewMode[appId] = mode;
      });
    },

    clearError: () => {
      set(s => {
        s.error = null;
      });
    },
  })),
);
