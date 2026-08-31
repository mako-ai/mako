/**
 * The workspace repository — status, branches, history, commits — keyed by
 * WORKSPACE, not by app.
 *
 * The Source Control panel and the rail's dirty dot used to reach the repo
 * through "any app id" (`apps[0].id` + app routes with `scope=repo`), which
 * left a workspace whose repo holds only consoles — or, after Block D3, only
 * dbt — with a blank panel. This store talks to `/repo/*`, which needs no app
 * handle. Shapes are shared with appsStore (`AppStatus`, `AppCommit`, …) so
 * CommitRow / GitFileDiffView render either source unchanged.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, unwrapBody, toErrorMessage as message } from "../api";
import type {
  AppBranch,
  AppCommit,
  AppCommitFile,
  AppCommitFileVersions,
  AppFileVersions,
  AppStatus,
} from "./appsStore";

interface RepoState {
  /** null = probed, no repo; undefined = not probed yet. */
  hasRepoByWorkspace: Record<string, boolean>;
  statusByWorkspace: Record<string, AppStatus | null>;
  historyByWorkspace: Record<string, AppCommit[]>;
  branchesByWorkspace: Record<string, AppBranch[]>;
  commitFilesByWorkspace: Record<string, Record<string, AppCommitFile[]>>;
  error: string | null;

  fetchStatus: (workspaceId: string) => Promise<void>;
  fetchHistory: (workspaceId: string) => Promise<void>;
  fetchBranches: (workspaceId: string) => Promise<void>;
  checkoutBranch: (
    workspaceId: string,
    branch: string,
    options?: { create?: boolean },
  ) => Promise<string | null>;
  mergeBranch: (
    workspaceId: string,
    branch: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  commit: (
    workspaceId: string,
    message: string,
    options?: { stagedOnly?: boolean },
  ) => Promise<{ ok: boolean; error?: string }>;
  gitPaths: (
    workspaceId: string,
    action: "stage" | "unstage" | "discard",
    paths: string[],
  ) => Promise<{ ok: boolean; error?: string }>;
  fetchCommitFiles: (
    workspaceId: string,
    sha: string,
  ) => Promise<AppCommitFile[] | null>;
  fetchCommitFileVersions: (
    workspaceId: string,
    sha: string,
    path: string,
  ) => Promise<AppCommitFileVersions | null>;
  fetchFileVersions: (
    workspaceId: string,
    path: string,
  ) => Promise<AppFileVersions | null>;
  getGitHubInstallUrl: (workspaceId: string) => Promise<string | null>;
  fetchGithubBranches: (
    workspaceId: string,
    owner: string,
    repo: string,
    installationId?: number,
  ) => Promise<string[]>;
}

