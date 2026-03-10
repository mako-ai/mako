import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";

export type ConsoleAccessLevel = "private" | "workspace";

export interface ConsoleEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: ConsoleEntry[];
  content?: string;
  id?: string;
  folderId?: string;
  connectionId?: string;
  databaseId?: string;
  databaseName?: string;
  language?: "sql" | "javascript" | "mongodb";
  description?: string;
  isPrivate?: boolean;
  lastExecutedAt?: Date;
  executionCount?: number;
  access?: ConsoleAccessLevel;
  owner_id?: string;
  createdAt?: string;
}

// ── Tree helpers (mutate in place, used inside immer) ──

const findTargetArray = (
  nodes: ConsoleEntry[],
  remainingSegments: string[],
): ConsoleEntry[] | null => {
  if (remainingSegments.length === 0) return nodes;
  const folderName = remainingSegments[0];
  const folder = nodes.find(
    node => node.isDirectory && node.name === folderName,
  );
  if (!folder) return null;
  if (!folder.children) folder.children = [];
  return findTargetArray(folder.children, remainingSegments.slice(1));
};

const removeById = (
  nodes: ConsoleEntry[],
  targetId: string,
): ConsoleEntry | null => {
  const index = nodes.findIndex(item => item.id === targetId);
  if (index !== -1) return nodes.splice(index, 1)[0];
  for (const node of nodes) {
    if (node.isDirectory && node.children) {
      const removed = removeById(node.children, targetId);
      if (removed) return removed;
    }
  }
  return null;
};

const insertAlphabetically = (
  nodes: ConsoleEntry[],
  entry: ConsoleEntry,
): void => {
  let insertIndex = nodes.length;
  for (let i = 0; i < nodes.length; i++) {
    const item = nodes[i];
    if (entry.isDirectory && !item.isDirectory) {
      insertIndex = i;
      break;
    }
    if (entry.isDirectory === item.isDirectory) {
      if (entry.name.toLowerCase() < item.name.toLowerCase()) {
        insertIndex = i;
        break;
      }
    }
  }
  nodes.splice(insertIndex, 0, entry);
};

const insertAtTop = (nodes: ConsoleEntry[], entry: ConsoleEntry): void => {
  nodes.unshift(entry);
};

const findById = (
  nodes: ConsoleEntry[],
  targetId: string,
): ConsoleEntry | null => {
  for (const node of nodes) {
    if (node.id === targetId) return node;
    if (node.isDirectory && node.children) {
      const found = findById(node.children, targetId);
      if (found) return found;
    }
  }
  return null;
};

const findParentArray = (
  nodes: ConsoleEntry[],
  targetId: string,
): ConsoleEntry[] | null => {
  if (nodes.some(n => n.id === targetId)) return nodes;
  for (const node of nodes) {
    if (node.isDirectory && node.children) {
      const found = findParentArray(node.children, targetId);
      if (found) return found;
    }
  }
  return null;
};

/** Get both section arrays for a workspace */
const allSections = (state: TreeState, wid: string): ConsoleEntry[][] => [
  state.myConsoles[wid] || [],
  state.sharedWithWorkspace[wid] || [],
];

/** Find a node across all three sections */
const findInAnySectionMut = (
  state: TreeState,
  wid: string,
  id: string,
): ConsoleEntry | null => {
  for (const section of allSections(state, wid)) {
    const found = findById(section, id);
    if (found) return found;
  }
  return null;
};

/** Remove a node from whichever section contains it */
const removeFromAnySection = (
  state: TreeState,
  wid: string,
  id: string,
): ConsoleEntry | null => {
  for (const section of allSections(state, wid)) {
    const removed = removeById(section, id);
    if (removed) return removed;
  }
  return null;
};

/** Insert into the children of a target folder, or at root of a section */
const insertIntoFolder = (
  state: TreeState,
  wid: string,
  entry: ConsoleEntry,
  targetFolderId: string | null,
  targetSection: "my" | "workspace",
  placement: "alphabetical" | "top" = "alphabetical",
): void => {
  const sectionKey =
    targetSection === "my" ? "myConsoles" : "sharedWithWorkspace";
  const sectionArr = state[sectionKey][wid] || [];
  state[sectionKey][wid] = sectionArr;
  const insert = placement === "top" ? insertAtTop : insertAlphabetically;

  if (targetFolderId) {
    const folder = findById(sectionArr, targetFolderId);
    if (folder && folder.isDirectory) {
      if (!folder.children) folder.children = [];
      insert(folder.children, entry);
      return;
    }
  }
  insert(sectionArr, entry);
};

