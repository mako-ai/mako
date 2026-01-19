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
        let tree = state.trees[workspaceId] || [];
        const segments = path.split("/").filter(Boolean);
        const fileName = segments[segments.length - 1];

        // Remove any existing entry at the same path (handles overwrite conflicts)
        // This ensures we don't have duplicates when saving to a path that previously existed
        tree = tree.filter(item => item.path !== path);

        // Check if the same ID already exists (update case)
        const existingIndex = tree.findIndex(item => item.id === id);
        if (existingIndex !== -1) {
          // Update existing entry with new path/name
          tree[existingIndex] = {
            ...tree[existingIndex],
            name: fileName,
            path: path,
          };
        } else {
          // Add new entry
          const newConsole = {
            name: fileName,
            path: path,
            isDirectory: false,
            id: id,
          };

          // Find the correct position to insert (alphabetically)
          // Directories come first, then files, both sorted alphabetically
          let insertIndex = tree.length;
          for (let i = 0; i < tree.length; i++) {
            const item = tree[i];
            // If current item is a file and we're inserting a file
            if (!item.isDirectory) {
              // Compare names alphabetically
              if (fileName.toLowerCase() < item.name.toLowerCase()) {
                insertIndex = i;
                break;
              }
            }
          }

          // Insert at the correct position
          tree.splice(insertIndex, 0, newConsole);
        }
        state.trees[workspaceId] = tree;
      });
    },
  })),
);
