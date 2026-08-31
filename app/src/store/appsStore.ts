/**
 * Apps store — git-backed apps.
 *
 * Backed by /api/workspaces/:id/apps (see api/src/apps/**). All file
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
import { reconcileAppsTabs } from "../apps-runtime/shell";

export interface AppMeta {
  id: string;
  /** Folder name under `apps/` in the workspace repo — the app's real
   *  identity, and what its URL uses. */
  slug?: string;
  title: string;
  description?: string;
  updatedAt?: string;
  createdAt?: string;
  /** Commit sha currently deployed, if the app has ever been published. */
  publishedSha?: string;
  publishedAt?: string;
  /** Sharing scope: private = owner's "My Apps", workspace = everyone's. */
  access?: "private" | "workspace";
  /**
   * The user who owns the sharing state (API field name, as stored). A
   * private app whose owner is not the viewer was shared with them
   * personally — the sidebar's "Shared with me" section.
   */
  owner_id?: string;
}

export interface AppFileEntry {
  path: string;
  size: number;
}

export interface AppChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** In the index (git add) — VS Code's "Staged Changes" group. */
  staged?: boolean;
  /** In the working tree, not (fully) staged — the "Changes" group. */
  unstaged?: boolean;
}

export interface AppFileVersions {
  head: string | null;
  index: string | null;
  working: string | null;
  binary: boolean;
}

/** Mirror of the API's BoxState — what the sandbox pushed about itself. */
export interface AppsBoxState {
  branch: string | null;
  head?: string | null;
  ahead?: number | null;
  changes: AppChange[] | null;
  devServers: Array<{
    slug: string;
    port: number;
    url?: string;
    reachable?: boolean;
  }> | null;
  /** The E2B sandbox id backing this box; null when none is running. */
  sandboxId?: string | null;
  /** Coarse liveness — "offline" is published the instant a box is recycled. */
  status?: "online" | "offline";
  /** Open terminal session ids. */
  terminals?: string[] | null;
  updatedAt: number;
}

export interface AppStatus {
  branch: string;
  /** Commit the working copy is on. */
  baseSha: string;
  branchHead: string | null;
  /** Commits this branch has that the server does not. */
  ahead: number;
  /** Uncommitted changes inside this app's folder. */
  changes: AppChange[];
  /**
   * Uncommitted changes anywhere in the repo. One working copy serves every
   * app, so this — not `changes` — is what a branch switch has to get past and
   * what Discard throws away.
   */
  repoChanges: AppChange[];
  /**
   * No sandbox is running, so this is the last committed state rather than a
   * working copy. Not the same as "clean": there is nothing to be dirty.
   */
  offline: boolean;
}

export interface AppCommit {
  oid: string;
  author: string;
  timestamp: number;
  subject: string;
}

export interface AppTerminalEntry {
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

export interface AppBranch {
  name: string;
  head: string;
  isDefault: boolean;
  aheadOfMain: number;
  lastCommit?: { subject: string; author: string; timestamp: number };
}

export interface AppPreview {
  url: string | null;
  building: boolean;
  /** A publish build is running — distinct from a dev server starting. */
  publishing?: boolean;
  error: string | null;
  buildOutput?: string;
  builtAt?: number;
  /** "dev" = live `vite dev` proxy (HMR, no rebuild step); "static" = one-shot build. */
  mode?: "static" | "dev";
  /** false = the server answers the box but 403s the preview host (see box-state). */
  reachable?: boolean;
}

export interface AppRepoBinding {
  /** GitHub App installation granting access (needed to re-save the binding). */
  installationId?: number;
  owner: string;
  repo: string;
  defaultBranch: string;
  subdirectory: string;
}

export interface AppGithubRepo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface AppGithubInstallation {
  installationId: number;
  accountLogin: string;
  accountType?: string;
}

interface AppsStore {
  /** undefined = probe pending; false = hidden; true = show the rail. */
  enabled: boolean | undefined;
  /**
   * Whether app creation works: a repo is connected OR the server has
   * Mako-hosted cloud storage configured (instant start, no GitHub setup).
   */
  canCreate: boolean | undefined;
  /** Connected workspace repos (0..N; the product default is one). */
  repos: AppRepoBinding[];
  apps: AppMeta[];
  appsLoading: boolean;
  error: string | null;