/** Determine which section a folder ID belongs to */
const sectionOfFolder = (
  state: TreeState,
  wid: string,
  folderId: string,
): "my" | "workspace" => {
  if (findById(state.sharedWithWorkspace[wid] || [], folderId)) {
    return "workspace";
  }
  return "my";
};

// ── Store ──

export interface ConsoleSearchResult {
  id: string;
  title: string;
  description: string;
  connectionName?: string;
  databaseName?: string;
  language: string;
  isSaved: boolean;
  score: number;
}

interface TreeState {
  myConsoles: Record<string, ConsoleEntry[]>;
  sharedWithWorkspace: Record<string, ConsoleEntry[]>;
  trees: Record<string, ConsoleEntry[]>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;

  searchQuery: string;
  searchResults: ConsoleSearchResult[];
  searchLoading: boolean;

  fetchTree: (workspaceId: string) => Promise<ConsoleEntry[]>;
  refresh: (workspaceId: string) => Promise<ConsoleEntry[]>;
  init: (workspaceId: string) => Promise<void>;
  setTree: (workspaceId: string, tree: ConsoleEntry[]) => void;
  addConsole: (workspaceId: string, path: string, id: string) => void;
  searchConsoles: (workspaceId: string, query: string) => Promise<void>;
  clearSearch: () => void;

  moveConsole: (
    workspaceId: string,
    consoleId: string,
    folderId: string | null,
    access?: ConsoleAccessLevel,
  ) => Promise<boolean>;
  moveFolder: (
    workspaceId: string,
    folderId: string,
    parentId: string | null,
    access?: ConsoleAccessLevel,
  ) => Promise<boolean>;
  createFolder: (
    workspaceId: string,
    name: string,
    parentId?: string | null,
    access?: ConsoleAccessLevel,
  ) => Promise<{ id: string; name: string } | null>;
  renameItem: (
    workspaceId: string,
    itemId: string,
    newName: string,
    isDirectory: boolean,
  ) => Promise<boolean>;
  deleteItem: (
    workspaceId: string,
    itemId: string,
    isDirectory: boolean,
  ) => Promise<boolean>;
  resortItem: (workspaceId: string, itemId: string) => void;
  duplicateConsole: (
    workspaceId: string,
    consoleId: string,
  ) => Promise<{ id: string; name: string } | null>;
  restoreConsole: (workspaceId: string, consoleId: string) => Promise<boolean>;
  updateAccess: (
    workspaceId: string,
    itemId: string,
    isDirectory: boolean,
    access: ConsoleAccessLevel,
  ) => Promise<boolean>;
}

