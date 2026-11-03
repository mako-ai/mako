/**
 * Git history of one entity's files in the workspace repo — consoles,
 * notebooks, flows and workspace connectors — in the shapes the apps History
 * popover reads (`AppCommit`, `AppCommitFile`, before/after versions).
 *
 * Every kind serves the same four routes (list, one commit's files, a file
 * before/after, restore-as-new-commit); only where they are mounted differs.
 * State is keyed `<kind>:<id>` so two kinds can never share an entry.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, unwrap } from "../api";
import type {
  AppCommit,
  AppCommitFile,
  AppCommitFileVersions,
} from "./appsStore";

export type HistoryEntityKind = "console" | "notebook" | "flow" | "connector";

interface HistoryBody {
  commits?: AppCommit[];
  path?: string | null;
}
interface CommitBody {
  commit?: { files?: AppCommitFile[] };
}
interface VersionsBody {
  versions?: AppCommitFileVersions;
}

interface Endpoints {
  history: (ws: string, id: string) => Promise<HistoryBody>;
  commit: (ws: string, id: string, sha: string) => Promise<CommitBody>;
  versions: (
    ws: string,
    id: string,
    sha: string,
    path: string,
  ) => Promise<VersionsBody>;
  restore: (ws: string, id: string, sha: string) => Promise<unknown>;
}

/** Where each kind mounts the four history routes. */
const ENDPOINTS: Record<HistoryEntityKind, Endpoints> = {
  console: {
    history: async (workspaceId, id) =>
      unwrap(
        await api.GET("/api/workspaces/{workspaceId}/consoles/{id}/history", {
          params: { path: { workspaceId, id } },
        }),
      ) as HistoryBody,
    commit: async (workspaceId, id, sha) =>
      unwrap(
        await api.GET(
          "/api/workspaces/{workspaceId}/consoles/{id}/git/commit",
          {
            params: { path: { workspaceId, id }, query: { sha } },
          },
        ),
      ) as CommitBody,
    versions: async (workspaceId, id, sha, path) =>
      unwrap(
        await api.GET(
          "/api/workspaces/{workspaceId}/consoles/{id}/git/file-versions",
          { params: { path: { workspaceId, id }, query: { sha, path } } },
        ),
      ) as VersionsBody,
    restore: async (workspaceId, id, sha) =>
      unwrap(
        await api.POST("/api/workspaces/{workspaceId}/consoles/{id}/restore", {
          params: { path: { workspaceId, id } },
          body: { sha },
        }),
      ),
  },
  notebook: {
    history: async (workspaceId, id) =>
      unwrap(
        await api.GET("/api/workspaces/{workspaceId}/notebooks/{id}/history", {
          params: { path: { workspaceId, id } },
        }),
      ) as HistoryBody,
    commit: async (workspaceId, id, sha) =>
      unwrap(
        await api.GET(
          "/api/workspaces/{workspaceId}/notebooks/{id}/git/commit",
          { params: { path: { workspaceId, id }, query: { sha } } },
        ),
      ) as CommitBody,
    versions: async (workspaceId, id, sha, path) =>
      unwrap(
        await api.GET(
          "/api/workspaces/{workspaceId}/notebooks/{id}/git/file-versions",
          { params: { path: { workspaceId, id }, query: { sha, path } } },
        ),
      ) as VersionsBody,
    restore: async (workspaceId, id, sha) =>
      unwrap(
        await api.POST("/api/workspaces/{workspaceId}/notebooks/{id}/restore", {
          params: { path: { workspaceId, id } },
          body: { sha },
        }),
      ),
  },
  flow: {
    history: async (workspaceId, flowId) =>
      unwrap(
        await api.GET(
          "/api/workspaces/{workspaceId}/flows/{flowId}/git/history",
          { params: { path: { workspaceId, flowId } } },
        ),
      ) as HistoryBody,
    commit: async (workspaceId, flowId, sha) =>
      unwrap(
        await api.GET(
          "/api/workspaces/{workspaceId}/flows/{flowId}/git/commit",
          { params: { path: { workspaceId, flowId }, query: { sha } } },
        ),
      ) as CommitBody,
    versions: async (workspaceId, flowId, sha, path) =>
      unwrap(
        await api.GET(
          "/api/workspaces/{workspaceId}/flows/{flowId}/git/file-versions",
          { params: { path: { workspaceId, flowId }, query: { sha, path } } },
        ),
      ) as VersionsBody,
    restore: async (workspaceId, flowId, sha) =>
      unwrap(
        await api.POST(
          "/api/workspaces/{workspaceId}/flows/{flowId}/git/restore",
          { params: { path: { workspaceId, flowId } }, body: { sha } },
        ),
      ),
  },
  connector: {
    history: async (workspaceId, slug) =>
      unwrap(
        await api.GET(
          "/api/workspaces/{workspaceId}/connector-definitions/{slug}/git/history",
          { params: { path: { workspaceId, slug } } },
        ),
      ) as HistoryBody,
    commit: async (workspaceId, slug, sha) =>
      unwrap(
        await api.GET(
          "/api/workspaces/{workspaceId}/connector-definitions/{slug}/git/commit",
          { params: { path: { workspaceId, slug }, query: { sha } } },
        ),
      ) as CommitBody,
    versions: async (workspaceId, slug, sha, path) =>
      unwrap(
        await api.GET(
          "/api/workspaces/{workspaceId}/connector-definitions/{slug}/git/file-versions",
          { params: { path: { workspaceId, slug }, query: { sha, path } } },
        ),
      ) as VersionsBody,
    restore: async (workspaceId, slug, sha) =>
      unwrap(
        await api.POST(
          "/api/workspaces/{workspaceId}/connector-definitions/{slug}/git/restore",
          { params: { path: { workspaceId, slug } }, body: { sha } },
        ),
      ),
  },
};

