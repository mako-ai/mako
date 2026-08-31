import { api, unwrapBody } from "../api";
import {
  createResourceTreeStore,
  type ResourceTreeEntry,
  type TreeAccessLevel,
} from "./lib/createResourceTreeStore";
import {
  findParentArray,
  findTargetArray,
  insertAlphabetically,
  removeById,
} from "./lib/tree-helpers";

export type ConsoleAccessLevel = TreeAccessLevel;

export interface ConsoleEntry extends ResourceTreeEntry {
  children?: ConsoleEntry[];
  content?: string;
  folderId?: string;
  connectionId?: string;
  databaseId?: string;
  databaseName?: string;
  language?: "sql" | "javascript" | "mongodb";
  description?: string;
  isPrivate?: boolean;
  lastExecutedAt?: Date;
  executionCount?: number;
}

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

/** What consoles need beyond the shared tree slice. */
export interface ConsoleTreeExtra {
  searchQuery: string;
  searchResults: ConsoleSearchResult[];
  searchLoading: boolean;
  /** Server-side search (matches descriptions the tree filter cannot see). */
  searchConsoles: (workspaceId: string, query: string) => Promise<void>;
  clearSearch: () => void;
  /** Place a just-saved console at `path` in "My consoles" (no request). */
  addConsole: (workspaceId: string, path: string, id: string) => void;
  /**
   * Surgically rename a tree node by id from a REMOTE signal (agent edit or
   * another window) — in place, WITHOUT an API call and WITHOUT a full
   * refetch. This keeps the sidebar update Apollo-like (patch the entity by
   * id) so there are no loading skeletons or layout shift. No-op if the node
   * is not in the tree (e.g. an unsaved draft) or already has the new name.
   */
  applyRemoteRename: (
    workspaceId: string,
    itemId: string,
    newName: string,
  ) => void;
  duplicateConsole: (
    workspaceId: string,
    consoleId: string,
  ) => Promise<{ id: string; name: string } | null>;
  /** Undo a soft delete; refetches the tree on success. */
  restoreConsole: (workspaceId: string, consoleId: string) => Promise<boolean>;
}

const base = "/api/workspaces/{workspaceId}/consoles" as const;

/**
 * The console API answers `{ success: false }` with a 200; the factory's
 * refresh-on-failure path is driven by thrown errors, so surface it as one.
 */
const ok = <R extends { success?: boolean }>(res: R): R => {
  if (!res.success) throw new Error("Request failed");
  return res;
};

/** The consoles tree: entry type + endpoints + console-only extras. */
export const useConsoleTreeStore = createResourceTreeStore<
  ConsoleEntry,
  ConsoleTreeExtra
