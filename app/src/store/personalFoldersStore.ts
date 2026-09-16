/**
 * Personal folders — one user's private organization of an explorer's list.
 *
 * **One home per entity**, the Slack-sections model: an entity sits in exactly
 * one of this user's lists — a folder, or Starred, or (in neither) its
 * access-based home section. Filing moves it; starring moves it. Starred is
 * just the system row (`system: "starred"`), created on first use and never
 * renamed or deleted.
 *
 * None of it can change an entity's sharing, identity or deployment — that is
 * the whole point, and why this shipped without touching the apps backend.
 *
 * Membership edits are optimistic because they come from a drag or a single
 * click, where a round trip feels broken; a failure restores the previous
 * list and surfaces the message. Create/rename/delete come from dialogs,
 * where latency is expected, so those apply the server's answer directly.
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
  /** Present on the one auto-created Starred list; absent on user folders. */
  system?: "starred";
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
  /**
   * File an entity in a folder. One home per entity, so it leaves every other
   * list of this kind — Starred included.
   */
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
  /** Star or unstar one entity. Idempotent. */
  toggleStar: (
    workspaceId: string,
    key: string,
    starred: boolean,
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

type SetState = (fn: (state: PersonalFoldersStore) => void) => void;
type GetState = () => PersonalFoldersStore;

/**
 * Apply a membership change locally first, then confirm with the server.
 * The whole workspace list is snapshotted, because a single change can touch
 * several folders (filing pulls from siblings). On failure the snapshot is
 * restored, so a rejected drag or click cannot leave the sidebar claiming a
 * membership the server does not have.
 */
async function optimistically(
  set: SetState,
  get: GetState,
  workspaceId: string,
  apply: (folders: PersonalFolder[]) => void,
  request: () => Promise<{ folder?: PersonalFolder }>,
  failure: string,
): Promise<boolean> {
  const snapshot = (get().byWorkspace[workspaceId] ?? []).map(f => ({
    ...f,
    items: [...f.items],
  }));

  set(state => {
    const list = state.byWorkspace[workspaceId];
    if (list) apply(list);
  });

  try {
    const body = await request();
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
      state.byWorkspace[workspaceId] = snapshot;
      state.error = toErrorMessage(e, failure);
    });
    return false;
  }
}

const without = (items: string[], key: string) =>
  items.filter(item => item !== key);
const withKey = (items: string[], key: string) =>
  items.includes(key) ? items : [...items, key];

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

    addItem: (workspaceId, folderId, key) =>
      optimistically(
        set,
        get,
        workspaceId,
        folders => {
          // One home per app: filing it here takes it out of every other
          // list, Starred included.
          for (const f of folders) {
            f.items =
              f.id === folderId ? withKey(f.items, key) : without(f.items, key);
          }
        },
        async () =>
          unwrapBody(
            await api.PATCH(`${BASE}/{id}/items`, {
              params: { path: { workspaceId, id: folderId } },
              body: { add: [key] },
            }),
          ) as { folder?: PersonalFolder },
        "Failed to update the folder",
      ),

    removeItem: (workspaceId, folderId, key) =>
      optimistically(
        set,
        get,
        workspaceId,
        folders => {
          const f = folders.find(x => x.id === folderId);
          if (f) f.items = without(f.items, key);
        },
        async () =>
          unwrapBody(
            await api.PATCH(`${BASE}/{id}/items`, {
              params: { path: { workspaceId, id: folderId } },
              body: { remove: [key] },
            }),
          ) as { folder?: PersonalFolder },
        "Failed to update the folder",
      ),

    toggleStar: (workspaceId, key, starred) =>
      optimistically(
        set,
        get,
        workspaceId,
        folders => {
          // Starring is a move like any other, so it also leaves whatever
          // folder the app was in. Until the first star there is no Starred
          // list locally; the server creates it and the response inserts it.
          for (const f of folders) {
            if (f.system === "starred") {
              f.items = starred ? withKey(f.items, key) : without(f.items, key);
            } else if (starred) {
              f.items = without(f.items, key);
            }
          }
        },
        async () =>
          unwrapBody(
            await api.POST(`${BASE}/star`, {
              params: { path: { workspaceId } },
              body: { key, starred },
            }),
          ) as { folder?: PersonalFolder },
        starred ? "Failed to star" : "Failed to unstar",
      ),

    clearError: () =>
      set(state => {
        state.error = null;
      }),

    reset: () => set({ byWorkspace: {}, loading: {}, error: null }),
  })),
);

export const selectPersonalFolders =
  (workspaceId: string | undefined) =>
  (state: PersonalFoldersStore): PersonalFolder[] =>
    workspaceId ? (state.byWorkspace[workspaceId] ?? NO_FOLDERS) : NO_FOLDERS;
