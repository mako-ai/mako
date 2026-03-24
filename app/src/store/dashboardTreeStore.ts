import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";
import {
  findById,
  removeById,
  insertAlphabetically,
  insertAtTop,
  findParentArray,
} from "./lib/tree-helpers";

export type DashboardAccessLevel = "private" | "workspace";

export interface DashboardEntry {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  children?: DashboardEntry[];
  access?: DashboardAccessLevel;
  owner_id?: string;
  readOnly?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

// ── Store-specific helpers (operate on DashboardTreeState via immer) ──

const allSections = (
  state: DashboardTreeState,
  wid: string,
): DashboardEntry[][] => [
  state.myDashboards[wid] || [],
  state.workspaceDashboards[wid] || [],
];

const removeFromAnySection = (
  state: DashboardTreeState,
  wid: string,
  id: string,
): DashboardEntry | null => {
  for (const section of allSections(state, wid)) {
    const removed = removeById(section, id);
    if (removed) return removed;
  }
  return null;
};

const insertIntoFolder = (
  state: DashboardTreeState,
  wid: string,
  entry: DashboardEntry,
  targetFolderId: string | null,
  targetSection: "my" | "workspace",
  placement: "alphabetical" | "top" = "alphabetical",
): void => {
  const sectionKey =
    targetSection === "my" ? "myDashboards" : "workspaceDashboards";
  const sectionArr = state[sectionKey][wid] || [];
  state[sectionKey][wid] = sectionArr;
  const insert = placement === "top" ? insertAtTop : insertAlphabetically;

  if (targetFolderId) {
    const folder = findById(sectionArr, targetFolderId);
    if (folder && folder.isDirectory) {
      if (!folder.children) folder.children = [];
      insert(folder.children as DashboardEntry[], entry);
      return;
    }
  }
  insert(sectionArr, entry);
};

const sectionOfFolder = (
  state: DashboardTreeState,
  wid: string,
  folderId: string,
): "my" | "workspace" => {
  if (findById(state.workspaceDashboards[wid] || [], folderId)) {
    return "workspace";
  }
  return "my";
};

// ── Store ──

interface DashboardTreeState {
  myDashboards: Record<string, DashboardEntry[]>;
  workspaceDashboards: Record<string, DashboardEntry[]>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;

  fetchTree: (workspaceId: string) => Promise<void>;
  refresh: (workspaceId: string) => Promise<void>;

  moveItem: (
    workspaceId: string,
    itemId: string,
    targetFolderId: string | null,
    access?: DashboardAccessLevel,
  ) => Promise<void>;

  moveFolder: (
    workspaceId: string,
    folderId: string,
    parentId: string | null,
    access?: DashboardAccessLevel,
  ) => Promise<void>;

  createFolder: (
    workspaceId: string,
    name: string,
    parentId?: string | null,
    access?: DashboardAccessLevel,
  ) => Promise<string | null>;

  renameItem: (
    workspaceId: string,
    itemId: string,
    name: string,
    isDirectory: boolean,
  ) => Promise<void>;

  deleteItem: (
    workspaceId: string,
    itemId: string,
    isDirectory: boolean,
  ) => Promise<void>;

