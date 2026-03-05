import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";

export type ConsoleAccessLevel = "private" | "shared_read" | "shared_write";

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
  access?: ConsoleAccessLevel;
  owner_id?: string;
}

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
    // Skip directories - they come first
    if (item.isDirectory) continue;
    // Compare names alphabetically among files
    if (entry.name.toLowerCase() < item.name.toLowerCase()) {
      insertIndex = i;
      break;
    }
  }
  nodes.splice(insertIndex, 0, entry);
};

interface TreeState {
  trees: Record<string, ConsoleEntry[]>; // workspaceId => tree
  myConsoles: Record<string, ConsoleEntry[]>; // workspaceId => flat list of owned consoles
  sharedConsoles: Record<string, ConsoleEntry[]>; // workspaceId => flat list of shared consoles
  loading: Record<string, boolean>; // workspaceId => bool
  error: Record<string, string | null>;
  fetchTree: (workspaceId: string) => Promise<ConsoleEntry[]>;
  refresh: (workspaceId: string) => Promise<ConsoleEntry[]>;
  init: (workspaceId: string) => Promise<void>;
  setTree: (workspaceId: string, tree: ConsoleEntry[]) => void;
  addConsole: (workspaceId: string, path: string, id: string) => void;
}

export const useConsoleTreeStore = create<TreeState>()(
  immer((set, _get) => ({
    trees: {},
    myConsoles: {},
    sharedConsoles: {},
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
          sharedConsoles?: ConsoleEntry[];
        }>(`/workspaces/${workspaceId}/consoles`);
        if (data.tree && Array.isArray(data.tree)) {
          set(state => {
            state.trees[workspaceId] = data.tree as ConsoleEntry[];
            if (data.myConsoles) {
              state.myConsoles[workspaceId] = data.myConsoles as ConsoleEntry[];
            }
            if (data.sharedConsoles) {
              state.sharedConsoles[workspaceId] =
                data.sharedConsoles as ConsoleEntry[];
            }
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
        const folderSegments = segments.slice(0, -1);

        // 1. Remove existing entry with this ID (if any) - handles moves correctly
        const existing = removeById(tree, id);

        // 2. Find target folder
        const targetArray = findTargetArray(tree, folderSegments);

        // 3. Create new entry, preserving metadata from existing if available
        const newConsole: ConsoleEntry = {
          ...(existing || {}),
          name: fileName,
          path: path,
          isDirectory: false,
          id: id,
        };

        // 4. Insert alphabetically into target (or root as fallback)
        const destination = targetArray || tree;
        insertAlphabetically(destination, newConsole);

        state.trees[workspaceId] = tree;
      });
    },
  })),
);
