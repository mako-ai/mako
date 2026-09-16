/**
 * Personal organization of an explorer's list — this user's Starred list and,
 * where an explorer offers them, their own folders.
 *
 * State is scoped per (workspace, KIND): apps, notebooks and dashboards each
 * keep their own lists, and every action takes the kind, defaulting to apps.
 * Without that dimension two explorers fetching at once would overwrite each
 * other's lists and star into the wrong one.
 *
 * **One home per entity** where an explorer has folders (the Slack-sections
 * model): an entity sits in exactly one of that kind's lists — a folder, or
 * Starred, or (in neither) its access-based home section. Filing moves it;
 * starring moves it. Where an explorer has NO personal folders, that sweep has
 * nothing to pull from, so a star is simply a shortcut alongside the existing
 * tree — the behaviour falls out rather than being special-cased.
 *
 * None of it can change an entity's sharing, identity or deployment — that is
 * the whole point, and why this shipped without touching the apps backend.
 *
 * Membership edits are optimistic because they come from a drag or a single
 * click, where a round trip feels broken; a failure restores the previous
 * lists and surfaces the message. Create/rename/delete come from dialogs,
 * where latency is expected, so those apply the server's answer directly.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import { api, toErrorMessage, unwrapBody } from "../api";

export interface PersonalFolder {
  id: string;
  kind: string;
  name: string;
  /** Entity keys — an app's slug, a notebook's or dashboard's id. */
  items: string[];
  /** Present on the one auto-created Starred list; absent on user folders. */
  system?: "starred";
  updatedAt?: string;
}

/** Explorer kinds. The key each stores is whatever identifies its entity. */
export const APP_FOLDER_KIND = "app";
export const NOTEBOOK_FOLDER_KIND = "notebook";
export const DASHBOARD_FOLDER_KIND = "dashboard";

const BASE = "/api/workspaces/{workspaceId}/personal-folders" as const;

/** Lists are per workspace AND per kind; this is the state key. */
const scopeOf = (workspaceId: string, kind: string) => `${workspaceId}:${kind}`;

interface PersonalFoldersState {
  byScope: Record<string, PersonalFolder[]>;
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
    kind?: string,
  ) => Promise<boolean>;
  deleteFolder: (
    workspaceId: string,
    folderId: string,
    kind?: string,
  ) => Promise<boolean>;
  /**
   * File an entity in a folder. One home per entity, so it leaves every other
   * list of this kind — Starred included.
   */
  addItem: (
    workspaceId: string,
    folderId: string,
    key: string,
    kind?: string,
  ) => Promise<boolean>;
  removeItem: (
    workspaceId: string,
    folderId: string,
    key: string,
    kind?: string,
  ) => Promise<boolean>;
  /** Star or unstar one entity. Idempotent. */
  toggleStar: (
    workspaceId: string,
    key: string,
    starred: boolean,
    kind?: string,
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
 * Apply a membership change locally first, then confirm with the server. The
 * whole scope's lists are snapshotted, because one change can touch several
 * (filing pulls from siblings). On failure the snapshot is restored, so a
 * rejected drag or click cannot leave the sidebar claiming a membership the
 * server does not have.
 */
async function optimistically(
  set: SetState,
  get: GetState,
  scope: string,
  apply: (folders: PersonalFolder[]) => void,
  request: () => Promise<{ folder?: PersonalFolder }>,
  failure: string,
): Promise<boolean> {
  const snapshot = (get().byScope[scope] ?? []).map(f => ({
    ...f,
    items: [...f.items],
  }));

  set(state => {
    const list = state.byScope[scope];
    if (list) apply(list);
  });

  try {
    const body = await request();
    if (body.folder) {
      const folder = body.folder;
      set(state => {
        const list = state.byScope[scope] ?? [];
        replaceFolder(list, folder);
        state.byScope[scope] = list;
      });
    }
    return true;
  } catch (e) {
    set(state => {
      state.byScope[scope] = snapshot;
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
    byScope: {},
    loading: {},
    error: null,

    fetchFolders: async (workspaceId, kind = APP_FOLDER_KIND) => {
      const scope = scopeOf(workspaceId, kind);
      set(state => {
        state.loading[scope] = true;
      });
      try {
        const body = unwrapBody(
          await api.GET(BASE, {
            params: { path: { workspaceId }, query: { kind } },
          }),
        ) as { folders?: PersonalFolder[] };
        set(state => {
          state.byScope[scope] = body.folders ?? [];
          state.loading[scope] = false;
        });
      } catch (e) {
        set(state => {
          state.loading[scope] = false;
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
          const scope = scopeOf(workspaceId, kind);
          const list = state.byScope[scope] ?? [];
          replaceFolder(list, folder);
          state.byScope[scope] = list;
        });
        return folder;
      } catch (e) {
        set(state => {
          state.error = toErrorMessage(e, "Failed to create the folder");
        });
        return null;
      }
    },

    renameFolder: async (
      workspaceId,
      folderId,
      name,
      kind = APP_FOLDER_KIND,
    ) => {
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
            const scope = scopeOf(workspaceId, kind);
            const list = state.byScope[scope] ?? [];
            replaceFolder(list, folder);
            state.byScope[scope] = list;
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

    deleteFolder: async (workspaceId, folderId, kind = APP_FOLDER_KIND) => {
      try {
        unwrapBody(
          await api.DELETE(`${BASE}/{id}`, {
            params: { path: { workspaceId, id: folderId } },
          }),
        );
        set(state => {
          const scope = scopeOf(workspaceId, kind);
          state.byScope[scope] = (state.byScope[scope] ?? []).filter(
            f => f.id !== folderId,
          );
        });
        return true;
      } catch (e) {
        set(state => {
          state.error = toErrorMessage(e, "Failed to delete the folder");
        });
        return false;
      }
    },

    addItem: (workspaceId, folderId, key, kind = APP_FOLDER_KIND) =>
      optimistically(
        set,
        get,
        scopeOf(workspaceId, kind),
        folders => {
          // One home per entity: filing it here takes it out of every other
          // list of this kind, Starred included.
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

    removeItem: (workspaceId, folderId, key, kind = APP_FOLDER_KIND) =>
      optimistically(
        set,
        get,
        scopeOf(workspaceId, kind),
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

    toggleStar: (workspaceId, key, starred, kind = APP_FOLDER_KIND) =>
      optimistically(
        set,
        get,
        scopeOf(workspaceId, kind),
        folders => {
          // Where this kind has folders, starring is a move and pulls the
          // entity out of them; where it has none, the loop below simply has
          // nothing to pull from and a star is a plain shortcut. Until the
          // first star there is no Starred list locally — the server creates
          // it and the response inserts it.
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
              body: { key, starred, kind },
            }),
          ) as { folder?: PersonalFolder },
        starred ? "Failed to star" : "Failed to unstar",
      ),

    clearError: () =>
      set(state => {
        state.error = null;
      }),

    reset: () => set({ byScope: {}, loading: {}, error: null }),
  })),
);

export const selectPersonalFolders =
  (workspaceId: string | undefined, kind: string = APP_FOLDER_KIND) =>
  (state: PersonalFoldersStore): PersonalFolder[] =>
    workspaceId
      ? (state.byScope[scopeOf(workspaceId, kind)] ?? NO_FOLDERS)
      : NO_FOLDERS;
