import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";

export interface ConsoleEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: ConsoleEntry[];
  content?: string;
  id?: string;
  folderId?: string;
  connectionId?: string; // Associated connection ID (DatabaseConnection ObjectId)
  databaseId?: string; // Database ID (e.g., D1 UUID for cluster mode)
  databaseName?: string; // Human-readable database name
  language?: "sql" | "javascript" | "mongodb";
  description?: string;
  isPrivate?: boolean;
  lastExecutedAt?: Date;
  executionCount?: number;
}

interface TreeState {
  trees: Record<string, ConsoleEntry[]>; // workspaceId => tree
  loading: Record<string, boolean>; // workspaceId => bool
  error: Record<string, string | null>;
  fetchTree: (workspaceId: string) => Promise<ConsoleEntry[]>;
  refresh: (workspaceId: string) => Promise<ConsoleEntry[]>;
  init: (workspaceId: string) => Promise<void>;
  setTree: (workspaceId: string, tree: ConsoleEntry[]) => void;
  addConsole: (workspaceId: string, path: string, id: string) => void;
  // Future mutations
}

export const useConsoleTreeStore = create<TreeState>()(
  immer((set, _get) => ({
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
        }>(`/workspaces/${workspaceId}/consoles`);
        if (data.tree && Array.isArray(data.tree)) {
          set(state => {
            state.trees[workspaceId] = data.tree as ConsoleEntry[];
          });
          return data.tree;
        }
        return [];
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
      });
    },
    addConsole: (workspaceId, path, id) => {
      set(state => {
        const tree = state.trees[workspaceId] || [];
        const segments = path.split("/").filter(Boolean);
        const fileName = segments[segments.length - 1];
        const folderSegments = segments.slice(0, -1); // All segments except the file name

        // Helper to find the correct array to insert into (navigates into nested folders)
        const findTargetArray = (
          nodes: ConsoleEntry[],
          remainingSegments: string[],
        ): ConsoleEntry[] | null => {
          if (remainingSegments.length === 0) {
            return nodes; // We're at the target level
          }

          const folderName = remainingSegments[0];
          const folder = nodes.find(
            node => node.isDirectory && node.name === folderName,
          );

          if (!folder) {
            return null; // Folder not found in tree
          }

          // Ensure children array exists
          if (!folder.children) {
            folder.children = [];
          }

          return findTargetArray(folder.children, remainingSegments.slice(1));
        };

        // Helper to remove an entry by path from nested structure
        const removeByPath = (
          nodes: ConsoleEntry[],
          targetPath: string,
        ): boolean => {
          const index = nodes.findIndex(item => item.path === targetPath);
          if (index !== -1) {
            nodes.splice(index, 1);
            return true;
          }
          // Check in children
          for (const node of nodes) {
            if (node.isDirectory && node.children) {
              if (removeByPath(node.children, targetPath)) {
                return true;
              }
            }
          }
          return false;
        };

        // Helper to find and update an entry by ID in nested structure
        const findAndUpdateById = (
          nodes: ConsoleEntry[],
          targetId: string,
          newName: string,
          newPath: string,
        ): boolean => {
          const index = nodes.findIndex(item => item.id === targetId);
          if (index !== -1) {
            nodes[index] = {
              ...nodes[index],
              name: newName,
              path: newPath,
            };
            return true;
          }
          // Check in children
          for (const node of nodes) {
            if (node.isDirectory && node.children) {
              if (
                findAndUpdateById(node.children, targetId, newName, newPath)
              ) {
                return true;
              }
            }
          }
          return false;
        };

        // Remove any existing entry at the same path (handles overwrite conflicts)
        removeByPath(tree, path);

        // Check if the same ID already exists (update case) - search entire tree
        if (findAndUpdateById(tree, id, fileName, path)) {
          // Entry was updated in place
          state.trees[workspaceId] = tree;
          return;
        }

        // Add new entry - find the correct target array based on folder path
        const targetArray = findTargetArray(tree, folderSegments);

        if (!targetArray) {
          // Folder doesn't exist in tree yet - add to root as fallback
          // This can happen if tree hasn't been fetched yet
          const newConsole: ConsoleEntry = {
            name: fileName,
            path: path,
            isDirectory: false,
            id: id,
          };
          tree.push(newConsole);
          state.trees[workspaceId] = tree;
          return;
        }

        const newConsole: ConsoleEntry = {
          name: fileName,
          path: path,
          isDirectory: false,
          id: id,
        };

        // Find the correct position to insert (alphabetically)
        // Directories come first, then files, both sorted alphabetically
        let insertIndex = targetArray.length;
        for (let i = 0; i < targetArray.length; i++) {
          const item = targetArray[i];
          // Skip directories - they come first
          if (item.isDirectory) continue;
          // Compare names alphabetically among files
          if (fileName.toLowerCase() < item.name.toLowerCase()) {
            insertIndex = i;
            break;
          }
        }

        // Insert at the correct position
        targetArray.splice(insertIndex, 0, newConsole);
        state.trees[workspaceId] = tree;
      });
    },
  })),
);