  filesByApp: Record<string, AppFileEntry[]>;
  /**
   * Set when the server capped an app's listing — { shown, total }. A
   * 100k-file folder (a committed node_modules, a data dump) renders its
   * first files plus this notice instead of crashing the tree.
   */
  filesTruncatedByApp: Record<string, { shown: number; total?: number }>;
  fileContents: Record<string, { contents: string; dirty: boolean }>;
  selectedFile: Record<string, string | null>;
  statusByApp: Record<string, AppStatus | null>;
  /**
   * Which apps the user has opened for EDITING.
   *
   * Browsing an app costs nothing: its files come from git and no sandbox
   * starts. Editing needs a real machine — a checkout, a shell, somewhere for
   * npm to run — so it is entered deliberately rather than by opening a tab,
   * and a microVM only boots when someone actually means to work.
   */
  editingByApp: Record<string, boolean>;
  /**
   * Cookie-free URL for each app's PUBLISHED build, for the consumer view.
   *
   * It cannot just be the app's own `/live/` URL: that view runs in a
   * sandboxed, opaque-origin iframe, and ES modules are always fetched in CORS
   * mode without credentials — so a cookie-authorized URL 401s in there and
   * the app renders as a blank page.
   */
  viewUrlByApp: Record<string, string | undefined>;
  historyByApp: Record<string, AppCommit[]>;
  /** Repo-wide graph (Source Control panel) — same repo, no app pathspec. */
  repoHistoryByApp: Record<string, AppCommit[]>;
  branchesByApp: Record<string, AppBranch[]>;
  terminalByApp: Record<string, AppTerminalEntry[]>;
  execRunning: Record<string, boolean>;
  previewByApp: Record<string, AppPreview>;
  viewMode: Record<string, "code" | "preview">;

  probeEnabled: (workspaceId: string) => Promise<void>;
  fetchGithubStatus: (workspaceId: string) => Promise<{
    installations: AppGithubInstallation[];
    appSlug: string | null;
  }>;
  fetchGithubRepos: (
    workspaceId: string,
    installationId: number,
  ) => Promise<AppGithubRepo[]>;
  // TODO(apps): borrows dbt's raw (non-OpenAPI) install-url route until
  // apps gets its own /apps/github/install-url endpoint.
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
  ) => Promise<{
    ok: boolean;
    error?: string;
    /** §13.17 connect-time reconciliation outcome. */
    adoption?: "imported" | "seeded" | "fresh" | "deferred";
  }>;
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
  /** Drag between rail sections: flip private <-> workspace. */
  setAppAccess: (
    workspaceId: string,
    appId: string,
    access: "private" | "workspace",
  ) => Promise<void>;
  createApp: (
    workspaceId: string,
    title: string,
    description?: string,
  ) => Promise<AppMeta | null>;
  deleteApp: (workspaceId: string, appId: string) => Promise<boolean>;

