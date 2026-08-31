/**
 * A console's git history — the same shapes the apps History popover reads
 * (`AppCommit`, `AppCommitFile`, before/after versions), served by the
 * console routes that read the workspace repo (apps.md §16).
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, unwrap } from "../api";
import type {
  AppCommit,
  AppCommitFile,
  AppCommitFileVersions,
} from "./appsStore";

interface ConsoleHistoryState {
  historyByConsole: Record<string, AppCommit[]>;
  pathByConsole: Record<string, string | null>;
  commitFilesByConsole: Record<string, Record<string, AppCommitFile[]>>;
  error: string | null;

  fetchHistory: (workspaceId: string, consoleId: string) => Promise<void>;
  fetchCommitFiles: (
    workspaceId: string,
    consoleId: string,
    sha: string,
  ) => Promise<AppCommitFile[] | null>;
  fetchCommitFileVersions: (
    workspaceId: string,
    consoleId: string,
    sha: string,
    path: string,
  ) => Promise<AppCommitFileVersions | null>;
  restoreVersion: (
    workspaceId: string,
    consoleId: string,
    sha: string,
  ) => Promise<void>;
  clear: (consoleId: string) => void;
}

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export const useConsoleHistoryStore = create<ConsoleHistoryState>()(
  immer((set, get) => ({
    historyByConsole: {},
    pathByConsole: {},
    commitFilesByConsole: {},
    error: null,

    fetchHistory: async (workspaceId, consoleId) => {
      try {
        const body = unwrap(
          await api.GET("/api/workspaces/{workspaceId}/consoles/{id}/history", {
            params: { path: { workspaceId, id: consoleId } },
          }),
        ) as { commits?: AppCommit[]; path?: string | null };
        set(s => {
          s.historyByConsole[consoleId] = body.commits ?? [];
          s.pathByConsole[consoleId] = body.path ?? null;
          s.error = null;
        });
      } catch (e) {
        set(s => {
          s.historyByConsole[consoleId] = [];
          s.error = message(e, "Failed to load the history");
        });
      }
    },

    fetchCommitFiles: async (workspaceId, consoleId, sha) => {
      const cached = get().commitFilesByConsole[consoleId]?.[sha];
      if (cached) return cached;
      try {
        const body = unwrap(
          await api.GET(
            "/api/workspaces/{workspaceId}/consoles/{id}/git/commit",
            {
              params: { path: { workspaceId, id: consoleId }, query: { sha } },
            },
          ),
        ) as { commit?: { files?: AppCommitFile[] } };
        const files = body.commit?.files ?? [];
        set(s => {
          (s.commitFilesByConsole[consoleId] ??= {})[sha] = files;
        });
        return files;
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to load the commit");
        });
        return null;
      }
    },

    fetchCommitFileVersions: async (workspaceId, consoleId, sha, path) => {
      try {
        const body = unwrap(
          await api.GET(
            "/api/workspaces/{workspaceId}/consoles/{id}/git/file-versions",
            {
              params: {
                path: { workspaceId, id: consoleId },
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

    restoreVersion: async (workspaceId, consoleId, sha) => {
      unwrap(
        await api.POST("/api/workspaces/{workspaceId}/consoles/{id}/restore", {
          params: { path: { workspaceId, id: consoleId } },
          body: { sha },
        }),
      );
      set(s => {
        delete s.commitFilesByConsole[consoleId];
      });
      await get().fetchHistory(workspaceId, consoleId);
    },

    clear: consoleId => {
      set(s => {
        delete s.historyByConsole[consoleId];
        delete s.commitFilesByConsole[consoleId];
        delete s.pathByConsole[consoleId];
      });
    },
  })),
);