export const useConsoleTreeStore = create<TreeState>()(
  immer((set, _get) => ({
    myConsoles: {},
    sharedWithWorkspace: {},
    trees: {},
    loading: {},
    error: {},

    searchQuery: "",
    searchResults: [],
    searchLoading: false,

    searchConsoles: async (workspaceId, query) => {
      set(state => {
        state.searchQuery = query;
        state.searchLoading = true;
      });
      try {
        const data = await apiClient.get<{
          results: ConsoleSearchResult[];
        }>(
          `/workspaces/${workspaceId}/consoles/search?q=${encodeURIComponent(query)}`,
        );
        set(state => {
          state.searchResults = data.results || [];
          state.searchLoading = false;
        });
      } catch {
        set(state => {
          state.searchResults = [];
          state.searchLoading = false;
        });
      }
    },

    clearSearch: () => {
      set(state => {
        state.searchQuery = "";
        state.searchResults = [];
        state.searchLoading = false;
      });
    },

    fetchTree: async workspaceId => {
      set(state => {
        state.loading[workspaceId] = true;
        state.error[workspaceId] = null;
      });
      try {
        const data = await apiClient.get<{
          success: boolean;
          tree?: ConsoleEntry[];
          myConsoles?: ConsoleEntry[];
          sharedWithWorkspace?: ConsoleEntry[];
        }>(`/workspaces/${workspaceId}/consoles`);

        const myTree = data.myConsoles ?? data.tree ?? [];
        const sharedWithWorkspaceTree = data.sharedWithWorkspace ?? [];

        set(state => {
          state.myConsoles[workspaceId] = myTree;
          state.sharedWithWorkspace[workspaceId] = sharedWithWorkspaceTree;
          state.trees[workspaceId] = myTree;
        });
        return myTree;
      } catch (err: any) {
        console.error("Failed to fetch console tree", err);
        set(state => {
          state.error[workspaceId] = err?.message || "Failed to fetch";
        });
        return [];
      } finally {
        set(state => {
          delete state.loading[workspaceId];
        });
      }
    },

    refresh: async workspaceId => {
      return await _get().fetchTree(workspaceId);
    },

    init: async workspaceId => {
      if (!_get().trees[workspaceId]) {
        await _get().fetchTree(workspaceId);
      }
    },

    setTree: (workspaceId, tree) => {
      set(state => {
        state.trees[workspaceId] = tree;
        state.myConsoles[workspaceId] = tree;
      });
    },

    addConsole: (workspaceId, path, id) => {
      set(state => {
        const tree = state.myConsoles[workspaceId] || [];
        const segments = path.split("/").filter(Boolean);
        const fileName = segments[segments.length - 1];
        const folderSegments = segments.slice(0, -1);
        const existing = removeById(tree, id);
        const targetArray = findTargetArray(tree, folderSegments);
        const newConsole: ConsoleEntry = {
          ...(existing || {}),
          name: fileName,
          path,
          isDirectory: false,
          id,
        };
        const destination = targetArray || tree;
        insertAlphabetically(destination, newConsole);
        state.myConsoles[workspaceId] = tree;
        state.trees[workspaceId] = tree;
      });
    },

    // ── Optimistic mutations ──

    moveConsole: async (workspaceId, consoleId, folderId, access) => {
      set(state => {
        const entry = removeFromAnySection(state, workspaceId, consoleId);
        if (!entry) return;
        if (access) entry.access = access;
        const targetSection = access
          ? access === "workspace"
            ? "workspace"
            : "my"
          : folderId
            ? sectionOfFolder(state, workspaceId, folderId)
            : "my";
        insertIntoFolder(state, workspaceId, entry, folderId, targetSection);
      });
      try {
        const body: Record<string, unknown> = { folderId };
        if (access) body.access = access;
        const res = await apiClient.patch<{ success: boolean }>(
          `/workspaces/${workspaceId}/consoles/${consoleId}/move`,
          body,
        );
        if (!res.success) {
          await _get().refresh(workspaceId);
        }
        return res.success;
      } catch {
        await _get().refresh(workspaceId);
        return false;
      }
    },

    moveFolder: async (workspaceId, folderId, parentId, access) => {
      set(state => {
        const entry = removeFromAnySection(state, workspaceId, folderId);
        if (!entry) return;
        if (access) entry.access = access;
        const targetSection = access
          ? access === "workspace"
            ? "workspace"
            : "my"
          : parentId
            ? sectionOfFolder(state, workspaceId, parentId)
            : "my";
        insertIntoFolder(state, workspaceId, entry, parentId, targetSection);
      });
      try {
        const body: Record<string, unknown> = { parentId };
        if (access) body.access = access;
        const res = await apiClient.patch<{ success: boolean }>(
          `/workspaces/${workspaceId}/consoles/folders/${folderId}/move`,
          body,
        );
        if (!res.success) {
          await _get().refresh(workspaceId);
        }
        return res.success;
      } catch {
        await _get().refresh(workspaceId);
        return false;
      }
    },

    createFolder: async (workspaceId, name, parentId, access) => {
      // Resolve access: if not specified, inherit from the section the parent lives in
      let resolvedAccess = access || "private";
      if (!access && parentId) {
        const parentSection = sectionOfFolder(_get(), workspaceId, parentId);
        if (parentSection === "workspace") {
          resolvedAccess = "workspace";
        }
      }

      const tempId = `temp-${Date.now()}`;
      const targetSection =
        resolvedAccess === "workspace"
          ? "workspace"
          : parentId
            ? sectionOfFolder(_get(), workspaceId, parentId)
            : "my";

      set(state => {
        const newFolder: ConsoleEntry = {
          name,
          path: name,
          isDirectory: true,
          children: [],
          id: tempId,
          access: resolvedAccess,
        };
        insertIntoFolder(
          state,
          workspaceId,
          newFolder,
          parentId ?? null,
          targetSection,
          "top",
        );
      });

      try {
        const res = await apiClient.post<{
          success: boolean;
          data?: { id: string; name: string };
        }>(`/workspaces/${workspaceId}/consoles/folders`, {
          name,
          parentId: parentId || undefined,
          isPrivate: false,
          access: resolvedAccess,
        });
        if (res.success && res.data) {
          // Replace temp ID with real ID
          set(state => {
            const node = findInAnySectionMut(state, workspaceId, tempId);
            if (node) node.id = res.data!.id;
          });
          return { id: res.data.id, name: res.data.name };
        }
        await _get().refresh(workspaceId);
        return null;
      } catch {
        await _get().refresh(workspaceId);
        return null;
      }
    },

    renameItem: async (workspaceId, itemId, newName, isDirectory) => {
      set(state => {
        const parent = (() => {
          for (const section of allSections(state, workspaceId)) {
            const found = findParentArray(section, itemId);
            if (found) return found;
          }
          return null;
        })();
        if (parent) {
          const idx = parent.findIndex(n => n.id === itemId);
          if (idx !== -1) {
            const [node] = parent.splice(idx, 1);
            node.name = newName;
            insertAlphabetically(parent, node);
          }
        }
      });
      try {
        const endpoint = isDirectory
          ? `/workspaces/${workspaceId}/consoles/folders/${itemId}/rename`
          : `/workspaces/${workspaceId}/consoles/${itemId}/rename`;
        const res = await apiClient.patch<{ success: boolean }>(endpoint, {
          name: newName,
        });
        if (!res.success) {
          await _get().refresh(workspaceId);
        }
        return res.success;
      } catch {
        await _get().refresh(workspaceId);
        return false;
      }
    },

    deleteItem: async (workspaceId, itemId, isDirectory) => {
      // Optimistic: remove from local tree
      set(state => {
        removeFromAnySection(state, workspaceId, itemId);
      });
      try {
        const endpoint = isDirectory
          ? `/workspaces/${workspaceId}/consoles/folders/${itemId}`
          : `/workspaces/${workspaceId}/consoles/${itemId}`;
        const res = await apiClient.delete<{ success: boolean }>(endpoint);
        if (!res.success) {
          await _get().refresh(workspaceId);
        }
        return res.success;
      } catch {
        await _get().refresh(workspaceId);
        return false;
      }
    },

    resortItem: (workspaceId, itemId) => {
      set(state => {
        const parent = (() => {
          for (const section of allSections(state, workspaceId)) {
            const found = findParentArray(section, itemId);
            if (found) return found;
          }
          return null;
        })();
        if (parent) {
          const idx = parent.findIndex(n => n.id === itemId);
          if (idx !== -1) {
            const [node] = parent.splice(idx, 1);
            insertAlphabetically(parent, node);
          }
        }
      });
    },

    duplicateConsole: async (workspaceId, consoleId) => {
      try {
        const res = await apiClient.post<{
          success: boolean;
          data?: { id: string; name: string; folderId?: string };
        }>(`/workspaces/${workspaceId}/consoles/${consoleId}/duplicate`);
        if (res.success && res.data) {
          // Insert copy next to original optimistically
          set(state => {
            const original = findInAnySectionMut(state, workspaceId, consoleId);
            if (!original) return;
            const copy: ConsoleEntry = {
              ...original,
              id: res.data!.id,
              name: res.data!.name,
              isDirectory: false,
            };
            // Find which section/folder the original is in
            for (const section of allSections(state, workspaceId)) {
              const parent = findParentArray(section, consoleId);
              if (parent) {
                insertAlphabetically(parent, copy);
                return;
              }
            }
          });
          return { id: res.data.id, name: res.data.name };
        }
        return null;
      } catch {
        return null;
      }
    },

    restoreConsole: async (workspaceId, consoleId) => {
      try {
        const res = await apiClient.patch<{ success: boolean }>(
          `/workspaces/${workspaceId}/consoles/${consoleId}/restore`,
        );
        if (res.success) {
          await _get().refresh(workspaceId);
        }
        return res.success;
      } catch {
        return false;
      }
    },

    updateAccess: async (workspaceId, itemId, isDirectory, access) => {
      set(state => {
        const entry = removeFromAnySection(state, workspaceId, itemId);
        if (!entry) return;
        entry.access = access;
        const sectionKey =
          access === "workspace" ? "sharedWithWorkspace" : "myConsoles";
        const arr = state[sectionKey][workspaceId] || [];
        state[sectionKey][workspaceId] = arr;
        insertAlphabetically(arr, entry);
      });
      try {
        const endpoint = isDirectory
          ? `/workspaces/${workspaceId}/consoles/folders/${itemId}/share`
          : `/workspaces/${workspaceId}/consoles/${itemId}/share`;
        const res = await apiClient.post<{ success: boolean }>(endpoint, {
          access,
        });
        if (!res.success) {
          await _get().refresh(workspaceId);
        }
        return res.success;
      } catch {
        await _get().refresh(workspaceId);
        return false;
      }
    },
  })),
);