  /**
   * List an app's files.
   *
   * There is no longer a "live" variant to ask for: the server reads the
   * sandbox's working copy whenever one is running, so a file created in the
   * terminal is simply there, and reads the last commit when it is not.
   */
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
  fetchHistory: (
    workspaceId: string,
    appId: string,
    scope?: "app" | "repo",
  ) => Promise<void>;
  fetchBranches: (workspaceId: string, appId: string) => Promise<void>;
  /** Fetch (or refresh) the cookie-free URL for an app's published build. */
  fetchViewUrl: (workspaceId: string, appId: string) => Promise<void>;
  /** Enter or leave edit mode for an app (see `editingByApp`). */
  setEditing: (workspaceId: string, appId: string, editing: boolean) => void;
  /**
   * Switch which branch this app's worktree is on — a real `git checkout` in
   * the sandbox, so the shell and the UI agree afterwards. Resolves to an
   * error message when the server refuses (uncommitted work), rather than
   * throwing, so the menu can say why.
   */
  checkoutBranch: (
    workspaceId: string,
    appId: string,
    branch: string,
    options?: { create?: boolean },
  ) => Promise<string | null>;
  mergeBranch: (
    workspaceId: string,
    appId: string,
    branch: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  commit: (
    workspaceId: string,
    appId: string,
    message: string,
    options?: { stagedOnly?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Per-file git actions from the Source Control view (repo-relative paths). */
  gitPaths: (
    workspaceId: string,
    appId: string,
    action: "stage" | "unstage" | "discard",
    paths: string[],
  ) => Promise<{ ok: boolean; error?: string }>;
  fetchFileVersions: (
    workspaceId: string,
    appId: string,
    path: string,
  ) => Promise<AppFileVersions | null>;
  discard: (workspaceId: string, appId: string) => Promise<void>;

  // No branch parameter on any of these: chats no longer have their own
  // branch, so there is exactly one answer to "which branch" — the caller's —
  // and the server is the one that knows it.
  /**
   * Tail the dev-session boot log — the sandbox's real npm install + vite
   * output from `offset` on. What the boot screen shows.
   */
  /**
   * Ask the server whether the dev session is actually serving; when it is
   * not (stopped from its own terminal with Ctrl-C, crashed, sandbox
   * recycled), drop the client's preview state so the workbench flips to
   * the launch state instead of showing a stale iframe as "live".
   */
  checkDevStatus: (workspaceId: string, appId: string) => Promise<void>;
  /** A dev server for this app is serving at `url` (discovery or push). */
  markDevServing: (appId: string, url: string, reachable?: boolean) => void;
  /** No dev server is serving this app any more. */
  markDevDown: (appId: string) => void;
  /**
   * Whose sandbox pushes to believe. Boxes are per (workspace, user); the
   * realtime channel is per workspace, so events name their user and the
   * store ignores other people's machines.
   */
  currentUserId: string | null;
  setCurrentUserId: (userId: string | null) => void;
  /** Apply a pushed box snapshot directly to dev-server and git state. */
  applyBoxState: (userId: string, state: AppsBoxState) => void;
  /** Slugs of apps whose dev server is live — the sidebar's green dots. */
  runningDevApps: string[];
  /** Current box liveness/identity from the pushed snapshot (reactive). */
  boxStatus?: "online" | "offline";
  boxSandboxId?: string | null;
  boxTerminals: string[];
  fetchRunningDevApps: (workspaceId: string) => Promise<void>;
  /** Deep sandbox stats (a live exec with a 1s CPU sample); null if no box. */
  fetchSandboxStats: (
    workspaceId: string,
    appId: string,
  ) => Promise<Record<string, unknown> | null>;
  /** Kill the sandbox; the next touch builds a fresh one. */
  recycleSandbox: (workspaceId: string, appId: string) => Promise<void>;
  /**
   * Stop dev mode: kill the dev server AND every terminal session in the
   * box, and clear the remembered shell tabs — re-entering dev starts from
   * exactly one fresh dev terminal.
   */
  stopDev: (workspaceId: string, appId: string) => Promise<void>;
  /** Bindings state for an app (per-binding materialization status/history). */
  fetchAppBindings: (
    workspaceId: string,
    appId: string,
  ) => Promise<Array<Record<string, unknown> & { name: string }>>;
  /** Kick a materialization run for one binding; returns the run summary. */
  materializeAppBinding: (
    workspaceId: string,
    appId: string,
    name: string,
  ) => Promise<Record<string, unknown>>;
  /** Closing a terminal tab kills its remote session (pty + dtach + recording). */
  killTerminalSession: (
    workspaceId: string,
    appId: string,
    termId: string,
  ) => Promise<void>;
  fetchDevLog: (
    workspaceId: string,
    appId: string,
    offset: number,
  ) => Promise<{ size: number; chunk: string }>;
  /** Merge to main, build, deploy, and repoint (§13.3). */
  publishApp: (workspaceId: string, appId: string) => Promise<void>;
  buildPreview: (workspaceId: string, appId: string) => Promise<void>;
  // Prototype of apps.md §4.7's "dev preview" tier (local-provider only —
  // see api/src/apps/dev-server.service.ts). Starts (or reuses) a
  // persistent `vite dev` process and iframes it directly: HMR picks up
  // every subsequent file change with no rebuild step, unlike buildPreview.
  startDevPreview: (
    workspaceId: string,
    appId: string,
    opts?: { restart?: boolean },
  ) => Promise<void>;
  setViewMode: (appId: string, mode: "code" | "preview") => void;
  clearError: () => void;
}

const fileKey = (appId: string, path: string) => `${appId}\u0000${path}`;

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export const useAppsStore = create<AppsStore>()(
  immer((set, get) => ({
    enabled: undefined,
    canCreate: undefined,
    repos: [],
    apps: [],
    appsLoading: false,
    error: null,
    filesByApp: {},
    filesTruncatedByApp: {},
    fileContents: {},
    selectedFile: {},
    statusByApp: {},
    editingByApp: {},
    viewUrlByApp: {},
    historyByApp: {},
    repoHistoryByApp: {},
    runningDevApps: [],
    boxStatus: undefined,
    boxSandboxId: null,
    boxTerminals: [],
    currentUserId: null,
    branchesByApp: {},
    terminalByApp: {},
    execRunning: {},
    previewByApp: {},
    viewMode: {},

    probeEnabled: async workspaceId => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps/status-probe", {
            params: { path: { workspaceId } },
          }),
        ) as {
          enabled?: boolean;
          canCreate?: boolean;
          repos?: AppRepoBinding[];
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
          await api.GET("/api/workspaces/{workspaceId}/apps/github-status", {
            params: { path: { workspaceId } },
          }),
        ) as {
          installations?: AppGithubInstallation[];
          appSlug?: string | null;
          repos?: AppRepoBinding[];
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
          await api.GET("/api/workspaces/{workspaceId}/apps/github-sync-url", {
            params: { path: { workspaceId } },
          }),
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
          await api.GET("/api/workspaces/{workspaceId}/apps/github-repos", {
            params: {
              path: { workspaceId },
              query: { installationId },
            },
          }),
        ) as { repos?: AppGithubRepo[] };
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
          await api.POST("/api/workspaces/{workspaceId}/apps/link", {
            params: { path: { workspaceId } },
            body: input,
          }),
        ) as {
          repo?: AppRepoBinding;
          adoption?: "imported" | "seeded" | "fresh" | "deferred";
        };
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
        // An import can make apps appear instantly; refetch either way.
        void get().fetchApps(workspaceId);
        return { ok: true, adoption: body.adoption };
      } catch (e) {
        return { ok: false, error: message(e, "Failed to connect repo") };
      }
    },

