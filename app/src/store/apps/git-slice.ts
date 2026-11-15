/**
 * Per-app git state: status, history, branches, commits, restore and
 * rollback, plus the stale-marking that keeps them fresh.
 */
import { api, unwrapBody, toErrorMessage as message } from "../../api";
import {
  loadWorkspaceBranches,
  forgetInFlightBranches,
  ensureActivationDrain,
} from "./runtime";
import type {
  AppFileVersions,
  AppStatus,
  AppCommit,
  AppPublishState,
  AppCommitFile,
  AppCommitFileVersions,
} from "./types";
import type { AppsSlice } from "./slice";

type Keys =
  | "fetchStatus"
  | "fetchPublishState"
  | "fetchHistory"
  | "markAllAppsStale"
  | "refreshAppIfStale"
  | "fetchBranches"
  | "checkoutBranch"
  | "mergeBranch"
  | "commit"
  | "gitPaths"
  | "fetchCommitFiles"
  | "fetchCommitFileVersions"
  | "restoreVersion"
  | "rollbackTo"
  | "fetchFileVersions"
  | "discard";

export const createAppsGitSlice: AppsSlice<Keys> = (set, get) => ({
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

  fetchPublishState: async (workspaceId, appId) => {
    try {
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/apps/{id}/publish-state", {
          params: { path: { workspaceId, id: appId } },
        }),
      ) as { state?: AppPublishState };
      if (!body.state) return;
      set(s => {
        s.publishStateByApp[appId] = body.state;
      });
    } catch {
      // Context for a tooltip: the chip still shows the sha and date
      // without it, so a failure here is not worth an error banner.
    }
  },

  fetchHistory: async (workspaceId, appId) => {
    try {
      // Show the branch the user's box is actually on (VS Code's graph
      // follows HEAD); the server falls back to the default branch when
      // the ref is unknown, so a stale value degrades gracefully.
      // Repo-wide history lives in repoStore now; this is the app's own.
      const ref = get().statusByApp[appId]?.branch;
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/apps/{id}/history", {
          params: {
            path: { workspaceId, id: appId },
            query: { ...(ref ? { ref } : {}), scope: "app" },
          },
        }),
      ) as { commits?: AppCommit[] };
      set(s => {
        s.historyByApp[appId] = body.commits ?? [];
      });
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to load history");
      });
    }
  },

  markAllAppsStale: () => {
    ensureActivationDrain((ws, id) => get().refreshAppIfStale(ws, id));
    set(s => {
      for (const appId of Object.keys(s.filesByApp)) {
        s.staleApps[appId] = true;
      }
      for (const appId of Object.keys(s.branchesByApp)) {
        s.staleApps[appId] = true;
      }
    });
  },

  refreshAppIfStale: (workspaceId, appId) => {
    const state = get();
    if (!state.staleApps[appId]) return;
    set(s => {
      delete s.staleApps[appId];
    });
    if (state.filesByApp[appId]) {
      void state.fetchFiles(workspaceId, appId);
      void state.fetchStatus(workspaceId, appId);
    }
    if (state.branchesByApp[appId]) {
      void state.fetchBranches(workspaceId, appId);
    }
    const selected = state.selectedFile[appId];
    if (selected) {
      const entry = state.fileContents[`${appId}\u0000${selected}`];
      if (entry && !entry.dirty) {
        void state.openFile(workspaceId, appId, selected);
      }
    }
  },

  fetchBranches: async (workspaceId, appId) => {
    try {
      const branches = await loadWorkspaceBranches(workspaceId, appId);
      set(s => {
        s.branchesByApp[appId] = branches;
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
      forgetInFlightBranches(workspaceId);
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
      forgetInFlightBranches(workspaceId);
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
      if (body.result?.committed) return { ok: true };
      return {
        ok: false,
        error: body.result?.reason ?? "Nothing to commit",
      };
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

  fetchCommitFiles: async (workspaceId, appId, sha, scope = "app") => {
    const key = scope === "repo" ? `repo:${sha}` : sha;
    const cached = get().commitFilesByApp[appId]?.[key];
    if (cached) return cached;
    try {
      const body = unwrapBody(
        await api.GET("/api/workspaces/{workspaceId}/apps/{id}/git/commit", {
          params: {
            path: { workspaceId, id: appId },
            query: { sha, scope },
          },
        }),
      ) as { commit?: { files?: AppCommitFile[] } };
      const files = body.commit?.files ?? [];
      set(s => {
        (s.commitFilesByApp[appId] ??= {})[key] = files;
      });
      return files;
    } catch (e) {
      set(s => {
        s.error = message(e, "Failed to load the commit");
      });
      return null;
    }
  },

  fetchCommitFileVersions: async (workspaceId, appId, sha, path) => {
    try {
      const body = unwrapBody(
        await api.GET(
          "/api/workspaces/{workspaceId}/apps/{id}/git/file-versions",
          {
            params: {
              path: { workspaceId, id: appId },
              query: { path, sha },
            },
          },
        ),
      ) as { versions?: AppCommitFileVersions };
      return body.versions ?? null;
    } catch {
      return null;
    }
  },

  restoreVersion: async (workspaceId, appId, sha) => {
    unwrapBody(
      await api.POST("/api/workspaces/{workspaceId}/apps/{id}/restore", {
        params: { path: { workspaceId, id: appId } },
        body: { sha },
      }),
    );
    // Same cache hygiene as discard: contents changed under every open tab.
    set(s => {
      for (const key of Object.keys(s.fileContents)) {
        if (key.startsWith(`${appId}\u0000`)) delete s.fileContents[key];
      }
    });
    void get().fetchFiles(workspaceId, appId);
    void get().fetchStatus(workspaceId, appId);
    void get().fetchHistory(workspaceId, appId);
    const selected = get().selectedFile[appId];
    if (selected) void get().openFile(workspaceId, appId, selected);
  },

  rollbackTo: async (workspaceId, appId, sha) => {
    unwrapBody(
      await api.POST("/api/workspaces/{workspaceId}/apps/{id}/rollback", {
        params: { path: { workspaceId, id: appId } },
        body: { sha },
      }),
    );
    set(s => {
      const app = s.apps.find(a => a.id === appId);
      if (app) {
        app.publishedSha = sha;
        app.publishedAt = new Date().toISOString();
      }
    });
    void get().fetchViewUrl(workspaceId, appId);
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
});
