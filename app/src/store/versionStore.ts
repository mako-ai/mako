import { create } from "zustand";
import { api, unwrap } from "../api";

/** Typed versions base path per entity type. */
const VERSION_BASE = {
  console: "/api/workspaces/{workspaceId}/consoles/{id}/versions",
  dashboard: "/api/workspaces/{workspaceId}/dashboards/{id}/versions",
} as const;

export interface VersionListItem {
  version: number;
  savedBy: string;
  savedByName: string;
  comment: string;
  restoredFrom?: number | null;
  createdAt: string;
}

export interface VersionDetail extends VersionListItem {
  snapshot: Record<string, unknown>;
}

interface VersionStoreState {
  versions: Record<string, VersionListItem[]>;
  totals: Record<string, number>;
  loading: Record<string, boolean>;

  fetchVersionHistory: (
    workspaceId: string,
    entityType: "console" | "dashboard",
    entityId: string,
    opts?: { limit?: number; offset?: number },
  ) => Promise<void>;

  fetchVersion: (
    workspaceId: string,
    entityType: "console" | "dashboard",
    entityId: string,
    version: number,
  ) => Promise<VersionDetail | null>;

  restoreVersion: (
    workspaceId: string,
    entityType: "console" | "dashboard",
    entityId: string,
    version: number,
    comment?: string,
  ) => Promise<{ success: boolean; error?: string }>;

  clearHistory: (entityId: string) => void;
}

export const useVersionStore = create<VersionStoreState>((set, get) => ({
  versions: {},
  totals: {},
  loading: {},

  fetchVersionHistory: async (workspaceId, entityType, entityId, opts) => {
    const key = entityId;
    set(state => ({ loading: { ...state.loading, [key]: true } }));

    try {
      const data = unwrap(
        await api.GET(VERSION_BASE[entityType], {
          params: {
            path: { workspaceId, id: entityId },
            query: {
              ...(opts?.limit ? { limit: String(opts.limit) } : {}),
              ...(opts?.offset ? { offset: String(opts.offset) } : {}),
            },
          },
        }),
      ) as { versions?: VersionListItem[]; total?: number };

      set(state => {
        const existing = opts?.offset ? (state.versions[key] ?? []) : [];
        return {
          versions: {
            ...state.versions,
            [key]: [...existing, ...(data.versions ?? [])],
          },
          totals: { ...state.totals, [key]: data.total ?? 0 },
          loading: { ...state.loading, [key]: false },
        };
      });
    } catch {
      set(state => ({ loading: { ...state.loading, [key]: false } }));
    }
  },

  fetchVersion: async (workspaceId, entityType, entityId, version) => {
    try {
      const data = unwrap(
        await api.GET(`${VERSION_BASE[entityType]}/{version}`, {
          params: {
            path: { workspaceId, id: entityId, version: String(version) },
          },
        }),
      ) as { version?: VersionDetail };
      return data.version ?? null;
    } catch {
      return null;
    }
  },

  restoreVersion: async (
    workspaceId,
    entityType,
    entityId,
    version,
    comment,
  ) => {
    try {
      unwrap(
        await api.POST(`${VERSION_BASE[entityType]}/{version}/restore`, {
          params: {
            path: { workspaceId, id: entityId, version: String(version) },
          },
          body: { comment: comment ?? "" },
        }),
      );
      // Refresh the version list
      await get().fetchVersionHistory(workspaceId, entityType, entityId);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Restore failed",
      };
    }
  },

  clearHistory: entityId => {
    set(state => {
      const { [entityId]: _v, ...versions } = state.versions;
      const { [entityId]: _t, ...totals } = state.totals;
      return { versions, totals };
    });
  },
}));
