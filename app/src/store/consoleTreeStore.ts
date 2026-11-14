import { api, unwrapBody, ApiError, toErrorMessage } from "../api";
import { consoleNamePreview, savedAsNotice } from "../lib/console-names";
import {
  restoreTrashedFolder,
  type FolderRestoreOutcome,
  type TrashedFolder,
} from "../lib/console-trash";
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
  /**
   * Why the last rename, move, delete or restore was refused, in the
   * server's words (a name already taken, a change of who sees a console
   * that is not theirs to make). The tree only snaps back; this says why.
   */
  actionError: Record<string, string | null>;
  clearActionError: (workspaceId: string) => void;
  /** What the last action did when the tree alone does not say it. */
  actionNotice: Record<string, string | null>;
  clearActionNotice: (workspaceId: string) => void;
  /**
   * Move a console and, optionally, rename it — one request, one commit.
   * Answers where the console is now (its name as saved), or null when
   * the move was refused (`actionError` says why).
   */
  moveConsole: (
    workspaceId: string,
    consoleId: string,
    folderId: string | null,
    access?: ConsoleAccessLevel,
    name?: string,
  ) => Promise<ConsoleLocation | null>;
  /**
   * Delete a folder: its consoles move to the trash. Answers what went
   * there — what `restoreFolder` puts back — or null when refused.
   */
  trashFolder: (
    workspaceId: string,
    folderId: string,
  ) => Promise<TrashedFolder | null>;
  /**
   * Undo a delete: the console back in place — or as "name (2)" when its
   * name was taken — or in `folderId`. Refetches the tree on success.
   */
  restoreConsole: (
    workspaceId: string,
    consoleId: string,
    folderId?: string | null,
  ) => Promise<ConsoleLocation | null>;
  /** Undo a folder delete: the folder again, its consoles back in it. */
  restoreFolder: (
    workspaceId: string,
    trashed: TrashedFolder,
    parentId: string | null,
  ) => Promise<FolderRestoreOutcome>;
}

/** Where a console is, as a rename, a move or a restore answers. */
export interface ConsoleLocation {
  id: string;
  name: string;
  path: string;
  folderId: string | null;
  access: ConsoleAccessLevel;
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
      try {
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
      } catch (error) {
        // Writes 412 without GitHub; GET/list is an empty explorer (disconnect
        // or never linked). Keeping the previous tree left the sidebar
        // populated after unlink.
        if (error instanceof ApiError && error.status === 412) {
          return { my: [], workspace: [] };
        }
        throw error;
      }
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
              access,
            },
          }),
        ) as { success: boolean; data?: { id: string; name: string } },
      ).data,
    // Both answer with the name as saved (`data.name`). A console's inline
    // rename is ONE name: sent as it will be saved, so a "/" typed in it is
    // a character with a stand-in, as in the dialogs — the route itself
    // reads `Folder/name` as a move, which a rename in place is not.
    renameItem: async (workspaceId, id, name) =>
      ok(
        unwrapBody(
          await api.PATCH(`${base}/{id}/rename`, {
            params: { path: { workspaceId, id } },
            body: { name: consoleNamePreview(name, "console").name || name },
          }),
        ) as { success: boolean; data?: { name?: string } },
      ).data,
    renameFolder: async (workspaceId, id, name) =>
      ok(
        unwrapBody(
          await api.PATCH(`${base}/folders/{id}/rename`, {
            params: { path: { workspaceId, id } },
            body: { name },
          }),
        ) as { success: boolean; data?: { name?: string } },
      ).data,
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
  onActionError: (set, workspaceId, error) => {
    set(state => {
      state.actionError[workspaceId] = toErrorMessage(
        error,
        "That could not be done",
      );
    });
  },
  onSavedAs: (set, workspaceId, typed, saved) => {
    set(state => {
      state.actionNotice[workspaceId] = savedAsNotice(typed, saved);
    });
  },
  extend: (set, get, helpers) => ({
    actionError: {},
    clearActionError: workspaceId => {
      set(state => {
        state.actionError[workspaceId] = null;
      });
    },
    actionNotice: {},
    clearActionNotice: workspaceId => {
      set(state => {
        state.actionNotice[workspaceId] = null;
      });
    },

    moveConsole: async (workspaceId, consoleId, folderId, access, name) => {
      try {
        const res = ok(
          unwrapBody(
            await api.PATCH(`${base}/{id}/move`, {
              params: { path: { workspaceId, id: consoleId } },
              body: { folderId, access, name },
            }),
          ) as { success: boolean; data?: ConsoleLocation },
        );
        // The tree is the server's: where the console landed, under the
        // name it was saved as.
        await get().refresh(workspaceId);
        return res.data ?? null;
      } catch (error) {
        set(state => {
          state.actionError[workspaceId] = toErrorMessage(
            error,
            "The console could not be moved",
          );
        });
        return null;
      }
    },

    trashFolder: async (workspaceId, folderId) => {
      set(state => {
        helpers.removeFromAnySection(state, workspaceId, folderId);
      });
      try {
        const res = ok(
          unwrapBody(
            await api.DELETE(`${base}/folders/{id}`, {
              params: { path: { workspaceId, id: folderId } },
            }),
          ) as { success: boolean; data?: Partial<TrashedFolder> },
        );
        return {
          folders: res.data?.folders ?? [],
          consoles: res.data?.consoles ?? [],
        };
      } catch (error) {
        set(state => {
          state.actionError[workspaceId] = toErrorMessage(
            error,
            "The folder could not be deleted",
          );
        });
        await get().refresh(workspaceId);
        return null;
      }
    },

    restoreFolder: async (workspaceId, trashed, parentId) => {
      const outcome = await restoreTrashedFolder(
        {
          createFolder: async (name, parent, access) => {
            try {
              const res = unwrapBody(
                await api.POST(`${base}/folders`, {
                  params: { path: { workspaceId } },
                  body: { name, parentId: parent || undefined, access },
                }),
              ) as { success: boolean; data?: { id: string } };
              return res.success ? (res.data?.id ?? null) : null;
            } catch {
              return null;
            }
          },
          restoreConsole: (id, folderId) =>
            restoreOne(workspaceId, id, folderId).then(
              restored => restored !== null,
              () => false,
            ),
        },
        trashed,
        parentId,
      );
      await get().refresh(workspaceId);
      return outcome;
    },

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

    restoreConsole: async (workspaceId, consoleId, folderId) => {
      try {
        const restored = await restoreOne(workspaceId, consoleId, folderId);
        if (restored) await get().refresh(workspaceId);
        return restored;
      } catch (error) {
        set(state => {
          state.actionError[workspaceId] = toErrorMessage(
            error,
            "The console could not be restored",
          );
        });
        return null;
      }
    },
  }),
});

/**
 * `PATCH /{id}/restore`: back where it was, or in `folderId` (null = the
 * root). Throws the server's refusal.
 */
async function restoreOne(
  workspaceId: string,
  consoleId: string,
  folderId?: string | null,
): Promise<ConsoleLocation | null> {
  const res = unwrapBody(
    await api.PATCH(`${base}/{id}/restore`, {
      params: { path: { workspaceId, id: consoleId } },
      ...(folderId === undefined ? {} : { body: { folderId } }),
    }),
  ) as { success: boolean; data?: ConsoleLocation };
  return res.success ? (res.data ?? null) : null;
}
