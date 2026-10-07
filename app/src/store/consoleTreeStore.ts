import { api, unwrapBody, ApiError, toErrorMessage } from "../api";
import type { ConsoleContentResponse, ConsoleLocation } from "../lib/api-types";
import { consoleNameAsSaved } from "../lib/console-relocation";
import {
  markDeletedHere,
  unmarkDeletedHere,
} from "./lib/console-local-deletes";
import {
  createResourceTreeStore,
  type ResourceTreeEntry,
  type TreeAccessLevel,
} from "./lib/createResourceTreeStore";
import {
  findParentArray,
  findTargetArray,
  insertAlphabetically,
  namesTrailOf,
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
  /**
   * The server's write rule for the caller (owner, a share as editor, the
   * workspace role): Rename is offered by it — a shared editor renames in
   * place even though moving the console or changing who sees it is not
   * theirs.
   */
  canWrite?: boolean;
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
  /**
   * Copy a console into the caller's My Consoles. Resolves to the copy —
   * its id, name and path in the tree (folders + name) — or null (the
   * reason is in `actionError`).
   */
  duplicateConsole: (
    workspaceId: string,
    consoleId: string,
  ) => Promise<{ id: string; name: string; path: string } | null>;
  /**
   * Undo a soft delete; refetches the tree on success. Resolves to the
   * name it came back under ("name (2)" when its name was taken), or null.
   */
  restoreConsole: (
    workspaceId: string,
    consoleId: string,
  ) => Promise<{ name?: string } | null>;
}

const base = "/api/workspaces/{workspaceId}/consoles" as const;

/**
 * Point an open tab at where the server says the console is now — after
 * EVERY rename or move the tree makes (inline rename, drag, "Move to…", the
 * editor's Rename / Move dialog), from the route's own answer. The tab kept
 * its old path before, showed it as a fake parent in the breadcrumb, and its
 * next save moved the console back. Lazy import: the tab store persists to
 * localStorage, the tree store must not load it with itself.
 */
async function retargetOpenTab(
  workspaceId: string,
  location: ConsoleLocation | undefined,
): Promise<void> {
  if (!location?.id) return;
  // The tree's own row: the optimistic update renamed/moved it, but its
  // path (what a click opens the tab with) is the server's to say.
  useConsoleTreeStore.setState(state => {
    const node = findIn(
      [
        ...(state.myItems[workspaceId] ?? []),
        ...(state.workspaceItems[workspaceId] ?? []),
        ...(state.sharedItems[workspaceId] ?? []),
      ],
      location.id,
    );
    if (node && node.path !== location.path) node.path = location.path;
    // …and its name: the one the server saved (a cleaned one, maybe).
    if (node && location.name && node.name !== location.name) {
      node.name = location.name;
    }
  });
  const { useConsoleStore } = await import("./consoleStore");
  useConsoleStore.getState().retargetConsoleTab(location.id, location);
}

function findIn(
  nodes: ConsoleEntry[] | undefined,
  id: string,
): ConsoleEntry | null {
  for (const node of nodes ?? []) {
    if (node.id === id) return node;
    const hit = findIn(node.children, id);
    if (hit) return hit;
  }
  return null;
}

/** A node of the current tree, in any section. */
function findNode(workspaceId: string, id: string): ConsoleEntry | null {
  const state = useConsoleTreeStore.getState();
  return (
    findIn(state.myItems[workspaceId], id) ??
    findIn(state.workspaceItems[workspaceId], id) ??
    findIn(state.sharedItems[workspaceId], id)
  );
}

/**
 * A folder renamed: its row and every row under it carry a `path` (what a
 * click opens a tab with, what a notice names) — rewritten from the tree's
 * names with the folder's new one. Left as they were, a console opened
 * from the renamed folder got its old place, and "Move to…" into it said
 * "Moved to New Folder" after it had become "Fold2".
 */
function repathFolder(workspaceId: string, folderId: string, name: string) {
  useConsoleTreeStore.setState(state => {
    for (const section of [
      state.myItems[workspaceId],
      state.workspaceItems[workspaceId],
      state.sharedItems[workspaceId],
    ]) {
      if (!section) continue;
      const trail = namesTrailOf(section, folderId);
      const node = findIn(section, folderId);
      if (!trail || !node) continue;
      const repath = (n: ConsoleEntry, parent: string) => {
        n.path = parent ? `${parent}/${n.name}` : n.name;
        for (const child of n.children ?? []) repath(child, n.path);
      };
      node.name = name;
      repath(node, trail.slice(0, -1).join("/"));
      return;
    }
  });
}

/** Every console id under a folder node (any depth). */
function consoleIdsUnder(node: ConsoleEntry | null | undefined): string[] {
  if (!node?.children) return [];
  const ids: string[] = [];
  for (const child of node.children) {
    if (child.isDirectory) ids.push(...consoleIdsUnder(child));
    else if (child.id) ids.push(child.id);
  }
  return ids;
}

/**
 * A folder renamed or moved changes the path of every console in it: open
 * tabs among them re-read where they are (GET /content — location only;
 * their content, unsaved edits included, is left alone).
 */
