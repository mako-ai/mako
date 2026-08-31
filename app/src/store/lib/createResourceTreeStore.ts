/**
 * ONE tree store for every foldered resource (notebooks, dashboards, …).
 *
 * The two-section tree ("My X" / "Workspace X"), the optimistic move /
 * rename / create-folder / delete with refresh-on-failure, the per-workspace
 * loading and error flags — all of it was copied per resource:
 * notebookTreeStore and dashboardTreeStore differed by 29 lines out of 400
 * once the noun was renamed, and consoleTreeStore forked to grow a third
 * section and then drifted 600 lines. A resource now supplies only its
 * entry type and its endpoints; the mechanics live here once.
 */
import { create } from "zustand";
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

/** What a resource must know how to do; the store never builds a URL. */
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
  moveItem: (
    workspaceId: string,
    itemId: string,
    targetFolderId: string | null,
    access?: TreeAccessLevel,
  ) => Promise<void>;
  moveFolder: (
    workspaceId: string,
    folderId: string,
    parentId: string | null,
    access?: TreeAccessLevel,
  ) => Promise<void>;
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
  ) => Promise<void>;
  deleteItem: (
    workspaceId: string,
    itemId: string,
    isDirectory: boolean,
  ) => Promise<void>;
  resortItem: (workspaceId: string, itemId: string) => void;
}

export function createResourceTreeStore<T extends ResourceTreeEntry>(config: {
  /** Used in the fetch-error fallback message, e.g. "notebook". */
  resourceName: string;
  endpoints: ResourceTreeEndpoints<T>;
}) {
  const { resourceName, endpoints } = config;
  type State = ResourceTreeState<T>;

  const allSections = (state: State, wid: string): T[][] => [
    state.myItems[wid] || [],
    state.workspaceItems[wid] || [],
  ];

  const removeFromAnySection = (
    state: State,
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
    state: State,
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
    state: State,
    wid: string,
    folderId: string,
  ): TreeSection =>
    findById(state.workspaceItems[wid] || [], folderId) ? "workspace" : "my";

  const targetSectionFor = (
    state: State,
    wid: string,
    access: TreeAccessLevel | undefined,
    folderId: string | null | undefined,
  ): TreeSection => {
    if (access === "workspace") return "workspace";
    if (access === "private") return "my";
    if (folderId) return sectionOfFolder(state, wid, folderId);
    return "my";
  };

  const resortIn = (state: State, wid: string, itemId: string): void => {
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

  return create<State>()(
    immer((set, get) => ({
      myItems: {},
      workspaceItems: {},
      loading: {},
      error: {},

      fetchTree: async workspaceId => {
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
      },

      refresh: async workspaceId => {
        await get().fetchTree(workspaceId);
      },

      moveItem: async (workspaceId, itemId, targetFolderId, access) => {
        set(state => {
          const entry = removeFromAnySection(
            state as State,
            workspaceId,
            itemId,
          );
          if (!entry) return;
          if (access) entry.access = access;
          insertIntoFolder(
            state as State,
            workspaceId,
            entry,
            targetFolderId,
            targetSectionFor(
              state as State,
              workspaceId,
              access,
              targetFolderId,
            ),
          );
        });
        try {
          await endpoints.moveItem(workspaceId, itemId, targetFolderId, access);
        } catch {
          await get().refresh(workspaceId);
        }
      },

      moveFolder: async (workspaceId, folderId, parentId, access) => {
        set(state => {
          const entry = removeFromAnySection(
            state as State,
            workspaceId,
            folderId,
          );
          if (!entry) return;
          if (access) entry.access = access;
          insertIntoFolder(
            state as State,
            workspaceId,
            entry,
            parentId,
            targetSectionFor(state as State, workspaceId, access, parentId),
          );
        });
        try {
          await endpoints.moveFolder(workspaceId, folderId, parentId, access);
        } catch {
          await get().refresh(workspaceId);
        }
      },

      createFolder: async (workspaceId, name, parentId, access) => {
        const resolvedAccess = access || "private";
        const tempId = `temp-${Date.now()}`;
        const tempEntry = {
          id: tempId,
          name,
          path: name,
          isDirectory: true,
          children: [],
          access: resolvedAccess,
        } as unknown as T;
        const targetSection: TreeSection =
          resolvedAccess === "workspace"
            ? "workspace"
            : parentId
              ? sectionOfFolder(get(), workspaceId, parentId)
              : "my";
        set(state => {
          insertIntoFolder(
            state as State,
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
          if (!realId) return null;
          set(state => {
            for (const section of allSections(state as State, workspaceId)) {
              const node = findById(section, tempId);
              if (node) {
                node.id = realId;
                break;
              }
            }
          });
          return realId;
        } catch {
          await get().refresh(workspaceId);
          return null;
        }
      },

      renameItem: async (workspaceId, itemId, name, isDirectory) => {
        set(state => {
          for (const section of allSections(state as State, workspaceId)) {
            const node = findById(section, itemId);
            if (node) {
              node.name = name;
              resortIn(state as State, workspaceId, itemId);
              break;
            }
          }
        });
        try {
          await (isDirectory
            ? endpoints.renameFolder(workspaceId, itemId, name)
            : endpoints.renameItem(workspaceId, itemId, name));
        } catch {
          await get().refresh(workspaceId);
        }
      },

      deleteItem: async (workspaceId, itemId, isDirectory) => {
        set(state => {
          removeFromAnySection(state as State, workspaceId, itemId);
        });
        try {
          await (isDirectory
            ? endpoints.deleteFolder(workspaceId, itemId)
            : endpoints.deleteItem(workspaceId, itemId));
        } catch {
          await get().refresh(workspaceId);
        }
      },

      resortItem: (workspaceId, itemId) => {
        set(state => {
          resortIn(state as State, workspaceId, itemId);
        });
      },
    })),
  );
}
