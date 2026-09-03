/**
 * ONE tree store for every foldered resource (notebooks, dashboards,
 * consoles, …).
 *
 * The two-section tree ("My X" / "Workspace X"), the optimistic move /
 * rename / create-folder / delete with refresh-on-failure, the per-workspace
 * loading and error flags — all of it was copied per resource:
 * notebookTreeStore and dashboardTreeStore differed by 29 lines out of 400
 * once the noun was renamed, and consoleTreeStore forked to grow a third
 * section and then drifted 600 lines. A resource now supplies only its
 * entry type and its endpoints; the mechanics live here once. Anything a
 * resource needs beyond the shared set (consoles: search, remote rename,
 * duplicate, restore) composes on top through `extend`, which receives the
 * same section helpers the built-in actions use.
 */
import { create, type StateCreator } from "zustand";
import { immer } from "zustand/middleware/immer";
import { toErrorMessage } from "../../api";
import {
  findById,
  removeById,
  insertAlphabetically,
  insertAtTop,
  findParentArray,
} from "./tree-helpers";

export type TreeAccessLevel = "private" | "workspace";
export type TreeSection = "my" | "workspace";

export interface ResourceTreeEntry {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  children?: ResourceTreeEntry[];
  access?: TreeAccessLevel;
  owner_id?: string;
  readOnly?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * What a resource must know how to do; the store never builds a URL. An
 * endpoint that resolves counts as success; one that throws triggers the
 * refresh-on-failure path (so an endpoint whose envelope carries
 * `success: false` should throw on it).
 */
export interface ResourceTreeEndpoints<T extends ResourceTreeEntry> {
  fetch: (workspaceId: string) => Promise<{ my: T[]; workspace: T[] }>;
  moveItem: (
    workspaceId: string,
    id: string,
    folderId: string | null,
    access?: TreeAccessLevel,
  ) => Promise<unknown>;
  moveFolder: (
    workspaceId: string,
    id: string,
    parentId: string | null,
    access?: TreeAccessLevel,
  ) => Promise<unknown>;
  createFolder: (
    workspaceId: string,
    name: string,
    parentId: string | null | undefined,
    access: TreeAccessLevel,
  ) => Promise<{ id: string } | null | undefined>;
  renameItem: (
    workspaceId: string,
    id: string,
    name: string,
  ) => Promise<unknown>;
  renameFolder: (
    workspaceId: string,
    id: string,
    name: string,
  ) => Promise<unknown>;
  deleteItem: (workspaceId: string, id: string) => Promise<unknown>;
  deleteFolder: (workspaceId: string, id: string) => Promise<unknown>;
}

export interface ResourceTreeState<T extends ResourceTreeEntry> {
  myItems: Record<string, T[]>;
  workspaceItems: Record<string, T[]>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;

