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
  /** Full tree owned by the current user */
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
  createFolder: (
    workspaceId: string,
    name: string,
    parentId?: string | null,
    isPrivate?: boolean,
    scope?: "my" | "workspace",
  ) => Promise<{ success: boolean; id?: string; error?: string }>;
  renameEntry: (
    workspaceId: string,
    item: Pick<ConsoleEntry, "id" | "isDirectory">,
    name: string,
  ) => Promise<{ success: boolean; error?: string }>;
  deleteEntry: (
    workspaceId: string,
    item: Pick<ConsoleEntry, "id" | "isDirectory">,
  ) => Promise<{ success: boolean; error?: string }>;
  shareEntry: (
    workspaceId: string,
    item: Pick<ConsoleEntry, "id" | "isDirectory">,
    access: ConsoleAccessLevel,
    sharedWith?: SharedWithEntry[],
  ) => Promise<{ success: boolean; error?: string }>;
  moveConsole: (
    workspaceId: string,
    consoleId: string,
    folderId: string | null,
    scope?: "my" | "workspace",
  ) => Promise<{ success: boolean; error?: string }>;
  moveFolder: (
    workspaceId: string,
    folderId: string,
    parentFolderId: string | null,
    scope?: "my" | "workspace",
  ) => Promise<{ success: boolean; error?: string }>;
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
          // Keep trees as alias for backward compat
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
    createFolder: async (
      workspaceId,
      name,
      parentId,
      isPrivate = false,
      scope,
    ) => {
      try {
        const result = await apiClient.post<{
          success: boolean;
          error?: string;
          data?: { id: string };
        }>(`/workspaces/${workspaceId}/consoles/folders`, {
          name,
          parentId: parentId || undefined,
          isPrivate,
          scope,
        });
        return {
          success: !!result.success,
          id: result.data?.id,
          error: result.error,
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to create folder",
        };
      }
    },
    renameEntry: async (workspaceId, item, name) => {
      if (!item.id) return { success: false, error: "Missing item ID" };
      try {
        const endpoint = item.isDirectory
          ? `/workspaces/${workspaceId}/consoles/folders/${item.id}/rename`
          : `/workspaces/${workspaceId}/consoles/${item.id}/rename`;
        const result = await apiClient.patch<{
          success: boolean;
          error?: string;
        }>(endpoint, { name });
        return { success: !!result.success, error: result.error };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to rename item",
        };
      }
    },
    deleteEntry: async (workspaceId, item) => {
      if (!item.id) return { success: false, error: "Missing item ID" };
      try {
        const endpoint = item.isDirectory
          ? `/workspaces/${workspaceId}/consoles/folders/${item.id}`
          : `/workspaces/${workspaceId}/consoles/${item.id}`;
        const result = await apiClient.delete<{
          success: boolean;
          error?: string;
        }>(endpoint);
        return { success: !!result.success, error: result.error };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to delete item",
        };
      }
    },
    shareEntry: async (workspaceId, item, access, sharedWith) => {
      if (!item.id) return { success: false, error: "Missing item ID" };
      try {
        const endpoint = item.isDirectory
          ? `/workspaces/${workspaceId}/consoles/folders/${item.id}/share`
          : `/workspaces/${workspaceId}/consoles/${item.id}/share`;
        const result = await apiClient.post<{
          success: boolean;
          error?: string;
        }>(endpoint, {
          access,
          shared_with:
            access === "shared" || access === "workspace"
              ? sharedWith
              : undefined,
        });
        return { success: !!result.success, error: result.error };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to update sharing",
        };
      }
    },
    moveConsole: async (workspaceId, consoleId, folderId, scope) => {
      try {
        const result = await apiClient.patch<{
          success: boolean;
          error?: string;
        }>(`/workspaces/${workspaceId}/consoles/${consoleId}`, {
          folderId,
          scope,
        });
        return { success: !!result.success, error: result.error };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to move console",
        };
      }
    },
    moveFolder: async (workspaceId, folderId, parentFolderId, scope) => {
      try {
        const result = await apiClient.patch<{
          success: boolean;
          error?: string;
        }>(`/workspaces/${workspaceId}/consoles/folders/${folderId}`, {
          parentFolderId,
          scope,
        });
        return { success: !!result.success, error: result.error };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to move folder",
        };
      }
    },
  })),
);