  resortItem: (workspaceId: string, itemId: string) => void;
}

export const useDashboardTreeStore = create<DashboardTreeState>()(
  immer((set, get) => ({
    myDashboards: {},
    workspaceDashboards: {},
    loading: {},
    error: {},

    fetchTree: async (workspaceId: string) => {
      set(state => {
        state.loading[workspaceId] = true;
        state.error[workspaceId] = null;
      });
      try {
        const data = await apiClient.get<{
          success: boolean;
          myDashboards?: DashboardEntry[];
          workspaceDashboards?: DashboardEntry[];
        }>(`/workspaces/${workspaceId}/dashboards`);

        set(state => {
          state.myDashboards[workspaceId] = data.myDashboards ?? [];
          state.workspaceDashboards[workspaceId] =
            data.workspaceDashboards ?? [];
        });
      } catch (err: any) {
        set(state => {
          state.error[workspaceId] =
            err?.message || "Failed to fetch dashboard tree";
        });
      } finally {
        set(state => {
          delete state.loading[workspaceId];
        });
      }
    },

    refresh: async (workspaceId: string) => {
      await get().fetchTree(workspaceId);
    },

    moveItem: async (workspaceId, itemId, targetFolderId, access) => {
      set(state => {
        const entry = removeFromAnySection(state, workspaceId, itemId);
        if (!entry) return;
        if (access) entry.access = access;

        let targetSection: "my" | "workspace" = "my";
        if (access === "workspace") {
          targetSection = "workspace";
        } else if (access === "private") {
          targetSection = "my";
        } else if (targetFolderId) {
          targetSection = sectionOfFolder(state, workspaceId, targetFolderId);
        }

        insertIntoFolder(
          state,
          workspaceId,
          entry,
          targetFolderId,
          targetSection,
        );
      });

      try {
        await apiClient.patch(
          `/workspaces/${workspaceId}/dashboards/${itemId}/move`,
          { folderId: targetFolderId, access },
        );
      } catch {
        await get().refresh(workspaceId);
      }
    },

    moveFolder: async (workspaceId, folderId, parentId, access) => {
      set(state => {
        const entry = removeFromAnySection(state, workspaceId, folderId);
        if (!entry) return;
        if (access) entry.access = access;

        let targetSection: "my" | "workspace" = "my";
        if (access === "workspace") {
          targetSection = "workspace";
        } else if (access === "private") {
          targetSection = "my";
        } else if (parentId) {
          targetSection = sectionOfFolder(state, workspaceId, parentId);
        }

        insertIntoFolder(state, workspaceId, entry, parentId, targetSection);
      });

      try {
        await apiClient.patch(
          `/workspaces/${workspaceId}/dashboards/folders/${folderId}/move`,
          { parentId, access },
        );
      } catch {
        await get().refresh(workspaceId);
      }
    },

    createFolder: async (workspaceId, name, parentId, access) => {
      const resolvedAccess = access || "private";

      const tempId = `temp-${Date.now()}`;
      const tempEntry: DashboardEntry = {
        id: tempId,
        name,
        path: name,
        isDirectory: true,
        children: [],
        access: resolvedAccess,
      };

      let targetSection: "my" | "workspace" = "my";
      if (resolvedAccess === "workspace") {
        targetSection = "workspace";
      } else if (parentId) {
        const state = get();
        targetSection = sectionOfFolder(
          state as unknown as DashboardTreeState,
          workspaceId,
          parentId,
        );
      }

      set(state => {
        insertIntoFolder(
          state,
          workspaceId,
          tempEntry,
          parentId || null,
          targetSection,
          "top",
        );
      });

      try {
        const res = await apiClient.post<{
          success: boolean;
          data: { id: string; name: string };
        }>(`/workspaces/${workspaceId}/dashboards/folders`, {
          name,
          parentId,
          access: resolvedAccess,
        });

        const realId = res.data?.id;
        if (realId) {
          set(state => {
            for (const section of allSections(state, workspaceId)) {
              const node = findById(section, tempId);
              if (node) {
                node.id = realId;
                break;
              }
            }
          });
          return realId;
        }
        return null;
      } catch {
        await get().refresh(workspaceId);
        return null;
      }
    },

    renameItem: async (workspaceId, itemId, name, isDirectory) => {
      set(state => {
        for (const section of allSections(state, workspaceId)) {
          const node = findById(section, itemId);
          if (node) {
            node.name = name;
            const parent = findParentArray(section, itemId);
            if (parent) {
              const idx = parent.findIndex(n => n.id === itemId);
              if (idx !== -1) {
                const [removed] = parent.splice(idx, 1);
                insertAlphabetically(parent, removed);
              }
            }
            break;
          }
        }
      });

      try {
        const endpoint = isDirectory
          ? `/workspaces/${workspaceId}/dashboards/folders/${itemId}/rename`
          : `/workspaces/${workspaceId}/dashboards/${itemId}`;

        if (isDirectory) {
          await apiClient.patch(endpoint, { name });
        } else {
          await apiClient.put(endpoint, { title: name });
        }
      } catch {
        await get().refresh(workspaceId);
      }
    },

    deleteItem: async (workspaceId, itemId, isDirectory) => {
      set(state => {
        removeFromAnySection(state, workspaceId, itemId);
      });

      try {
        const endpoint = isDirectory
          ? `/workspaces/${workspaceId}/dashboards/folders/${itemId}`
          : `/workspaces/${workspaceId}/dashboards/${itemId}`;
        await apiClient.delete(endpoint);
      } catch {
        await get().refresh(workspaceId);
      }
    },

    resortItem: (workspaceId, itemId) => {
      set(state => {
        for (const section of allSections(state, workspaceId)) {
          const parent = findParentArray(section, itemId);
          if (parent) {
            const idx = parent.findIndex(n => n.id === itemId);
            if (idx !== -1) {
              const [removed] = parent.splice(idx, 1);
              insertAlphabetically(parent, removed);
            }
            break;
          }
        }
      });
    },
  })),
);
