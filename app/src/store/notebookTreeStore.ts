import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, unwrapBody } from "../api";
import {
  findById,
  removeById,
  insertAlphabetically,
  insertAtTop,
  findParentArray,
} from "./lib/tree-helpers";

export type NotebookAccessLevel = "private" | "workspace";

export interface NotebookEntry {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  children?: NotebookEntry[];
  access?: NotebookAccessLevel;
  owner_id?: string;
  readOnly?: boolean;
  updatedAt?: string;
}

const allSections = (
  state: NotebookTreeState,
  wid: string,
): NotebookEntry[][] => [
  state.myNotebooks[wid] || [],
  state.workspaceNotebooks[wid] || [],
];

const removeFromAnySection = (
  state: NotebookTreeState,
  wid: string,
  id: string,
): NotebookEntry | null => {
  for (const section of allSections(state, wid)) {
    const removed = removeById(section, id);
    if (removed) return removed;
  }
  return null;
};

const insertIntoFolder = (
  state: NotebookTreeState,
  wid: string,
  entry: NotebookEntry,
  targetFolderId: string | null,
  targetSection: "my" | "workspace",
  placement: "alphabetical" | "top" = "alphabetical",
): void => {
  const sectionKey =
    targetSection === "my" ? "myNotebooks" : "workspaceNotebooks";
  const sectionArr = state[sectionKey][wid] || [];
  state[sectionKey][wid] = sectionArr;
  const insert = placement === "top" ? insertAtTop : insertAlphabetically;

  if (targetFolderId) {
    const folder = findById(sectionArr, targetFolderId);
    if (folder && folder.isDirectory) {
      if (!folder.children) folder.children = [];
      insert(folder.children as NotebookEntry[], entry);
      return;
    }
  }
  insert(sectionArr, entry);
};

const sectionOfFolder = (
  state: NotebookTreeState,
  wid: string,
  folderId: string,
): "my" | "workspace" => {
  if (findById(state.workspaceNotebooks[wid] || [], folderId)) {
    return "workspace";
  }
  return "my";
};

interface NotebookTreeState {
  myNotebooks: Record<string, NotebookEntry[]>;
  workspaceNotebooks: Record<string, NotebookEntry[]>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;

  fetchTree: (workspaceId: string) => Promise<void>;
  refresh: (workspaceId: string) => Promise<void>;

  moveItem: (
    workspaceId: string,
    itemId: string,
    targetFolderId: string | null,
    access?: NotebookAccessLevel,
  ) => Promise<void>;

  moveFolder: (
    workspaceId: string,
    folderId: string,
    parentId: string | null,
    access?: NotebookAccessLevel,
  ) => Promise<void>;

  createFolder: (
    workspaceId: string,
    name: string,
    parentId?: string | null,
    access?: NotebookAccessLevel,
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

export const useNotebookTreeStore = create<NotebookTreeState>()(
  immer((set, get) => ({
    myNotebooks: {},
    workspaceNotebooks: {},
    loading: {},
    error: {},

    fetchTree: async (workspaceId: string) => {
      set(state => {
        state.loading[workspaceId] = true;
        state.error[workspaceId] = null;
      });
      try {
        const data = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/notebooks", {
            params: { path: { workspaceId } },
          }),
        ) as {
          success: boolean;
          myNotebooks?: NotebookEntry[];
          workspaceNotebooks?: NotebookEntry[];
        };

        set(state => {
          state.myNotebooks[workspaceId] = data.myNotebooks ?? [];
          state.workspaceNotebooks[workspaceId] = data.workspaceNotebooks ?? [];
        });
      } catch (err: unknown) {
        set(state => {
          state.error[workspaceId] =
            err instanceof Error
              ? err.message
              : "Failed to fetch notebook tree";
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
        unwrapBody(
          await api.PATCH("/api/workspaces/{workspaceId}/notebooks/{id}/move", {
            params: { path: { workspaceId, id: itemId } },
            body: { folderId: targetFolderId, access },
          }),
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
        unwrapBody(
          await api.PATCH(
            "/api/workspaces/{workspaceId}/notebooks/folders/{id}/move",
            {
              params: { path: { workspaceId, id: folderId } },
              body: { parentId, access },
            },
          ),
        );
      } catch {
        await get().refresh(workspaceId);
      }
    },

    createFolder: async (workspaceId, name, parentId, access) => {
      const resolvedAccess = access || "private";

      const tempId = `temp-${Date.now()}`;
      const tempEntry: NotebookEntry = {
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
          state as unknown as NotebookTreeState,
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
        const res = unwrapBody(
          await api.POST("/api/workspaces/{workspaceId}/notebooks/folders", {
            params: { path: { workspaceId } },
            body: { name, parentId, access: resolvedAccess },
          }),
        ) as {
          success: boolean;
          data: { id: string; name: string };
        };

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
        if (isDirectory) {
          unwrapBody(
            await api.PATCH(
              "/api/workspaces/{workspaceId}/notebooks/folders/{id}/rename",
              {
                params: { path: { workspaceId, id: itemId } },
                body: { name },
              },
            ),
          );
        } else {
          unwrapBody(
            await api.PATCH("/api/workspaces/{workspaceId}/notebooks/{id}", {
              params: { path: { workspaceId, id: itemId } },
              body: { name },
            }),
          );
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
        if (isDirectory) {
          unwrapBody(
            await api.DELETE(
              "/api/workspaces/{workspaceId}/notebooks/folders/{id}",
              { params: { path: { workspaceId, id: itemId } } },
            ),
          );
        } else {
          unwrapBody(
            await api.DELETE("/api/workspaces/{workspaceId}/notebooks/{id}", {
              params: { path: { workspaceId, id: itemId } },
            }),
          );
        }
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
