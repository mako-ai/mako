import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";

export type ConsoleAccessLevel = "private" | "shared" | "workspace";

export interface SharedWithEntry {
  userId: string;
  access: "read" | "write";
}

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
  shared_with?: SharedWithEntry[];
}

// Helper to find the correct array to insert into (navigates into nested folders)
const findTargetArray = (
  nodes: ConsoleEntry[],
  remainingSegments: string[],
): ConsoleEntry[] | null => {
  if (remainingSegments.length === 0) {
    return nodes;
  }

  const folderName = remainingSegments[0];
  const folder = nodes.find(
    node => node.isDirectory && node.name === folderName,
  );

  if (!folder) {
    return null;
  }

  if (!folder.children) {
    folder.children = [];
  }

  return findTargetArray(folder.children, remainingSegments.slice(1));
};

// Remove entry by ID from anywhere in tree, return removed entry if found
const removeById = (
  nodes: ConsoleEntry[],
  targetId: string,
): ConsoleEntry | null => {
  const index = nodes.findIndex(item => item.id === targetId);
  if (index !== -1) {
    return nodes.splice(index, 1)[0];
  }
  for (const node of nodes) {
    if (node.isDirectory && node.children) {
      const removed = removeById(node.children, targetId);
      if (removed) return removed;
    }
  }
  return null;
};

// Insert entry alphabetically (directories first, then files sorted by name)
const insertAlphabetically = (
  nodes: ConsoleEntry[],
  entry: ConsoleEntry,
): void => {
  let insertIndex = nodes.length;
  for (let i = 0; i < nodes.length; i++) {
    const item = nodes[i];
    if (item.isDirectory) continue;
    if (entry.name.toLowerCase() < item.name.toLowerCase()) {
      insertIndex = i;
      break;
    }
  }
  nodes.splice(insertIndex, 0, entry);
};

interface TreeState {
  /** Full tree owned by the current user (includes empty folders) */
  myConsoles: Record<string, ConsoleEntry[]>;
  /** Consoles explicitly shared with the current user via shared_with */
  sharedWithMe: Record<string, ConsoleEntry[]>;
  /** Consoles shared with the entire workspace */
  sharedWithWorkspace: Record<string, ConsoleEntry[]>;
  /** Legacy: kept as alias for myConsoles */
  trees: Record<string, ConsoleEntry[]>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
  fetchTree: (workspaceId: string) => Promise<ConsoleEntry[]>;
  refresh: (workspaceId: string) => Promise<ConsoleEntry[]>;
  init: (workspaceId: string) => Promise<void>;
  setTree: (workspaceId: string, tree: ConsoleEntry[]) => void;
  addConsole: (workspaceId: string, path: string, id: string) => void;
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
    shared_with?: Array<{ userId: string; access: "read" | "write" }>,
  ) => Promise<boolean>;
}

export const useConsoleTreeStore = create<TreeState>()(
  immer((set, _get) => ({
    myConsoles: {},
    sharedWithMe: {},
    sharedWithWorkspace: {},
    trees: {},
    loading: {},
    error: {},
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
          sharedWithMe?: ConsoleEntry[];
          sharedWithWorkspace?: ConsoleEntry[];
          // Legacy fields
          sharedConsoles?: ConsoleEntry[];
        }>(`/workspaces/${workspaceId}/consoles`);

        const myTree = data.myConsoles ?? data.tree ?? [];
        const sharedWithMeTree = data.sharedWithMe ?? [];
        const sharedWithWorkspaceTree = data.sharedWithWorkspace ?? [];

        set(state => {
          state.myConsoles[workspaceId] = myTree;
          state.sharedWithMe[workspaceId] = sharedWithMeTree;
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
      const hasData = !!_get().trees[workspaceId];
      if (!hasData) {
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
          path: path,
          isDirectory: false,
          id: id,
        };

        const destination = targetArray || tree;
        insertAlphabetically(destination, newConsole);

        state.myConsoles[workspaceId] = tree;
        state.trees[workspaceId] = tree;
      });
    },

    moveConsole: async (workspaceId, consoleId, folderId, access?) => {
      try {
        const res = await apiClient.patch<{ success: boolean }>(
          `/workspaces/${workspaceId}/consoles/${consoleId}/move`,
          { folderId, access },
        );
        if (res.success) {
          await _get().refresh(workspaceId);
        }
        return res.success;
      } catch {
        return false;
      }
    },

    moveFolder: async (workspaceId, folderId, parentId, access?) => {
      try {
        const res = await apiClient.patch<{ success: boolean }>(
          `/workspaces/${workspaceId}/consoles/folders/${folderId}/move`,
          { parentId, access },
        );
        if (res.success) {
          await _get().refresh(workspaceId);
        }
        return res.success;
      } catch {
        return false;
      }
    },

    createFolder: async (workspaceId, name, parentId) => {
      try {
        const res = await apiClient.post<{
          success: boolean;
          data?: { id: string; name: string };
        }>(`/workspaces/${workspaceId}/consoles/folders`, {
          name,
          parentId: parentId || undefined,
          isPrivate: false,
        });
        if (res.success && res.data) {
          await _get().refresh(workspaceId);
          return { id: res.data.id, name: res.data.name };
        }
        return null;
      } catch {
        return null;
      }
    },

    renameItem: async (workspaceId, itemId, newName, isDirectory) => {
      try {
        const endpoint = isDirectory
          ? `/workspaces/${workspaceId}/consoles/folders/${itemId}/rename`
          : `/workspaces/${workspaceId}/consoles/${itemId}/rename`;
        const res = await apiClient.patch<{ success: boolean }>(endpoint, {
          name: newName,
        });
        if (res.success) {
          await _get().refresh(workspaceId);
        }
        return res.success;
      } catch {
        return false;
      }
    },

    deleteItem: async (workspaceId, itemId, isDirectory) => {
      try {
        const endpoint = isDirectory
          ? `/workspaces/${workspaceId}/consoles/folders/${itemId}`
          : `/workspaces/${workspaceId}/consoles/${itemId}`;
        const res = await apiClient.delete<{ success: boolean }>(endpoint);
        if (res.success) {
          await _get().refresh(workspaceId);
        }
        return res.success;
      } catch {
        return false;
      }
    },

    duplicateConsole: async (workspaceId, consoleId) => {
      try {
        const res = await apiClient.post<{
          success: boolean;
          data?: { id: string; name: string };
        }>(`/workspaces/${workspaceId}/consoles/${consoleId}/duplicate`);
        if (res.success && res.data) {
          await _get().refresh(workspaceId);
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

    updateAccess: async (
      workspaceId,
      itemId,
      isDirectory,
      access,
      shared_with,
    ) => {
      try {
        const endpoint = isDirectory
          ? `/workspaces/${workspaceId}/consoles/folders/${itemId}/share`
          : `/workspaces/${workspaceId}/consoles/${itemId}/share`;
        const res = await apiClient.post<{ success: boolean }>(endpoint, {
          access,
          shared_with,
        });
        if (res.success) {
          await _get().refresh(workspaceId);
        }
        return res.success;
      } catch {
        return false;
      }
    },
  })),
);