>({
  resourceName: "console",
  endpoints: {
    fetch: async workspaceId => {
      const data = unwrapBody(
        await api.GET(base, { params: { path: { workspaceId } } }),
      ) as {
        tree?: ConsoleEntry[];
        myConsoles?: ConsoleEntry[];
        sharedWithWorkspace?: ConsoleEntry[];
      };
      return {
        my: data.myConsoles ?? data.tree ?? [],
        workspace: data.sharedWithWorkspace ?? [],
      };
    },
    moveItem: async (workspaceId, id, folderId, access) =>
      ok(
        unwrapBody(
          await api.PATCH(`${base}/{id}/move`, {
            params: { path: { workspaceId, id } },
            body: { folderId, access },
          }),
        ) as { success: boolean },
      ),
    moveFolder: async (workspaceId, id, parentId, access) =>
      ok(
        unwrapBody(
          await api.PATCH(`${base}/folders/{id}/move`, {
            params: { path: { workspaceId, id } },
            body: { parentId, access },
          }),
        ) as { success: boolean },
      ),
    createFolder: async (workspaceId, name, parentId, access) =>
      ok(
        unwrapBody(
          await api.POST(`${base}/folders`, {
            params: { path: { workspaceId } },
            body: {
              name,
              parentId: parentId || undefined,
              isPrivate: access !== "workspace",
              access,
            },
          }),
        ) as { success: boolean; data?: { id: string; name: string } },
      ).data,
    renameItem: async (workspaceId, id, name) =>
      ok(
        unwrapBody(
          await api.PATCH(`${base}/{id}/rename`, {
            params: { path: { workspaceId, id } },
            body: { name },
          }),
        ) as { success: boolean },
      ),
    renameFolder: async (workspaceId, id, name) =>
      ok(
        unwrapBody(
          await api.PATCH(`${base}/folders/{id}/rename`, {
            params: { path: { workspaceId, id } },
            body: { name },
          }),
        ) as { success: boolean },
      ),
    deleteItem: async (workspaceId, id) =>
      ok(
        unwrapBody(
          await api.DELETE(`${base}/{id}`, {
            params: { path: { workspaceId, id } },
          }),
        ) as { success: boolean },
      ),
    deleteFolder: async (workspaceId, id) =>
      ok(
        unwrapBody(
          await api.DELETE(`${base}/folders/{id}`, {
            params: { path: { workspaceId, id } },
          }),
        ) as { success: boolean },
      ),
  },
  extend: (set, get, helpers) => ({
    searchQuery: "",
    searchResults: [],
    searchLoading: false,

    searchConsoles: async (workspaceId, query) => {
      set(state => {
        state.searchQuery = query;
        state.searchLoading = true;
      });
      try {
        const data = unwrapBody(
          await api.GET(`${base}/search`, {
            params: { path: { workspaceId }, query: { q: query } },
          }),
        ) as { results: ConsoleSearchResult[] };
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

    addConsole: (workspaceId, path, id) => {
      set(state => {
        const tree = state.myItems[workspaceId] || [];
        const segments = path.split("/").filter(Boolean);
        const fileName = segments[segments.length - 1];
        const folderSegments = segments.slice(0, -1);
        const existing = removeById(tree, id);
        const newConsole: ConsoleEntry = {
          ...(existing || {}),
          name: fileName,
          path,
          isDirectory: false,
          id,
        };
        const destination = findTargetArray(tree, folderSegments) || tree;
        insertAlphabetically(destination, newConsole);
        state.myItems[workspaceId] = tree;
      });
    },

    applyRemoteRename: (workspaceId, itemId, newName) => {
      set(state => {
        for (const section of helpers.allSections(state, workspaceId)) {
          const parent = findParentArray(section, itemId);
          if (!parent) continue;
          const idx = parent.findIndex(n => n.id === itemId);
          if (idx === -1) continue;
          if (parent[idx].name === newName) return; // already current — no-op
          // Splice + re-insert so the row lands in its sorted position, exactly
          // like the optimistic renameItem path. Only this node's parent array
          // changes, so React re-renders just that branch (no skeleton/refetch).
          const [node] = parent.splice(idx, 1);
          node.name = newName;
          insertAlphabetically(parent, node);
          return;
        }
      });
    },

    duplicateConsole: async (workspaceId, consoleId) => {
      try {
        const res = unwrapBody(
          await api.POST(`${base}/{id}/duplicate`, {
            params: { path: { workspaceId, id: consoleId } },
          }),
        ) as {
          success: boolean;
          data?: { id: string; name: string; folderId?: string };
        };
        if (!res.success || !res.data) return null;
        const created = res.data;
        set(state => {
          const original = helpers.findInAnySection(
            state,
            workspaceId,
            consoleId,
          );
          if (!original) return;
          const copy: ConsoleEntry = {
            ...original,
            id: created.id,
            name: created.name,
            isDirectory: false,
          };
          // The copy lands next to the original, whichever section/folder.
          for (const section of helpers.allSections(state, workspaceId)) {
            const parent = findParentArray(section, consoleId);
            if (parent) {
              insertAlphabetically(parent, copy);
              return;
            }
          }
        });
        return { id: created.id, name: created.name };
      } catch {
        return null;
      }
    },

    restoreConsole: async (workspaceId, consoleId) => {
      try {
        const res = unwrapBody(
          await api.PATCH(`${base}/{id}/restore`, {
            params: { path: { workspaceId, id: consoleId } },
          }),
        ) as { success: boolean };
        if (res.success) await get().refresh(workspaceId);
        return res.success;
      } catch {
        return false;
      }
    },
  }),
});
