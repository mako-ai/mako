/**
 * Personal folders — one user's private grouping of entities in an explorer.
 *
 * Purely an organization layer: a folder holds entity KEYS (an app's slug) and
 * can never change the entity itself. Nothing here touches an app's sharing,
 * identity or deployment — that is the whole point of the feature, and the
 * reason it could ship without changing the apps backend at all.
 *
 * Membership edits are optimistic because they are driven by dragging a row,
 * where waiting on a round trip feels broken; a failure puts the previous
 * items back and surfaces the message. Create/rename/delete come from dialogs,
 * where the latency is expected, so those apply the server's answer directly.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import { api, toErrorMessage, unwrapBody } from "../api";

export interface PersonalFolder {
  id: string;
  kind: string;
  name: string;
  /** Entity keys — for apps, the slug. May reference something long gone. */
  items: string[];
  updatedAt?: string;
}

/** The explorer this store is serving; apps are the first adopter. */
export const APP_FOLDER_KIND = "app";

const BASE = "/api/workspaces/{workspaceId}/personal-folders" as const;

interface PersonalFoldersState {
  byWorkspace: Record<string, PersonalFolder[]>;
  loading: Record<string, boolean>;
  error: string | null;
}

interface PersonalFoldersActions {
  fetchFolders: (workspaceId: string, kind?: string) => Promise<void>;
  createFolder: (
    workspaceId: string,
    name: string,
    kind?: string,
  ) => Promise<PersonalFolder | null>;
  renameFolder: (
    workspaceId: string,
    folderId: string,
    name: string,
  ) => Promise<boolean>;
  deleteFolder: (workspaceId: string, folderId: string) => Promise<boolean>;
  /** Add an entity key. Idempotent — the server stores membership as a set. */
  addItem: (
    workspaceId: string,
    folderId: string,
    key: string,
  ) => Promise<boolean>;
  removeItem: (
    workspaceId: string,
    folderId: string,
    key: string,
  ) => Promise<boolean>;
  clearError: () => void;
  reset: () => void;
}

type PersonalFoldersStore = PersonalFoldersState & PersonalFoldersActions;

/** Empty-array constant so selectors keep a stable reference. */
const NO_FOLDERS: PersonalFolder[] = [];

function replaceFolder(list: PersonalFolder[], next: PersonalFolder): void {
  const index = list.findIndex(f => f.id === next.id);
  if (index === -1) {
    list.push(next);
  } else {
    list[index] = next;
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
}

export const usePersonalFoldersStore = create<PersonalFoldersStore>()(
  immer((set, get) => ({
    byWorkspace: {},
    loading: {},
    error: null,

    fetchFolders: async (workspaceId, kind = APP_FOLDER_KIND) => {
      set(state => {
        state.loading[workspaceId] = true;
      });
      try {
        const body = unwrapBody(
          await api.GET(BASE, {
            params: { path: { workspaceId }, query: { kind } },
          }),
        ) as { folders?: PersonalFolder[] };
        set(state => {
          state.byWorkspace[workspaceId] = body.folders ?? [];
          state.loading[workspaceId] = false;
        });
      } catch (e) {
        set(state => {
          state.loading[workspaceId] = false;
          state.error = toErrorMessage(e, "Failed to load your folders");
        });
      }
    },

    createFolder: async (workspaceId, name, kind = APP_FOLDER_KIND) => {
      try {
        const body = unwrapBody(
          await api.POST(BASE, {
            params: { path: { workspaceId } },
            body: { name, kind },
          }),
        ) as { folder?: PersonalFolder };
        const folder = body.folder;
        if (!folder) return null;
        set(state => {
          const list = state.byWorkspace[workspaceId] ?? [];
          replaceFolder(list, folder);
          state.byWorkspace[workspaceId] = list;
        });
        return folder;
      } catch (e) {
        set(state => {
          state.error = toErrorMessage(e, "Failed to create the folder");
        });
        return null;
      }
    },

    renameFolder: async (workspaceId, folderId, name) => {
      try {
        const body = unwrapBody(
          await api.PATCH(`${BASE}/{id}`, {
            params: { path: { workspaceId, id: folderId } },
            body: { name },
          }),
        ) as { folder?: PersonalFolder };
        if (body.folder) {
          const folder = body.folder;
          set(state => {
            const list = state.byWorkspace[workspaceId] ?? [];
            replaceFolder(list, folder);
            state.byWorkspace[workspaceId] = list;
          });
        }
        return true;
      } catch (e) {
        set(state => {
          state.error = toErrorMessage(e, "Failed to rename the folder");
        });
        return false;
      }
    },

    deleteFolder: async (workspaceId, folderId) => {
      try {
        unwrapBody(
          await api.DELETE(`${BASE}/{id}`, {
            params: { path: { workspaceId, id: folderId } },
          }),
        );
        set(state => {
          state.byWorkspace[workspaceId] = (
            state.byWorkspace[workspaceId] ?? []
          ).filter(f => f.id !== folderId);
        });
        return true;
      } catch (e) {
        set(state => {
          state.error = toErrorMessage(e, "Failed to delete the folder");
        });
        return false;
      }
    },

    addItem: async (workspaceId, folderId, key) =>
      updateItems(set, get, workspaceId, folderId, { add: [key] }, items =>
        items.includes(key) ? items : [...items, key],
      ),

    removeItem: async (workspaceId, folderId, key) =>
      updateItems(set, get, workspaceId, folderId, { remove: [key] }, items =>
        items.filter(item => item !== key),
      ),

    clearError: () =>
      set(state => {
        state.error = null;
      }),

    reset: () => set({ byWorkspace: {}, loading: {}, error: null }),
  })),
);

type SetState = (fn: (state: PersonalFoldersStore) => void) => void;
type GetState = () => PersonalFoldersStore;

/**
 * Apply an item change locally first, then confirm with the server. On failure
 * the previous items are restored, so a rejected drag cannot leave the sidebar
 * claiming a membership the server does not have.
 */
async function updateItems(
  set: SetState,
  get: GetState,
  workspaceId: string,
  folderId: string,
  payload: { add?: string[]; remove?: string[] },
  optimistic: (items: string[]) => string[],
): Promise<boolean> {
  const before = get().byWorkspace[workspaceId]?.find(
    f => f.id === folderId,
  )?.items;
  if (!before) return false;

  set(state => {
    const folder = state.byWorkspace[workspaceId]?.find(f => f.id === folderId);
    if (folder) folder.items = optimistic(folder.items);
  });

  try {
    const body = unwrapBody(
      await api.PATCH(`${BASE}/{id}/items`, {
        params: { path: { workspaceId, id: folderId } },
        body: payload,
      }),
    ) as { folder?: PersonalFolder };
    if (body.folder) {
      const folder = body.folder;
      set(state => {
        const list = state.byWorkspace[workspaceId] ?? [];
        replaceFolder(list, folder);
        state.byWorkspace[workspaceId] = list;
      });
    }
    return true;
  } catch (e) {
    set(state => {
      const folder = state.byWorkspace[workspaceId]?.find(
        f => f.id === folderId,
      );
      if (folder) folder.items = before;
      state.error = toErrorMessage(e, "Failed to update the folder");
    });
    return false;
  }
}

export const selectPersonalFolders =
  (workspaceId: string | undefined) =>
  (state: PersonalFoldersStore): PersonalFolder[] =>
    workspaceId ? (state.byWorkspace[workspaceId] ?? NO_FOLDERS) : NO_FOLDERS;