export const useRepoStore = create<RepoState>()(
  immer((set, get) => ({
    hasRepoByWorkspace: {},
    statusByWorkspace: {},
    historyByWorkspace: {},
    branchesByWorkspace: {},
    commitFilesByWorkspace: {},
    error: null,

    fetchStatus: async workspaceId => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/repo/status", {
            params: { path: { workspaceId } },
          }),
        ) as { hasRepo?: boolean; status?: AppStatus | null };
        set(s => {
          s.hasRepoByWorkspace[workspaceId] = body.hasRepo ?? false;
          s.statusByWorkspace[workspaceId] = body.status ?? null;
        });
      } catch {
        // Status is advisory; stale data is acceptable.
      }
    },

    fetchHistory: async workspaceId => {
      try {
        // Follow the branch the user's box is actually on (VS Code's graph
        // follows HEAD); the server falls back to the default branch when
        // the ref is unknown, so a stale value degrades gracefully.
        const ref = get().statusByWorkspace[workspaceId]?.branch;
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/repo/history", {
            params: {
              path: { workspaceId },
              query: { ...(ref ? { ref } : {}) },
            },
          }),
        ) as { commits?: AppCommit[] };
        set(s => {
          s.historyByWorkspace[workspaceId] = body.commits ?? [];
        });
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to load history");
        });
      }
    },

    fetchBranches: async workspaceId => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/repo/branches", {
            params: { path: { workspaceId } },
          }),
        ) as { branches?: AppBranch[] };
        set(s => {
          s.branchesByWorkspace[workspaceId] = body.branches ?? [];
        });
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to load branches");
        });
      }
    },

    checkoutBranch: async (workspaceId, branch, options) => {
      try {
        unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/repo/checkout", {
            params: { path: { workspaceId } },
            body: { branch, ...(options?.create ? { create: true } : {}) },
          }),
        );
        await Promise.all([
          get().fetchStatus(workspaceId),
          get().fetchBranches(workspaceId),
        ]);
        return null;
      } catch (e) {
        return message(e, `Failed to switch to ${branch}`);
      }
    },

    mergeBranch: async (workspaceId, branch) => {
      try {
        const body = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/repo/merge", {
            params: { path: { workspaceId } },
            body: { branch },
          }),
        ) as { result?: { merged: boolean; reason?: string } };
        void get().fetchBranches(workspaceId);
        void get().fetchStatus(workspaceId);
        void get().fetchHistory(workspaceId);
        if (body.result?.merged) return { ok: true };
        return { ok: false, error: body.result?.reason ?? "Nothing to merge" };
      } catch (e) {
        return { ok: false, error: message(e, "Merge failed") };
      }
    },

    commit: async (workspaceId, msg, options) => {
      try {
        const body = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/repo/commit", {
            params: { path: { workspaceId } },
            body: { message: msg, stagedOnly: options?.stagedOnly },
          }),
        ) as { result?: { committed: boolean; reason?: string } };
        void get().fetchStatus(workspaceId);
        void get().fetchHistory(workspaceId);
        if (body.result?.committed) return { ok: true };
        return { ok: false, error: body.result?.reason ?? "Nothing to commit" };
      } catch (e) {
        return { ok: false, error: message(e, "Commit failed") };
      }
    },

    gitPaths: async (workspaceId, action, paths) => {
      try {
        await api.POST(
          `/api/workspaces/{workspaceId}/repo/git/${action}` as "/api/workspaces/{workspaceId}/repo/git/stage",
          { params: { path: { workspaceId } }, body: { paths } },
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, error: message(e, `Could not ${action}`) };
      }
    },

    fetchCommitFiles: async (workspaceId, sha) => {
      const cached = get().commitFilesByWorkspace[workspaceId]?.[sha];
      if (cached) return cached;
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/repo/git/commit", {
            params: { path: { workspaceId }, query: { sha } },
          }),
        ) as { commit?: { files?: AppCommitFile[] } };
        const files = body.commit?.files ?? [];
        set(s => {
          (s.commitFilesByWorkspace[workspaceId] ??= {})[sha] = files;
        });
        return files;
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to load the commit");
        });
        return null;
      }
    },

    fetchCommitFileVersions: async (workspaceId, sha, path) => {
      try {
        const body = unwrapBody(
          await api.GET(
            "/api/workspaces/{workspaceId}/repo/git/file-versions",
            { params: { path: { workspaceId }, query: { sha, path } } },
          ),
        ) as { versions?: AppCommitFileVersions };
        return body.versions ?? null;
      } catch {
        return null;
      }
    },

    fetchFileVersions: async (workspaceId, path) => {
      try {
        const body = unwrapBody(
          await api.GET(
            "/api/workspaces/{workspaceId}/repo/git/file-versions",
            { params: { path: { workspaceId }, query: { path } } },
          ),
        ) as { versions?: AppFileVersions };
        return body.versions ?? null;
      } catch {
        return null;
      }
    },

    getGitHubInstallUrl: async workspaceId => {
      try {
        const body = unwrapBody(
          await api.GET(
            "/api/workspaces/{workspaceId}/repo/github/install-url",
            { params: { path: { workspaceId } } },
          ),
        ) as { url?: string };
        return body.url ?? null;
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to start GitHub App install");
        });
        return null;
      }
    },

    fetchGithubBranches: async (workspaceId, owner, repo, installationId) => {
      try {
        const body = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/repo/github/branches", {
            params: {
              path: { workspaceId },
              query: {
                owner,
                repo,
                ...(installationId ? { installationId } : {}),
              },
            },
          }),
        ) as { branches?: string[] };
        return body.branches ?? [];
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to list branches");
        });
        return [];
      }
    },
  })),
);
