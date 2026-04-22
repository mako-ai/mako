import { create } from "zustand";
import { apiClient } from "../lib/api-client";

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

function buildBasePath(
  workspaceId: string,
  entityType: "console" | "dashboard",
  entityId: string,
) {
  const collection = entityType === "console" ? "consoles" : "dashboards";
  return `/workspaces/${workspaceId}/${collection}/${entityId}/versions`;
}

export const useVersionStore = create<VersionStoreState>((set, get) => ({
  versions: {},
  totals: {},
  loading: {},

  fetchVersionHistory: async (workspaceId, entityType, entityId, opts) => {
    const key = entityId;
    set(state => ({ loading: { ...state.loading, [key]: true } }));

    try {
      const params: Record<string, string> = {};
      if (opts?.limit) params.limit = String(opts.limit);
      if (opts?.offset) params.offset = String(opts.offset);

      const data = await apiClient.get<{
        success: boolean;
        versions: VersionListItem[];
        total: number;
      }>(buildBasePath(workspaceId, entityType, entityId), params);

      set(state => {
        const existing = opts?.offset ? (state.versions[key] ?? []) : [];
        return {
          versions: {
            ...state.versions,
            [key]: [...existing, ...data.versions],
          },
          totals: { ...state.totals, [key]: data.total },
          loading: { ...state.loading, [key]: false },
        };
      });
    } catch {
      set(state => ({ loading: { ...state.loading, [key]: false } }));
    }
  },

  fetchVersion: async (workspaceId, entityType, entityId, version) => {
    try {
      const data = await apiClient.get<{
        success: boolean;
        version: VersionDetail;
      }>(`${buildBasePath(workspaceId, entityType, entityId)}/${version}`);
      return data.version;
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
      await apiClient.post(
        `${buildBasePath(workspaceId, entityType, entityId)}/${version}/restore`,
        { comment: comment ?? "" },
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