  fetchTree: (workspaceId: string) => Promise<void>;
  refresh: (workspaceId: string) => Promise<void>;
  /** Optimistic; resolves `false` after the tree was refetched on failure. */
  moveItem: (
    workspaceId: string,
    itemId: string,
    targetFolderId: string | null,
    access?: TreeAccessLevel,
  ) => Promise<boolean>;
  moveFolder: (
    workspaceId: string,
    folderId: string,
    parentId: string | null,
    access?: TreeAccessLevel,
  ) => Promise<boolean>;
  createFolder: (
    workspaceId: string,
    name: string,
    parentId?: string | null,
    access?: TreeAccessLevel,
  ) => Promise<string | null>;
  renameItem: (
    workspaceId: string,
    itemId: string,
    name: string,
    isDirectory: boolean,
  ) => Promise<boolean>;
  deleteItem: (
    workspaceId: string,
    itemId: string,
    isDirectory: boolean,
  ) => Promise<boolean>;
  resortItem: (workspaceId: string, itemId: string) => void;
}

/** The section arrays an extension mutates inside `set`. */
export type ResourceTreeSections<T extends ResourceTreeEntry> = Pick<
  ResourceTreeState<T>,
  "myItems" | "workspaceItems"
>;

/** The internal section helpers, handed to `extend` so extras compose. */
export interface ResourceTreeHelpers<T extends ResourceTreeEntry> {
  /** Both section arrays for a workspace (missing ones read as empty). */
  allSections: (state: ResourceTreeSections<T>, wid: string) => T[][];
  findInAnySection: (
    state: ResourceTreeSections<T>,
    wid: string,
    id: string,
  ) => T | null;
  removeFromAnySection: (
    state: ResourceTreeSections<T>,
    wid: string,
    id: string,
  ) => T | null;
  /** Into a folder's children, or the section root when it is not found. */
  insertIntoFolder: (
    state: ResourceTreeSections<T>,
    wid: string,
    entry: T,
    targetFolderId: string | null,
    targetSection: TreeSection,
    placement?: "alphabetical" | "top",
  ) => void;
  sectionOfFolder: (
    state: ResourceTreeSections<T>,
    wid: string,
    folderId: string,
  ) => TreeSection;
  /** Re-sort one node within its parent array (after a rename). */
  resortIn: (state: ResourceTreeSections<T>, wid: string, id: string) => void;
}

type ImmerCreator<S> = StateCreator<S, [["zustand/immer", never]], [], S>;
export type ResourceTreeSet<S> = Parameters<ImmerCreator<S>>[0];
export type ResourceTreeGet<S> = Parameters<ImmerCreator<S>>[1];

export function createResourceTreeStore<
  T extends ResourceTreeEntry,
  Extra extends object = Record<never, never>,
>(config: {
  /** Used in the fetch-error fallback message, e.g. "notebook". */
  resourceName: string;
  endpoints: ResourceTreeEndpoints<T>;
  /** Resource-specific state and actions layered on the shared slice. */
  extend?: (
    set: ResourceTreeSet<ResourceTreeState<T> & Extra>,
    get: ResourceTreeGet<ResourceTreeState<T> & Extra>,
    helpers: ResourceTreeHelpers<T>,
  ) => Extra;
}) {
  const { resourceName, endpoints, extend } = config;
  type State = ResourceTreeState<T> & Extra;
  type Sections = ResourceTreeSections<T>;

  const allSections = (state: Sections, wid: string): T[][] => [
    state.myItems[wid] || [],
    state.workspaceItems[wid] || [],
  ];

  const findInAnySection = (
    state: Sections,
    wid: string,
    id: string,
  ): T | null => {
    for (const section of allSections(state, wid)) {
      const found = findById(section, id);
      if (found) return found;
    }
    return null;
  };

  const removeFromAnySection = (
    state: Sections,
    wid: string,
    id: string,
  ): T | null => {
    for (const section of allSections(state, wid)) {
      const removed = removeById(section, id);
      if (removed) return removed;
    }
    return null;
  };

  const insertIntoFolder = (
    state: Sections,
    wid: string,
    entry: T,
    targetFolderId: string | null,
    targetSection: TreeSection,
    placement: "alphabetical" | "top" = "alphabetical",
  ): void => {
    const sectionKey = targetSection === "my" ? "myItems" : "workspaceItems";
    const sectionArr = state[sectionKey][wid] || [];
    state[sectionKey][wid] = sectionArr;
    const insert = placement === "top" ? insertAtTop : insertAlphabetically;
    if (targetFolderId) {
      const folder = findById(sectionArr, targetFolderId);
      if (folder && folder.isDirectory) {
        if (!folder.children) folder.children = [];
        insert(folder.children as T[], entry);
        return;
      }
    }
    insert(sectionArr, entry);
  };

  const sectionOfFolder = (
    state: Sections,
    wid: string,
    folderId: string,
  ): TreeSection =>
    findById(state.workspaceItems[wid] || [], folderId) ? "workspace" : "my";

  const targetSectionFor = (
    state: Sections,
    wid: string,
    access: TreeAccessLevel | undefined,
    folderId: string | null | undefined,
  ): TreeSection => {
    if (access === "workspace") return "workspace";
    if (access === "private") return "my";
    if (folderId) return sectionOfFolder(state, wid, folderId);
    return "my";
  };

  const resortIn = (state: Sections, wid: string, itemId: string): void => {
    for (const section of allSections(state, wid)) {
      const parent = findParentArray(section, itemId);
      if (parent) {
        const idx = parent.findIndex(n => n.id === itemId);
        if (idx !== -1) {
          const [removed] = parent.splice(idx, 1);
          insertAlphabetically(parent, removed);
        }
        break;
      }
    }
  };

  const helpers: ResourceTreeHelpers<T> = {
    allSections,
    findInAnySection,
    removeFromAnySection,
    insertIntoFolder,
    sectionOfFolder,
    resortIn,
  };

  // Realtime events, focus handlers and explorer mounts can all request the
  // same tree in one tick. One workspace needs one fetch; every caller can
  // await the shared result.
  const fetchInFlight = new Map<string, Promise<void>>();

  return create<State>()(
    immer((set, get) => ({
      myItems: {},
      workspaceItems: {},
      loading: {},
      error: {},

      fetchTree: workspaceId => {
        const pending = fetchInFlight.get(workspaceId);
        if (pending) return pending;

        const run = (async () => {
          set(state => {
            state.loading[workspaceId] = true;
            state.error[workspaceId] = null;
          });
          try {
            const data = await endpoints.fetch(workspaceId);
            set(state => {
              state.myItems[workspaceId] = data.my as never;
              state.workspaceItems[workspaceId] = data.workspace as never;
            });
          } catch (err: unknown) {
            set(state => {
              state.error[workspaceId] = toErrorMessage(
                err,
                `Failed to fetch ${resourceName} tree`,
              );
            });
          } finally {
            set(state => {
              delete state.loading[workspaceId];
            });
          }
        })().finally(() => {
          if (fetchInFlight.get(workspaceId) === run) {
            fetchInFlight.delete(workspaceId);
          }
        });
        fetchInFlight.set(workspaceId, run);
        return run;
      },

      refresh: async workspaceId => {
        await get().fetchTree(workspaceId);
      },

      moveItem: async (workspaceId, itemId, targetFolderId, access) => {
        set(state => {
          const entry = removeFromAnySection(
            state as Sections,
            workspaceId,
            itemId,
          );
          if (!entry) return;
          if (access) entry.access = access;
          insertIntoFolder(
            state as Sections,
            workspaceId,
            entry,
            targetFolderId,
            targetSectionFor(
              state as Sections,
              workspaceId,
              access,
              targetFolderId,
            ),
          );
        });
        try {
          await endpoints.moveItem(workspaceId, itemId, targetFolderId, access);
          return true;
        } catch {
          await get().refresh(workspaceId);
          return false;
        }
      },

      moveFolder: async (workspaceId, folderId, parentId, access) => {
        set(state => {
          const entry = removeFromAnySection(
            state as Sections,
            workspaceId,
            folderId,
          );
          if (!entry) return;
          if (access) entry.access = access;
          insertIntoFolder(
            state as Sections,
            workspaceId,
            entry,
            parentId,
            targetSectionFor(state as Sections, workspaceId, access, parentId),
          );
        });
        try {
          await endpoints.moveFolder(workspaceId, folderId, parentId, access);
          return true;
        } catch {
          await get().refresh(workspaceId);
          return false;
        }
      },

      createFolder: async (workspaceId, name, parentId, access) => {
        // No explicit access: a folder created inside another one lives in
        // that folder's section, so it inherits that section's access.
        const parentSection: TreeSection = parentId
          ? sectionOfFolder(get(), workspaceId, parentId)
          : "my";
        const resolvedAccess: TreeAccessLevel =
          access ?? (parentSection === "workspace" ? "workspace" : "private");
        const targetSection: TreeSection =
          resolvedAccess === "workspace" ? "workspace" : parentSection;
        const tempId = `temp-${Date.now()}`;
        const tempEntry = {
          id: tempId,
          name,
          path: name,
          isDirectory: true,
          children: [],
          access: resolvedAccess,
        } as unknown as T;
        set(state => {
          insertIntoFolder(
            state as Sections,
            workspaceId,
            tempEntry,
            parentId || null,
            targetSection,
            "top",
          );
        });
        try {
          const created = await endpoints.createFolder(
            workspaceId,
            name,
            parentId,
            resolvedAccess,
          );
          const realId = created?.id;
          if (!realId) throw new Error("Folder was not created");
          set(state => {
            const node = findInAnySection(
              state as Sections,
              workspaceId,
              tempId,
            );
            if (node) node.id = realId;
          });
          return realId;
        } catch {
          await get().refresh(workspaceId);
          return null;
        }
      },

      renameItem: async (workspaceId, itemId, name, isDirectory) => {
        set(state => {
          const node = findInAnySection(state as Sections, workspaceId, itemId);
          if (!node) return;
          node.name = name;
          resortIn(state as Sections, workspaceId, itemId);
        });
        try {
          await (isDirectory
            ? endpoints.renameFolder(workspaceId, itemId, name)
            : endpoints.renameItem(workspaceId, itemId, name));
          return true;
        } catch {
          await get().refresh(workspaceId);
          return false;
        }
      },

      deleteItem: async (workspaceId, itemId, isDirectory) => {
        set(state => {
          removeFromAnySection(state as Sections, workspaceId, itemId);
        });
        try {
          await (isDirectory
            ? endpoints.deleteFolder(workspaceId, itemId)
            : endpoints.deleteItem(workspaceId, itemId));
          return true;
        } catch {
          await get().refresh(workspaceId);
          return false;
        }
      },

      resortItem: (workspaceId, itemId) => {
        set(state => {
          resortIn(state as Sections, workspaceId, itemId);
        });
      },

      ...(extend ? extend(set, get, helpers) : ({} as Extra)),
    })),
  );
}