    disconnectRepo: async (workspaceId, owner, repo) => {
      try {
        unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps/unlink", {
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
            "/api/workspaces/{workspaceId}/apps/github-installations/{installationId}",
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
          await api.GET("/api/workspaces/{workspaceId}/apps", {
            params: { path: { workspaceId } },
          }),
        ) as { apps?: AppMeta[] };
        const apps = body.apps ?? [];
        set(s => {
          s.apps = apps;
          s.appsLoading = false;
        });
        // Drop tabs pointing at apps this workspace does not have, so a
        // deleted app cannot leave a working-looking workspace view behind.
        reconcileAppsTabs(new Set(apps.map(a => a.id)));
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

    setAppAccess: async (workspaceId, appId, access) => {
      // Optimistic: the row moves sections immediately; server truth on error.
      set(s => {
        const app = s.apps.find(a => a.id === appId);
        if (app) app.access = access;
      });
      try {
        unwrapBody(
          await api.PATCH("/api/workspaces/{workspaceId}/apps/{id}/access", {
            params: { path: { workspaceId, id: appId } },
            body: { access },
          }),
        );
      } catch {
        void get().fetchApps(workspaceId);
      }
    },

    createApp: async (workspaceId, title, description) => {
      try {
        const body = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps", {
            params: { path: { workspaceId } },
            body: { title, description },
          }),
        ) as { app?: AppMeta };
        if (body.app) {
          set(s => {
            s.apps.unshift(body.app as AppMeta);
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
          await api.DELETE("/api/workspaces/{workspaceId}/apps/{id}", {
            params: { path: { workspaceId, id: appId } },
          }),
        );
        set(s => {
          s.apps = s.apps.filter(a => a.id !== appId);
          delete s.filesByApp[appId];
          delete s.statusByApp[appId];
          delete s.historyByApp[appId];
          delete s.repoHistoryByApp[appId];
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

    // Browsing leaves it out and never touches a sandbox — that is what keeps
    // opening an app cheap, and working while its sandbox is asleep.
    fetchFiles: async (workspaceId, appId) => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps/{id}/files", {
            params: {
              path: { workspaceId, id: appId },
            },
          }),
        ) as {
          files?: AppFileEntry[];
          truncated?: boolean;
          total?: number;
        };
        set(s => {
          s.filesByApp[appId] = body.files ?? [];
          if (body.truncated) {
            s.filesTruncatedByApp[appId] = {
              shown: body.files?.length ?? 0,
              total: body.total,
            };
          } else {
            delete s.filesTruncatedByApp[appId];
          }
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
          await api.GET("/api/workspaces/{workspaceId}/apps/{id}/file", {
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
          await api.PUT("/api/workspaces/{workspaceId}/apps/{id}/file", {
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
          await api.POST("/api/workspaces/{workspaceId}/apps/{id}/exec", {
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
          await api.GET("/api/workspaces/{workspaceId}/apps/{id}/status", {
            params: {
              path: { workspaceId, id: appId },
            },
          }),
        ) as { status?: AppStatus | null };
        set(s => {
          s.statusByApp[appId] = body.status ?? null;
        });
      } catch {
        // Status is advisory; stale data is acceptable.
      }
    },

    fetchHistory: async (workspaceId, appId, scope = "app") => {
      try {
        // Show the branch the user's box is actually on (VS Code's graph
        // follows HEAD); the server falls back to the default branch when
        // the ref is unknown, so a stale value degrades gracefully. The
        // Source Control panel asks for repo scope — its CHANGES list is
        // repo-wide, and a graph that hides your own cross-app commit is
        // worse than useless.
        const ref = get().statusByApp[appId]?.branch;
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps/{id}/history", {
            params: {
              path: { workspaceId, id: appId },
              query: { ...(ref ? { ref } : {}), scope },
            },
          }),
        ) as { commits?: AppCommit[] };
        set(s => {
          if (scope === "repo") s.repoHistoryByApp[appId] = body.commits ?? [];
          else s.historyByApp[appId] = body.commits ?? [];
        });
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to load history");
        });
      }
    },

    fetchViewUrl: async (workspaceId, appId) => {
      try {
        const body = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps/{id}/view-token", {
            params: { path: { workspaceId, id: appId } },
          }),
        ) as { url?: string };
        set(s => {
          s.viewUrlByApp[appId] = body.url;
        });
      } catch {
        // Not published, or the token could not be minted. The workspace
        // shows its "nothing to view yet" state rather than a broken frame.
        set(s => {
          s.viewUrlByApp[appId] = undefined;
        });
      }
    },

    setEditing: (workspaceId, appId, editing) => {
      set(s => {
        s.editingByApp[appId] = editing;
      });
      // NOT persisted to localStorage. Whether the workbench opens is derived
      // from box truth (a running dev server), decided on mount — persisting a
      // flag here auto-opened the workbench over an empty box and disagreed
      // with the green dot (apps.md §13.11: the box is the one source of
      // truth for "is this running").
      // Entering edit mode starts a sandbox, and the sandbox is what reads
      // are served from — so re-read once it exists, or the tree stays on the
      // committed view until something else changes.
      if (editing) {
        void get().fetchFiles(workspaceId, appId);
        void get().fetchStatus(workspaceId, appId);
      }
    },

    fetchBranches: async (workspaceId, appId) => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps/{id}/branches", {
            params: { path: { workspaceId, id: appId } },
          }),
        ) as { branches?: AppBranch[] };
        set(s => {
          s.branchesByApp[appId] = body.branches ?? [];
        });
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to load branches");
        });
      }
    },

    checkoutBranch: async (workspaceId, appId, branch, options) => {
      try {
        unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps/{id}/checkout", {
            params: { path: { workspaceId, id: appId } },
            body: { branch, ...(options?.create ? { create: true } : {}) },
          }),
        );
        // Everything on screen was showing the OLD branch.
        await Promise.all([
          get().fetchFiles(workspaceId, appId),
          get().fetchStatus(workspaceId, appId),
          get().fetchBranches(workspaceId, appId),
        ]);
        return null;
      } catch (e) {
        return message(e, `Failed to switch to ${branch}`);
      }
    },

    mergeBranch: async (workspaceId, appId, branch) => {
      try {
        const body = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps/{id}/merge", {
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

    commit: async (workspaceId, appId, msg, options) => {
      try {
        const body = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps/{id}/commit", {
            params: { path: { workspaceId, id: appId } },
            body: { message: msg, stagedOnly: options?.stagedOnly },
          }),
        ) as { result?: { committed: boolean; reason?: string } };
        void get().fetchStatus(workspaceId, appId);
        void get().fetchHistory(workspaceId, appId);
        void get().fetchHistory(workspaceId, appId, "repo");
        if (body.result?.committed) return { ok: true };
        return { ok: false, error: body.result?.reason ?? "Nothing to commit" };
      } catch (e) {
        return { ok: false, error: message(e, "Commit failed") };
      }
    },

    gitPaths: async (workspaceId, appId, action, paths) => {
      try {
        await api.POST(
          `/api/workspaces/{workspaceId}/apps/{id}/git/${action}` as "/api/workspaces/{workspaceId}/apps/{id}/git/stage",
          { params: { path: { workspaceId, id: appId } }, body: { paths } },
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, error: message(e, `Could not ${action}`) };
      }
    },

    fetchFileVersions: async (workspaceId, appId, path) => {
      try {
        const body = unwrapBody(
          await api.GET(
            "/api/workspaces/{workspaceId}/apps/{id}/git/file-versions",
            { params: { path: { workspaceId, id: appId }, query: { path } } },
          ),
        ) as { versions?: AppFileVersions };
        return body.versions ?? null;
      } catch {
        return null;
      }
    },

    discard: async (workspaceId, appId) => {
      try {
        unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/apps/{id}/discard", {
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

    publishApp: async (workspaceId, appId) => {
      set(s => {
        s.previewByApp[appId] = {
          ...(s.previewByApp[appId] ?? { url: null }),
          building: true,
          publishing: true,
          buildOutput: "",
          error: null,
        };
      });
      // Tail the sandbox build log while the publish runs, so the terminal
      // shows npm install + vite build live instead of a silent spinner.
      let stopTail = false;
      const tail = (async () => {
        let offset = 0;
        while (!stopTail) {
          try {
            const res = await fetch(
              `/api/workspaces/${workspaceId}/apps/${appId}/build/log?offset=${offset}`,
              { credentials: "include" },
            );
            if (res.ok) {
              const body = (await res.json()) as {
                size?: number;
                chunk?: string;
              };
              if (body.chunk) {
                set(s => {
                  const p = s.previewByApp[appId];
                  if (p) p.buildOutput = (p.buildOutput ?? "") + body.chunk;
                });
              }
              offset = body.size ?? offset;
            }
          } catch {
            // A missed poll is fine; the next one resumes from `offset`.
          }
          await new Promise(r => setTimeout(r, 500));
        }
      })();
      try {
        const res = await api.POST(
          "/api/workspaces/{workspaceId}/apps/{id}/publish",
          {
            params: { path: { workspaceId, id: appId } },
            body: {},
          },
        );
        const raw = (res.data ?? res.error) as
          | { success?: boolean; sha?: string; error?: string; output?: string }
          | undefined;
        if (res.response.ok && raw?.sha) {
          set(s => {
            const app = s.apps.find(a => a.id === appId);
            if (app) {
              app.publishedSha = raw.sha;
              app.publishedAt = new Date().toISOString();
            }
            const p = s.previewByApp[appId];
            s.previewByApp[appId] = {
              ...(p ?? { url: null }),
              building: false,
              publishing: false,
              error: null,
            };
          });
        } else {
          // Surface the build output (tsc/vite errors) — without it a failed
          // publish is just "Build failed" with nothing to act on. The full
          // build log is already in `buildOutput` (tailed live above).
          const detail = [raw?.error, raw?.output].filter(Boolean).join("\n\n");
          set(s => {
            const p = s.previewByApp[appId];
            s.previewByApp[appId] = {
              ...(p ?? { url: null }),
              building: false,
              publishing: false,
              error: detail || "Publish failed",
            };
          });
        }
      } catch (e) {
        set(s => {
          const p = s.previewByApp[appId];
          s.previewByApp[appId] = {
            ...(p ?? { url: null }),
            building: false,
            publishing: false,
            error: message(e, "Publish failed"),
          };
        });
      } finally {
        stopTail = true;
        void tail;
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
          "/api/workspaces/{workspaceId}/apps/{id}/preview",
          {
            params: { path: { workspaceId, id: appId } },
            body: undefined,
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

    fetchSandboxStats: async (workspaceId, appId) => {
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/apps/{id}/sandbox", {
          params: { path: { workspaceId, id: appId } },
        }),
      );
      return (body ?? null) as Record<string, unknown> | null;
    },

    recycleSandbox: async (workspaceId, appId) => {
      await api.POST(
        "/api/workspaces/{workspaceId}/apps/{id}/sandbox/recycle",
        { params: { path: { workspaceId, id: appId } } },
      );
    },

    stopDev: async (workspaceId, appId) => {
      // Kill ALL sessions server-side, not just the dev one: leaving old
      // shells alive meant re-entering dev mode reattached a museum of
      // terminals with their history. Best effort — an unreachable API
      // still flips the UI, and the box agent reconciles the dot.
      try {
        await api.DELETE(
          "/api/workspaces/{workspaceId}/apps/{id}/terminal-sessions",
          { params: { path: { workspaceId, id: appId } } },
        );
      } catch {
        // Best effort.
      }
      try {
        localStorage.removeItem(`apps-shells:${appId}`);
        localStorage.removeItem(`apps-term-active:${appId}`);
      } catch {
        // Best effort.
      }
      get().markDevDown(appId);
      get().setEditing(workspaceId, appId, false);
    },

    fetchAppBindings: async (workspaceId, appId) => {
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/apps/{id}/bindings", {
          params: { path: { workspaceId, id: appId } },
        }),
      ) as { bindings?: Array<Record<string, unknown> & { name: string }> };
      return body.bindings ?? [];
    },

    materializeAppBinding: async (workspaceId, appId, name) => {
      return unwrapBody(
        await api.POST(
          "/api/workspaces/{workspaceId}/apps/{id}/bindings/{name}/materialize",
          { params: { path: { workspaceId, id: appId, name } } },
        ),
      ) as Record<string, unknown>;
    },

    fetchRunningDevApps: async workspaceId => {
      const appId = get().apps[0]?.id;
      if (!appId) return;
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/apps/{id}/dev-servers", {
            params: { path: { workspaceId, id: appId } },
          }),
        ) as { running?: string[] };
        // A poll answered before a recycle must not overwrite the offline
        // push that arrived while it was in flight (§13.11: pushes win).
        if (get().boxStatus === "offline") return;
        set(s => {
          s.runningDevApps = body.running ?? [];
        });
      } catch {
        // Advisory dots; a failed probe changes nothing.
      }
    },

    killTerminalSession: async (workspaceId, appId, termId) => {
      try {
        await api.DELETE(
          "/api/workspaces/{workspaceId}/apps/{id}/terminal-sessions/{termId}",
          { params: { path: { workspaceId, id: appId, termId } } },
        );
      } catch {
        // Best effort — an unreachable API still lets the tab close; the
        // sandbox-side reaper collects orphans later.
      }
    },

    checkDevStatus: async (workspaceId, appId) => {
      try {
        const body = unwrapBody(
          await api.GET(
            "/api/workspaces/{workspaceId}/apps/{id}/dev-preview/status",
            { params: { path: { workspaceId, id: appId } } },
          ),
        ) as { serving?: boolean; url?: string; reachable?: boolean };
        // Stale probe vs offline push: the push wins (§13.11). A response
        // computed before the box died must not repaint dead-sandbox URLs.
        if (get().boxStatus === "offline") return;
        const url = body.url;
        if (body.serving && url) {
          // Discovery: a dev server is ALREADY running for this app (started
          // in another tab, another browser, or before a reload that lost
          // client state). Show it — do not make the user "start" a thing
          // that is running.
          get().markDevServing(appId, url, body.reachable);
          return;
        }
        if (body.serving === false) get().markDevDown(appId);
      } catch {
        // Advisory: an unreachable probe must not kill a working preview.
      }
    },

    markDevServing: (appId, url, reachable) => {
      try {
        localStorage.setItem(`apps-devurl:${appId}`, url);
      } catch {
        // Best effort.
      }
      set(s => {
        const current = s.previewByApp[appId];
        if (current?.building) return;
        if (current?.url !== url) {
          s.previewByApp[appId] = {
            url,
            building: false,
            error: null,
            builtAt: Date.now(),
            mode: "dev",
            reachable,
          };
          s.viewMode[appId] = "preview";
        } else if (current && current.reachable !== reachable) {
          current.reachable = reachable;
        }
      });
    },

    markDevDown: appId => {
      try {
        localStorage.removeItem(`apps-devurl:${appId}`);
      } catch {
        // Best effort.
      }
      set(s => {
        const preview = s.previewByApp[appId];
        // A launch in flight (building) is not "down": the snapshot that
        // arrived mid-boot simply predates the server.
        if (preview?.mode === "dev" && !preview.building) {
          s.previewByApp[appId] = {
            url: null,
            building: false,
            // PRESERVE a boot failure: the next 15s status poll used to
            // land here and wipe the error — the red "last start failed"
            // state lived for seconds, then vanished as if nothing
            // happened. Down is down; the error explains WHY.
            error: preview.error ?? null,
          };
        }
      });
    },

    setCurrentUserId: userId => {
      set(s => {
        s.currentUserId = userId;
      });
    },

    applyBoxState: (userId, state) => {
      const { currentUserId, apps } = get();
      // Diagnostics: `localStorage["apps-debug"] = "1"` records every
      // pushed snapshot on window.__appsBoxEvents for inspection.
      try {
        if (localStorage.getItem("apps-debug")) {
          const w = window as Window & {
            __appsBoxEvents?: unknown[];
          };
          (w.__appsBoxEvents ??= []).push({
            at: Date.now(),
            userId,
            currentUserId,
            state,
          });
        }
      } catch {
        // Best effort.
      }
      // Unknown identity = drop, not accept: while /me is still resolving in
      // a multi-user workspace, a TEAMMATE's box push must not paint this
      // client's dots and previews.
      if (!currentUserId || userId !== currentUserId) return;
      // Reactive box identity/liveness for the sandbox panel and, crucially,
      // preview coherence: a second browser learns the box's id and status the
      // instant they change, not on a poll.
      set(s => {
        if (state.status) s.boxStatus = state.status;
        if (state.sandboxId !== undefined) s.boxSandboxId = state.sandboxId;
        if (state.terminals != null) s.boxTerminals = state.terminals;
      });
      if (state.status === "offline") {
        // The box is gone — every dev-server URL now points at a dead sandbox.
        // Drop them so open previews flip to the launch state immediately
        // instead of showing E2B's "sandbox not found".
        set(s => {
          s.runningDevApps = [];
          s.boxTerminals = [];
        });
        for (const app of apps) get().markDevDown(app.id);
        // markDevDown only clears keys for apps we KNOW about; if this push
        // beat fetchApps, the loop above ran over nothing and stale URLs
        // survive into the next session. Purge the namespace wholesale —
        // every remembered dev URL died with the machine.
        try {
          for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k?.startsWith("apps-devurl:")) localStorage.removeItem(k);
          }
        } catch {
          // Best effort.
        }
        return;
      }
      if (state.devServers) {
        const serving = new Map(state.devServers.map(d => [d.slug, d]));
        set(s => {
          s.runningDevApps = [...serving.keys()];
        });
        for (const app of apps) {
          const entry = app.slug ? serving.get(app.slug) : undefined;
          if (entry?.url) {
            get().markDevServing(app.id, entry.url, entry.reachable);
          } else get().markDevDown(app.id);
        }
      }
      if (state.branch !== null || state.changes !== null) {
        set(s => {
          for (const app of apps) {
            const prev = s.statusByApp[app.id];
            const repoChanges = state.changes ?? prev?.repoChanges ?? [];
            s.statusByApp[app.id] = {
              branch: state.branch ?? prev?.branch ?? "main",
              baseSha: state.head ?? prev?.baseSha ?? "",
              branchHead: prev?.branchHead ?? null,
              ahead: state.ahead ?? prev?.ahead ?? 0,
              changes: repoChanges.filter(c =>
                c.path.startsWith(`apps/${app.slug}/`),
              ),
              repoChanges,
              offline: false,
            };
          }
        });
      }
    },

    fetchDevLog: async (workspaceId, appId, offset) => {
      try {
        const body = unwrapBody(
          await api.GET(
            "/api/workspaces/{workspaceId}/apps/{id}/dev-preview/log",
            {
              params: {
                path: { workspaceId, id: appId },
                query: { offset },
              },
            },
          ),
        ) as { size?: number; chunk?: string };
        return { size: body.size ?? 0, chunk: body.chunk ?? "" };
      } catch {
        // Polling: one missed beat is fine; the next one catches up.
        return { size: offset, chunk: "" };
      }
    },

    startDevPreview: async (workspaceId, appId, opts) => {
      // Optimistic reattach: if this app had a dev server last time, its URL
      // is almost certainly still valid (the sandbox sleeps rather than
      // dies), so show the iframe IMMEDIATELY and let the POST revalidate
      // behind it. Cold starts still show the boot state — there is no
      // remembered URL to be optimistic with. A stale URL costs a broken
      // iframe for the seconds until the POST corrects it; the alternative
      // cost 10+ seconds of "Starting..." on every reload, for a server
      // that was already running.
      let optimistic: string | null = null;
      try {
        optimistic = localStorage.getItem(`apps-devurl:${appId}`);
      } catch {
        // Storage unavailable — no optimism, same as before.
      }
      // The remembered URL embeds a sandbox id, and box truth can prove it
      // dead: an offline box, or a live box with a DIFFERENT id, means the
      // URL is a corpse — optimism would iframe E2B's error page for the
      // whole post-recycle cold boot (clone + install + vite, not seconds).
      const { boxStatus, boxSandboxId } = get();
      if (
        optimistic &&
        (boxStatus === "offline" ||
          (boxSandboxId && !optimistic.includes(boxSandboxId)))
      ) {
        optimistic = null;
        try {
          localStorage.removeItem(`apps-devurl:${appId}`);
        } catch {
          // Best effort.
        }
      }
      set(s => {
        s.previewByApp[appId] = optimistic
          ? {
              url: optimistic,
              building: false,
              error: null,
              builtAt: Date.now(),
              mode: "dev",
            }
          : {
              ...(s.previewByApp[appId] ?? { url: null }),
              building: true,
              error: null,
            };
        if (optimistic) s.viewMode[appId] = "preview";
      });
      try {
        // One retry, for the takeover shape: when another app's dev server
        // owns the port, the first request kills it, reinstalls and relaunches
        // — which can outlive a transport deadline even though the server
        // finishes the job. The second request finds the right server already
        // listening and returns in milliseconds. Retrying anything else once
        // is harmless; the second failure is the one reported.
        const restartBody = opts?.restart ? { restart: true } : undefined;
        let res = await api.POST(
          "/api/workspaces/{workspaceId}/apps/{id}/dev-preview",
          {
            params: { path: { workspaceId, id: appId } },
            body: restartBody,
          },
        );
        if (!res.response.ok) {
          // The retry must NOT restart again — the first call already did;
          // a second reap would kill the server it just booted.
          res = await api.POST(
            "/api/workspaces/{workspaceId}/apps/{id}/dev-preview",
            {
              params: { path: { workspaceId, id: appId } },
              body: undefined,
            },
          );
        }
        const raw = (res.data ?? res.error) as
          | {
              success?: boolean;
              url?: string;
              error?: string;
              evicted?: string[];
            }
          | undefined;
        if (res.response.ok && raw?.url) {
          // The box enforces a running cap; if starting this one closed
          // others, reflect that immediately instead of waiting for the next
          // running-servers poll — clear their dots and preview state.
          const evicted = raw.evicted ?? [];
          if (evicted.length) {
            const apps = get().apps;
            set(s => {
              s.runningDevApps = s.runningDevApps.filter(
                sl => !evicted.includes(sl),
              );
            });
            for (const sl of evicted) {
              const a = apps.find(x => x.slug === sl);
              if (a) get().markDevDown(a.id);
            }
          }
          try {
            localStorage.setItem(`apps-devurl:${appId}`, raw.url);
          } catch {
            // Best effort.
          }
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
