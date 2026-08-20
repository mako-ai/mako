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
import { apiClient } from "../lib/api-client";

export interface AppV2Meta {
  id: string;
  title: string;
  description?: string;
  updatedAt?: string;
  createdAt?: string;
  /** Commit sha currently deployed, if the app has ever been published. */
  publishedSha?: string;
  publishedAt?: string;
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
  /** "dev" = live `vite dev` proxy (HMR, no rebuild step); "static" = one-shot build. */
  mode?: "static" | "dev";
}

export interface AppV2RepoBinding {
  /** GitHub App installation granting access (needed to re-save the binding). */
  installationId?: number;
  owner: string;
  repo: string;
  defaultBranch: string;
  subdirectory: string;
}

export interface AppV2GithubRepo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface AppV2GithubInstallation {
  installationId: number;
  accountLogin: string;
  accountType?: string;
}

interface AppsV2Store {
  /** undefined = probe pending; false = hidden; true = show the rail. */
  enabled: boolean | undefined;
  /**
   * Whether app creation works: a repo is connected OR the server has
   * Mako-hosted cloud storage configured (instant start, no GitHub setup).
   */
  canCreate: boolean | undefined;
  /** Connected workspace repos (0..N; the product default is one). */
  repos: AppV2RepoBinding[];
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
  fetchGithubStatus: (workspaceId: string) => Promise<{
    installations: AppV2GithubInstallation[];
    appSlug: string | null;
  }>;
  fetchGithubRepos: (
    workspaceId: string,
    installationId: number,
  ) => Promise<AppV2GithubRepo[]>;
  // TODO(apps-v2): borrows dbt's raw (non-OpenAPI) install-url route until
  // apps-v2 gets its own /apps-v2/github/install-url endpoint.
  getGitHubInstallUrl: (workspaceId: string) => Promise<string | null>;
  /**
   * User-authorization OAuth flow: binds installations that already exist on
   * GitHub (whose install page short-circuits and never fires our callback).
   */
  getGitHubSyncUrl: (workspaceId: string) => Promise<string | null>;
  /** Branch names of a repo (for the branch switcher). */
  fetchGithubBranches: (
    workspaceId: string,
    owner: string,
    repo: string,
    installationId?: number,
  ) => Promise<string[]>;
  connectRepo: (
    workspaceId: string,
    input: {
      owner: string;
      repo: string;
      defaultBranch?: string;
      subdirectory?: string;
      installationId?: number;
    },
  ) => Promise<{ ok: boolean; error?: string }>;
  disconnectRepo: (
    workspaceId: string,
    owner: string,
    repo: string,
  ) => Promise<void>;
  disconnectGithubInstallation: (
    workspaceId: string,
    installationId: number,
  ) => Promise<{ ok: boolean; error?: string }>;
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