async function retargetOpenTabsUnder(
  workspaceId: string,
  consoleIds: string[],
): Promise<void> {
  if (consoleIds.length === 0) return;
  const { useConsoleStore } = await import("./consoleStore");
  const open = consoleIds.filter(id => useConsoleStore.getState().tabs[id]);
  await Promise.all(
    open.map(async id => {
      try {
        const res = unwrapBody(
          await api.GET(`${base}/content`, {
            params: { path: { workspaceId }, query: { id } },
          }),
        ) as ConsoleContentResponse;
        if (!res.success) return;
        useConsoleStore.getState().retargetConsoleTab(id, {
          name: res.name,
          path: res.path,
          access: res.access,
          isSaved: res.isSaved,
        });
      } catch {
        // Best effort: the next open or revision sync corrects it.
      }
    }),
  );
}

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
          sharedWithMe?: ConsoleEntry[];
        };
        return {
          my: data.myConsoles ?? data.tree ?? [],
          workspace: data.sharedWithWorkspace ?? [],
          // Another member's private console shared with this person: its
          // own section, as the breadcrumb names it (consolePlacement).
          shared: data.sharedWithMe ?? [],
        };
      } catch (error) {
        // Writes 412 without GitHub; GET/list is an empty explorer (disconnect
        // or never linked). Keeping the previous tree left the sidebar
        // populated after unlink.
        if (error instanceof ApiError && error.status === 412) {
          return { my: [], workspace: [], shared: [] };
        }
        throw error;
      }
    },
    moveItem: async (workspaceId, id, folderId, access, name) => {
      const res = ok(
        unwrapBody(
          await api.PATCH(`${base}/{id}/move`, {
            params: { path: { workspaceId, id } },
            // A rename-while-moving rides along so the server commits once.
            body: { folderId, access, ...(name ? { name } : {}) },
          }),
        ) as { success: boolean; data?: ConsoleLocation },
      );
      await retargetOpenTab(workspaceId, res.data);
      return res;
    },
    moveFolder: async (workspaceId, id, parentId, access) => {
      const inside = consoleIdsUnder(findNode(workspaceId, id));
      const res = ok(
        unwrapBody(
          await api.PATCH(`${base}/folders/{id}/move`, {
            params: { path: { workspaceId, id } },
            body: { parentId, access },
          }),
        ) as { success: boolean },
      );
      void retargetOpenTabsUnder(workspaceId, inside);
      return res;
    },
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
    renameItem: async (workspaceId, id, name) => {
      const res = ok(
        unwrapBody(
          await api.PATCH(`${base}/{id}/rename`, {
            params: { path: { workspaceId, id } },
            // A name typed in the tree is a NAME: "A/B test" is not a move
            // into a folder "A" (this route reads a "/" as one) — its "/"
            // gets the stand-in the server gives every such character.
            body: { name: consoleNameAsSaved(name) },
          }),
        ) as { success: boolean; console?: ConsoleLocation },
      );
      await retargetOpenTab(workspaceId, res.console);
      return { ...res, savedName: res.console?.name };
    },
    renameFolder: async (workspaceId, id, name) => {
      const inside = consoleIdsUnder(findNode(workspaceId, id));
      const res = ok(
        unwrapBody(
          await api.PATCH(`${base}/folders/{id}/rename`, {
            params: { path: { workspaceId, id } },
            body: { name },
          }),
        ) as { success: boolean; data?: { name?: string } },
      );
      repathFolder(workspaceId, id, res.data?.name ?? name);
      void retargetOpenTabsUnder(workspaceId, inside);
      return { ...res, savedName: res.data?.name };
    },
    deleteItem: async (workspaceId, id) => {
      // The deletion this window makes is announced back to it: its banner
      // says "Moved to trash", not "deleted elsewhere".
      markDeletedHere(id);
      try {
        return ok(
          unwrapBody(
            await api.DELETE(`${base}/{id}`, {
              params: { path: { workspaceId, id } },
            }),
          ) as { success: boolean },
        );
      } catch (error) {
        unmarkDeletedHere(id);
        throw error;
      }
    },
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
          error?: string;
          data?: {
            id: string;
            name: string;
            folderId?: string | null;
            owner_id?: string;
          };
        };
        if (!res.success || !res.data) {
          throw new Error(res.error || "Could not duplicate the console.");
        }
        const created = res.data;
        let placedPath = created.name;
        set(state => {
          const original = helpers.findInAnySection(
            state,
            workspaceId,
            consoleId,
          );
          const copy: ConsoleEntry = {
            ...(original ?? {}),
            id: created.id,
            name: created.name,
            path: created.name,
            isDirectory: false,
            access: "private",
            isPrivate: true,
            canWrite: true,
            ...(created.owner_id ? { owner_id: created.owner_id } : {}),
          };
          delete copy.children;
          // A copy is the copier's: My Consoles, in the folder the server
          // chose (theirs — never the original's when that is someone
          // else's or a workspace folder; null = the root). It used to land
          // next to the original — under Workspace, for a console shared
          // with them — until a refresh moved it.
          helpers.insertIntoFolder(
            state,
            workspaceId,
            copy,
            created.folderId ?? null,
            "my",
          );
          const folder = created.folderId
            ? helpers.findInAnySection(state, workspaceId, created.folderId)
            : null;
          const placed = helpers.findInAnySection(
            state,
            workspaceId,
            created.id,
          );
          if (placed && folder?.path) {
            placed.path = `${folder.path}/${created.name}`;
          }
          placedPath = placed?.path ?? created.name;
        });
        return { id: created.id, name: created.name, path: placedPath };
      } catch (err: unknown) {
        // The server's reason, for the explorer's snackbar — a failed copy
        // used to say nothing at all.
        set(state => {
          state.actionError[workspaceId] = toErrorMessage(
            err,
            "Could not duplicate the console.",
          );
        });
        return null;
      }
    },

    restoreConsole: async (workspaceId, consoleId) => {
      try {
        const res = unwrapBody(
          await api.PATCH(`${base}/{id}/restore`, {
            params: { path: { workspaceId, id: consoleId } },
          }),
        ) as { success: boolean; console?: ConsoleLocation };
        if (!res.success) return null;
        await get().refresh(workspaceId);
        return { name: res.console?.name };
      } catch {
        return null;
      }
    },
  }),
});