export function historyKey(kind: HistoryEntityKind, id: string): string {
  return `${kind}:${id}`;
}

interface EntityHistoryState {
  history: Record<string, AppCommit[]>;
  /** The repo path (file, or folder with a trailing slash) the history follows. */
  path: Record<string, string | null>;
  commitFiles: Record<string, Record<string, AppCommitFile[]>>;
  error: string | null;

  fetchHistory: (
    kind: HistoryEntityKind,
    workspaceId: string,
    id: string,
  ) => Promise<void>;
  fetchCommitFiles: (
    kind: HistoryEntityKind,
    workspaceId: string,
    id: string,
    sha: string,
  ) => Promise<AppCommitFile[] | null>;
  fetchCommitFileVersions: (
    kind: HistoryEntityKind,
    workspaceId: string,
    id: string,
    sha: string,
    path: string,
  ) => Promise<AppCommitFileVersions | null>;
  restoreVersion: (
    kind: HistoryEntityKind,
    workspaceId: string,
    id: string,
    sha: string,
  ) => Promise<void>;
}

function message(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export const useEntityHistoryStore = create<EntityHistoryState>()(
  immer((set, get) => ({
    history: {},
    path: {},
    commitFiles: {},
    error: null,

    fetchHistory: async (kind, workspaceId, id) => {
      const key = historyKey(kind, id);
      try {
        const body = await ENDPOINTS[kind].history(workspaceId, id);
        set(s => {
          s.history[key] = body.commits ?? [];
          s.path[key] = body.path ?? null;
          s.error = null;
        });
      } catch (e) {
        set(s => {
          s.history[key] = [];
          s.error = message(e, "Failed to load the history");
        });
      }
    },

    fetchCommitFiles: async (kind, workspaceId, id, sha) => {
      const key = historyKey(kind, id);
      const cached = get().commitFiles[key]?.[sha];
      if (cached) return cached;
      try {
        const body = await ENDPOINTS[kind].commit(workspaceId, id, sha);
        const files = body.commit?.files ?? [];
        set(s => {
          (s.commitFiles[key] ??= {})[sha] = files;
        });
        return files;
      } catch (e) {
        set(s => {
          s.error = message(e, "Failed to load the commit");
        });
        return null;
      }
    },

    fetchCommitFileVersions: async (kind, workspaceId, id, sha, path) => {
      try {
        const body = await ENDPOINTS[kind].versions(workspaceId, id, sha, path);
        return body.versions ?? null;
      } catch {
        return null;
      }
    },

    restoreVersion: async (kind, workspaceId, id, sha) => {
      await ENDPOINTS[kind].restore(workspaceId, id, sha);
      set(s => {
        delete s.commitFiles[historyKey(kind, id)];
      });
      await get().fetchHistory(kind, workspaceId, id);
    },
  })),
);
