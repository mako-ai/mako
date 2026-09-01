/**
 * A notebook's git history — the same shapes the apps History popover reads
 * (`AppCommit`, `AppCommitFile`, before/after versions), served by the
 * notebook routes that read the workspace repo (apps.md §24).
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, unwrap } from "../api";
import type {
  AppCommit,
  AppCommitFile,
  AppCommitFileVersions,
} from "./appsStore";

interface NotebookHistoryState {
  historyByNotebook: Record<string, AppCommit[]>;
  pathByNotebook: Record<string, string | null>;
  commitFilesByNotebook: Record<string, Record<string, AppCommitFile[]>>;
  error: string | null;

  fetchHistory: (workspaceId: string, notebookId: string) => Promise<void>;
  fetchCommitFiles: (
    workspaceId: string,
    notebookId: string,
    sha: string,
  ) => Promise<AppCommitFile[] | null>;
  fetchCommitFileVersions: (
    workspaceId: string,
    notebookId: string,
    sha: string,
    path: string,
  ) => Promise<AppCommitFileVersions | null>;
  restoreVersion: (
    workspaceId: string,
    notebookId: string,
    sha: string,
  ) => Promise<void>;
  clear: (notebookId: string) => void;
}

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export const useNotebookHistoryStore = create<NotebookHistoryState>()(
  immer((set, get) => ({
    historyByNotebook: {},
    pathByNotebook: {},
    commitFilesByNotebook: {},
    error: null,

    fetchHistory: async (workspaceId, notebookId) => {
      try {
        const body = unwrap(
          await api.GET(
            "/api/workspaces/{workspaceId}/notebooks/{id}/history",
            {
              params: { path: { workspaceId, id: notebookId } },
            },
          ),
        ) as { commits?: AppCommit[]; path?: string | null };
        set(s => {
          s.historyByNotebook[notebookId] = body.commits ?? [];
          s.pathByNotebook[notebookId] = body.path ?? null;
          s.error = null;
        });
      } catch (e) {
        set(s => {
          s.historyByNotebook[notebookId] = [];
          s.error = message(e, "Failed to load the history");
        });
      }
    },

    fetchCommitFiles: async (workspaceId, notebookId, sha) => {
      const cached = get().commitFilesByNotebook[notebookId]?.[sha];
      if (cached) return cached;
      try {
        const body = unwrap(
          await api.GET(
            "/api/workspaces/{workspaceId}/notebooks/{id}/git/commit",
            {
              params: { path: { workspaceId, id: notebookId }, query: { sha } },
            },
          ),
        ) as { commit?: { files?: AppCommitFile[] } };
        const files = body.commit?.files ?? [];
        set(s => {
          (s.commitFilesByNotebook[notebookId] ??= {})[sha] = files;
        });
        return files;
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to load the commit");
        });
        return null;
      }
    },

    fetchCommitFileVersions: async (workspaceId, notebookId, sha, path) => {
      try {
        const body = unwrap(
          await api.GET(
            "/api/workspaces/{workspaceId}/notebooks/{id}/git/file-versions",
            {
              params: {
                path: { workspaceId, id: notebookId },
                query: { sha, path },
              },
            },
          ),
        ) as { versions?: AppCommitFileVersions };
        return body.versions ?? null;
      } catch {
        return null;
      }
    },

    restoreVersion: async (workspaceId, notebookId, sha) => {
      unwrap(
        await api.POST("/api/workspaces/{workspaceId}/notebooks/{id}/restore", {
          params: { path: { workspaceId, id: notebookId } },
          body: { sha },
        }),
      );
      set(s => {
        delete s.commitFilesByNotebook[notebookId];
      });
      await get().fetchHistory(workspaceId, notebookId);
    },

    clear: notebookId => {
      set(s => {
        delete s.historyByNotebook[notebookId];
        delete s.commitFilesByNotebook[notebookId];
        delete s.pathByNotebook[notebookId];
      });
    },
  })),
);
