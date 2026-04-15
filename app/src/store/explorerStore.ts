/**
 * Explorer Store
 *
 * Manages expanded/collapsed state for all explorer panels:
 * - Database explorer (servers, databases, collections, views, nodes)
 * - Console explorer (folders)
 * - Dashboard explorer (folders)
 * - View explorer (collections)
 *
 * Uses Record<string, true> for O(1) lookups.
 * Previous versions used Set<string> which is unreliable inside immer drafts.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

type ExpandedMap = Record<string, true>;

interface ExplorerState {
  database: {
    expandedServers: ExpandedMap;
    expandedDatabases: ExpandedMap;
    expandedCollectionGroups: ExpandedMap;
    expandedViewGroups: ExpandedMap;
    expandedNodes: ExpandedMap;
  };

  console: {
    expandedFolders: ExpandedMap;
  };

  dashboard: {
    expandedFolders: ExpandedMap;
  };

  view: {
    expandedCollections: ExpandedMap;
  };
}

interface ExplorerActions {
  // Database explorer
  toggleServer: (serverId: string) => void;
  toggleDatabase: (databaseId: string) => void;
  toggleCollectionGroup: (databaseId: string) => void;
  toggleViewGroup: (databaseId: string) => void;
  toggleNode: (nodeId: string) => void;
  expandServer: (serverId: string) => void;
  expandDatabase: (databaseId: string) => void;

  isServerExpanded: (serverId: string) => boolean;
  isDatabaseExpanded: (databaseId: string) => boolean;
  isCollectionGroupExpanded: (databaseId: string) => boolean;
  isViewGroupExpanded: (databaseId: string) => boolean;
  isNodeExpanded: (nodeId: string) => boolean;

  // Console explorer
  toggleFolder: (folderKey: string) => void;
  expandFolder: (folderKey: string) => void;
  isFolderExpanded: (folderKey: string) => boolean;

  // Dashboard explorer
  toggleDashboardFolder: (folderKey: string) => void;
  expandDashboardFolder: (folderKey: string) => void;
  isDashboardFolderExpanded: (folderKey: string) => boolean;

  // View explorer
  toggleCollection: (collectionName: string) => void;
  expandCollection: (collectionName: string) => void;
  isCollectionExpanded: (collectionName: string) => boolean;

  // Reset
  reset: () => void;
}

type ExplorerStore = ExplorerState & ExplorerActions;

const createInitialState = (): ExplorerState => ({
  database: {
    expandedServers: {},
    expandedDatabases: {},
    expandedCollectionGroups: {},
    expandedViewGroups: {},
    expandedNodes: {},
  },
  console: {
    expandedFolders: {},
  },
  dashboard: {
    expandedFolders: {},
  },
  view: {
    expandedCollections: {},
  },
});

const toggleKey = (map: ExpandedMap, key: string): void => {
  if (map[key]) {
    delete map[key];
  } else {
    map[key] = true;
  }
};

export const useExplorerStore = create<ExplorerStore>()(
  persist(
    immer((set, get) => ({
      ...createInitialState(),

      toggleServer: serverId =>
        set(state => {
          toggleKey(state.database.expandedServers, serverId);
        }),

      toggleDatabase: databaseId =>
        set(state => {
          toggleKey(state.database.expandedDatabases, databaseId);
        }),

      toggleCollectionGroup: databaseId =>
        set(state => {
          toggleKey(state.database.expandedCollectionGroups, databaseId);
        }),

      toggleViewGroup: databaseId =>
        set(state => {
          toggleKey(state.database.expandedViewGroups, databaseId);
        }),

      toggleNode: nodeId =>
        set(state => {
          toggleKey(state.database.expandedNodes, nodeId);
        }),

      expandServer: serverId =>
        set(state => {
          state.database.expandedServers[serverId] = true;
        }),

      expandDatabase: databaseId =>
        set(state => {
          state.database.expandedDatabases[databaseId] = true;
        }),

      isServerExpanded: serverId => !!get().database.expandedServers[serverId],
      isDatabaseExpanded: databaseId =>
        !!get().database.expandedDatabases[databaseId],
      isCollectionGroupExpanded: databaseId =>
        !!get().database.expandedCollectionGroups[databaseId],
      isViewGroupExpanded: databaseId =>
        !!get().database.expandedViewGroups[databaseId],
      isNodeExpanded: nodeId => !!get().database.expandedNodes[nodeId],

      toggleFolder: folderKey =>
        set(state => {
          toggleKey(state.console.expandedFolders, folderKey);
        }),

      expandFolder: folderKey =>
        set(state => {
          state.console.expandedFolders[folderKey] = true;
        }),

      isFolderExpanded: folderKey => !!get().console.expandedFolders[folderKey],

      toggleDashboardFolder: folderKey =>
        set(state => {
          toggleKey(state.dashboard.expandedFolders, folderKey);
        }),

      expandDashboardFolder: folderKey =>
        set(state => {
          state.dashboard.expandedFolders[folderKey] = true;
        }),

      isDashboardFolderExpanded: folderKey =>
        !!get().dashboard.expandedFolders[folderKey],

      toggleCollection: collectionName =>
        set(state => {
          toggleKey(state.view.expandedCollections, collectionName);
        }),

      expandCollection: collectionName =>
        set(state => {
          state.view.expandedCollections[collectionName] = true;
        }),

      isCollectionExpanded: collectionName =>
        !!get().view.expandedCollections[collectionName],

      reset: () => set(createInitialState()),
    })),
    {
      name: "explorer-store",
      storage: {
        getItem: name => {
          const str = localStorage.getItem(name);
          if (!str) return null;

          const data = JSON.parse(str);
          const s = data.state;

          // Migrate legacy Set-serialized arrays to Record<string, true>
          const migrateArray = (arr: unknown): ExpandedMap => {
            if (Array.isArray(arr)) {
              const map: ExpandedMap = {};
              for (const key of arr) {
                if (typeof key === "string") map[key] = true;
              }
              return map;
            }
            if (arr && typeof arr === "object" && !Array.isArray(arr)) {
              return arr as ExpandedMap;
            }
            return {};
          };

          if (s?.database) {
            s.database.expandedServers = migrateArray(
              s.database.expandedServers,
            );
            s.database.expandedDatabases = migrateArray(
              s.database.expandedDatabases,
            );
            s.database.expandedCollectionGroups = migrateArray(
              s.database.expandedCollectionGroups,
            );
            s.database.expandedViewGroups = migrateArray(
              s.database.expandedViewGroups,
            );
            s.database.expandedNodes = migrateArray(s.database.expandedNodes);
          }
          if (s?.console) {
            s.console.expandedFolders = migrateArray(s.console.expandedFolders);
          }
          if (s?.dashboard) {
            s.dashboard.expandedFolders = migrateArray(
              s.dashboard.expandedFolders,
            );
          } else {
            s.dashboard = { expandedFolders: {} };
          }
          if (s?.view) {
            s.view.expandedCollections = migrateArray(
              s.view.expandedCollections,
            );
          }
          return data;
        },
        setItem: (name, value) => {
          localStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: name => {
          localStorage.removeItem(name);
        },
      },
    },
  ),
);

// Re-export for backwards compatibility with useDatabaseExplorerStore
export const useDatabaseExplorerStore = () => {
  const store = useExplorerStore();

  return {
    expandedServers: store.database.expandedServers,
    expandedDatabases: store.database.expandedDatabases,
    expandedCollectionGroups: store.database.expandedCollectionGroups,
    expandedViewGroups: store.database.expandedViewGroups,
    expandedNodes: store.database.expandedNodes,

    toggleServer: store.toggleServer,
    toggleDatabase: store.toggleDatabase,
    toggleCollectionGroup: store.toggleCollectionGroup,
    toggleViewGroup: store.toggleViewGroup,
    toggleNode: store.toggleNode,
    expandServer: store.expandServer,
    expandDatabase: store.expandDatabase,

    isServerExpanded: store.isServerExpanded,
    isDatabaseExpanded: store.isDatabaseExpanded,
    isCollectionGroupExpanded: store.isCollectionGroupExpanded,
    isViewGroupExpanded: store.isViewGroupExpanded,
    isNodeExpanded: store.isNodeExpanded,
  };
};