  // `chatId`: build the conversation's `chat/<chatId>` branch instead of the
  // caller's own worktree, which always starts on main — pass it whenever an
  // active chat has already committed work on this app (see AppV2Workspace),
  // otherwise Build & preview silently renders stale, unrelated content.
  /** Merge to main, build, deploy, and repoint (§13.3). */
  publishApp: (
    workspaceId: string,
    appId: string,
    chatId?: string,
  ) => Promise<void>;
  buildPreview: (
    workspaceId: string,
    appId: string,
    chatId?: string,
  ) => Promise<void>;
  // Prototype of apps-v2.md §4.7's "dev preview" tier (local-provider only —
  // see api/src/apps-v2/dev-server.service.ts). Starts (or reuses) a
  // persistent `vite dev` process and iframes it directly: HMR picks up
  // every subsequent file change with no rebuild step, unlike buildPreview.
  startDevPreview: (
    workspaceId: string,
    appId: string,
    chatId?: string,
  ) => Promise<void>;
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
    canCreate: undefined,
    repos: [],
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
        ) as {
          enabled?: boolean;
          canCreate?: boolean;
          repos?: AppV2RepoBinding[];
        };
        set(s => {
          s.enabled = Boolean(body?.enabled);
          s.canCreate = Boolean(body?.canCreate);
          s.repos = body?.repos ?? [];
        });
      } catch {
        // Older backend without the route (or transient failure): hide.
        set(s => {
          s.enabled = false;
        });
      }
    },

    fetchGithubStatus: async workspaceId => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps-v2/github-status", {
            params: { path: { workspaceId } },
          }),
        ) as {
          installations?: AppV2GithubInstallation[];
          appSlug?: string | null;
          repos?: AppV2RepoBinding[];
        };
        set(s => {
          s.repos = body.repos ?? [];
          s.canCreate = s.canCreate || (body.repos ?? []).length > 0;
        });
        return {
          installations: body.installations ?? [],
          appSlug: body.appSlug ?? null,
        };
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to load GitHub status");
        });
        return { installations: [], appSlug: null };
      }
    },

    getGitHubInstallUrl: async workspaceId => {
      try {
        const response = await apiClient.get<{ success: boolean; url: string }>(
          `/workspaces/${workspaceId}/dbt/github/install-url`,
        );
        return response.url ?? null;
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to start GitHub App install");
        });
        return null;
      }
    },

    fetchGithubBranches: async (workspaceId, owner, repo, installationId) => {
      try {
        const params = new URLSearchParams({ owner, repo });
        if (installationId) {
          params.set("installationId", String(installationId));
        }
        // TODO(workspace-repos): reuses dbt's raw branches route until repos
        // get their own workspace-level GitHub surface.
        const response = await apiClient.get<{
          success: boolean;
          branches: string[];
        }>(`/workspaces/${workspaceId}/dbt/github/branches?${params}`);
        return response.branches ?? [];
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to list branches");
        });
        return [];
      }
    },

    getGitHubSyncUrl: async workspaceId => {
      try {
        const body = unwrapBody(
          await api.GET(
            "/api/workspaces/{workspaceId}/apps-v2/github-sync-url",
            { params: { path: { workspaceId } } },
          ),
        ) as { url?: string };
        return body.url ?? null;
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to start GitHub sync");
        });
        return null;
      }
    },

    fetchGithubRepos: async (workspaceId, installationId) => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps-v2/github-repos", {
            params: {
              path: { workspaceId },
              query: { installationId },
            },
          }),
        ) as { repos?: AppV2GithubRepo[] };
        return body.repos ?? [];
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to list repositories");
        });
        return [];
      }
    },

    connectRepo: async (workspaceId, input) => {
      try {
        const body = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps-v2/link", {
            params: { path: { workspaceId } },
            body: input,
          }),
        ) as { repo?: AppV2RepoBinding };
        set(s => {
          s.canCreate = true;
          if (body.repo) {
            s.repos = [
              ...s.repos.filter(
                r =>
                  !(r.owner === body.repo?.owner && r.repo === body.repo.repo),
              ),
              body.repo,
            ];
          }
        });
        void get().fetchApps(workspaceId);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: message(e, "Failed to connect repo") };
      }
    },

    disconnectRepo: async (workspaceId, owner, repo) => {
      try {
        unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps-v2/unlink", {
            params: { path: { workspaceId } },
            body: { owner, repo },
          }),
        );
        set(s => {
          s.repos = s.repos.filter(
            r => !(r.owner === owner && r.repo === repo),
          );
        });
        // canCreate may still be true via cloud storage — let the probe say.
        void get().probeEnabled(workspaceId);
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to disconnect repo");
        });
      }
    },

    disconnectGithubInstallation: async (workspaceId, installationId) => {
      try {
        unwrapBody(
          await api.DELETE(
            "/api/workspaces/{workspaceId}/apps-v2/github-installations/{installationId}",
            { params: { path: { workspaceId, installationId } } },
          ),
        );
        return { ok: true as const };
      } catch (e) {
        return {
          ok: false as const,
          error: message(e, "Failed to disconnect installation"),
        };
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

    publishApp: async (workspaceId, appId, chatId) => {
      set(s => {
        s.previewByApp[appId] = {
          ...(s.previewByApp[appId] ?? { url: null }),
          building: true,
          error: null,
        };
      });
      try {
        const res = await api.POST(
          "/api/workspaces/{workspaceId}/apps-v2/{id}/publish",
          {
            params: { path: { workspaceId, id: appId } },
            body: chatId ? { chatId } : {},
          },
        );
        const raw = (res.data ?? res.error) as
          | { success?: boolean; sha?: string; error?: string }
          | undefined;
        if (res.response.ok && raw?.sha) {
          set(s => {
            const app = s.apps.find(a => a.id === appId);
            if (app) {
              app.publishedSha = raw.sha;
              app.publishedAt = new Date().toISOString();
            }
            s.previewByApp[appId] = {
              ...(s.previewByApp[appId] ?? { url: null }),
              building: false,
              error: null,
            };
          });
        } else {
          set(s => {
            s.previewByApp[appId] = {
              ...(s.previewByApp[appId] ?? { url: null }),
              building: false,
              error: raw?.error ?? "Publish failed",
            };
          });
        }
      } catch (e) {
        set(s => {
          s.previewByApp[appId] = {
            ...(s.previewByApp[appId] ?? { url: null }),
            building: false,
            error: message(e, "Publish failed"),
          };
        });
      }
    },

    buildPreview: async (workspaceId, appId, chatId) => {
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
          {
            params: { path: { workspaceId, id: appId } },
            body: chatId ? { chatId } : undefined,
          },
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
              mode: "static",
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

    startDevPreview: async (workspaceId, appId, chatId) => {
      set(s => {
        s.previewByApp[appId] = {
          ...(s.previewByApp[appId] ?? { url: null }),
          building: true,
          error: null,
        };
      });
      try {
        const res = await api.POST(
          "/api/workspaces/{workspaceId}/apps-v2/{id}/dev-preview",
          {
            params: { path: { workspaceId, id: appId } },
            body: chatId ? { chatId } : undefined,
          },
        );
        const raw = (res.data ?? res.error) as
          | { success?: boolean; url?: string; error?: string }
          | undefined;
        if (res.response.ok && raw?.url) {
          set(s => {
            s.previewByApp[appId] = {
              url: raw.url ?? null,
              building: false,
              error: null,
              builtAt: Date.now(),
              mode: "dev",
            };
            s.viewMode[appId] = "preview";
          });
        } else {
          set(s => {
            s.previewByApp[appId] = {
              ...(s.previewByApp[appId] ?? { url: null }),
              building: false,
              error: raw?.error ?? "Failed to start dev preview",
            };
          });
        }
      } catch (e) {
        set(s => {
          s.previewByApp[appId] = {
            ...(s.previewByApp[appId] ?? { url: null }),
            building: false,
            error: message(e, "Failed to start dev preview"),
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
