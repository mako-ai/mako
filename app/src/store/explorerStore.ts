/**
 * Explorer Store
 *
 * Manages expanded/collapsed state for all explorer panels:
 * - Database explorer (servers, databases, collections, views, nodes)
 * - Console explorer (folders)
 * - View explorer (collections)
 *
 * Uses Set<string> internally for O(1) lookups, serializes to arrays for persistence.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

interface ExplorerState {
  // Database explorer
  database: {
    expandedServers: Set<string>;
    expandedDatabases: Set<string>;
    expandedCollectionGroups: Set<string>;
    expandedViewGroups: Set<string>;
    expandedNodes: Set<string>;
  };

  // Console explorer
  console: {
    expandedFolders: Set<string>;
  };

  // Dashboard explorer
  dashboard: {
    expandedFolders: Set<string>;
  };

  // View explorer
  view: {
    expandedCollections: Set<string>;
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

  // Helper methods for database explorer
  isServerExpanded: (serverId: string) => boolean;
  isDatabaseExpanded: (databaseId: string) => boolean;
  isCollectionGroupExpanded: (databaseId: string) => boolean;
  isViewGroupExpanded: (databaseId: string) => boolean;
  isNodeExpanded: (nodeId: string) => boolean;

  // Console explorer
  toggleFolder: (folderPath: string) => void;
  expandFolder: (folderPath: string) => void;
  isFolderExpanded: (folderPath: string) => boolean;

  // Dashboard explorer
  toggleDashboardFolder: (folderPath: string) => void;
  expandDashboardFolder: (folderPath: string) => void;
  isDashboardFolderExpanded: (folderPath: string) => boolean;

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
    expandedServers: new Set(),
    expandedDatabases: new Set(),
    expandedCollectionGroups: new Set(),
    expandedViewGroups: new Set(),
    expandedNodes: new Set(),
  },
  console: {
    expandedFolders: new Set(),
  },
  dashboard: {
    expandedFolders: new Set(),
  },
  view: {
    expandedCollections: new Set(),
  },
});

// Helper to toggle a value in a Set
const toggleInSet = (set: Set<string>, value: string): void => {
  if (set.has(value)) {
    set.delete(value);
  } else {
    set.add(value);
  }
};

export const useExplorerStore = create<ExplorerStore>()(
  persist(
    immer((set, get) => ({
      ...createInitialState(),

      // Database explorer actions
      toggleServer: serverId =>
        set(state => {
          toggleInSet(state.database.expandedServers, serverId);
        }),

      toggleDatabase: databaseId =>
        set(state => {
          toggleInSet(state.database.expandedDatabases, databaseId);
        }),

      toggleCollectionGroup: databaseId =>
        set(state => {
          toggleInSet(state.database.expandedCollectionGroups, databaseId);
        }),

      toggleViewGroup: databaseId =>
        set(state => {
          toggleInSet(state.database.expandedViewGroups, databaseId);
        }),

      toggleNode: nodeId =>
        set(state => {
          toggleInSet(state.database.expandedNodes, nodeId);
        }),

      expandServer: serverId =>
        set(state => {
          state.database.expandedServers.add(serverId);
        }),

      expandDatabase: databaseId =>
        set(state => {
          state.database.expandedDatabases.add(databaseId);
        }),

      // Database explorer helpers
      isServerExpanded: serverId =>
        get().database.expandedServers.has(serverId),
      isDatabaseExpanded: databaseId =>
        get().database.expandedDatabases.has(databaseId),
      isCollectionGroupExpanded: databaseId =>
        get().database.expandedCollectionGroups.has(databaseId),
      isViewGroupExpanded: databaseId =>
        get().database.expandedViewGroups.has(databaseId),
      isNodeExpanded: nodeId => get().database.expandedNodes.has(nodeId),

      // Console explorer actions
      toggleFolder: folderPath =>
        set(state => {
          toggleInSet(state.console.expandedFolders, folderPath);
        }),

      expandFolder: folderPath =>
        set(state => {
          state.console.expandedFolders.add(folderPath);
        }),

      isFolderExpanded: folderPath =>
        get().console.expandedFolders.has(folderPath),

      // Dashboard explorer actions
      toggleDashboardFolder: folderPath =>
        set(state => {
          toggleInSet(state.dashboard.expandedFolders, folderPath);
        }),

      expandDashboardFolder: folderPath =>
        set(state => {
          state.dashboard.expandedFolders.add(folderPath);
        }),

      isDashboardFolderExpanded: folderPath =>
        get().dashboard.expandedFolders.has(folderPath),

      // View explorer actions
      toggleCollection: collectionName =>
        set(state => {
          toggleInSet(state.view.expandedCollections, collectionName);
        }),

      expandCollection: collectionName =>
        set(state => {
          state.view.expandedCollections.add(collectionName);
        }),

      isCollectionExpanded: collectionName =>
        get().view.expandedCollections.has(collectionName),

      // Reset
      reset: () => set(createInitialState()),
    })),
    {
      name: "explorer-store",
      // Custom serialization for Sets
      storage: {
        getItem: name => {
          const str = localStorage.getItem(name);
          if (!str) return null;

          const data = JSON.parse(str);
          // Convert arrays back to Sets
          if (data.state?.database) {
            data.state.database.expandedServers = new Set(
              data.state.database.expandedServers || [],
            );
            data.state.database.expandedDatabases = new Set(
              data.state.database.expandedDatabases || [],
            );
            data.state.database.expandedCollectionGroups = new Set(
              data.state.database.expandedCollectionGroups || [],
            );
            data.state.database.expandedViewGroups = new Set(
              data.state.database.expandedViewGroups || [],
            );
            data.state.database.expandedNodes = new Set(
              data.state.database.expandedNodes || [],
            );
          }
          if (data.state?.console) {
            data.state.console.expandedFolders = new Set(
              data.state.console.expandedFolders || [],
            );
          }
          if (data.state?.dashboard) {
            data.state.dashboard.expandedFolders = new Set(
              data.state.dashboard.expandedFolders || [],
            );
          } else {
            data.state.dashboard = { expandedFolders: new Set() };
          }
          if (data.state?.view) {
            data.state.view.expandedCollections = new Set(
              data.state.view.expandedCollections || [],
            );
          }
          return data;
        },
        setItem: (name, value) => {
          // Convert Sets to arrays for JSON serialization
          const serialized = {
            ...value,
            state: {
              database: {
                expandedServers: Array.from(
                  value.state.database.expandedServers || [],
                ),
                expandedDatabases: Array.from(
                  value.state.database.expandedDatabases || [],
                ),
                expandedCollectionGroups: Array.from(
                  value.state.database.expandedCollectionGroups || [],
                ),
                expandedViewGroups: Array.from(
                  value.state.database.expandedViewGroups || [],
                ),
                expandedNodes: Array.from(
                  value.state.database.expandedNodes || [],
                ),
              },
              console: {
                expandedFolders: Array.from(
                  value.state.console.expandedFolders || [],
                ),
              },
              dashboard: {
                expandedFolders: Array.from(
                  value.state.dashboard?.expandedFolders || [],
                ),
              },
              view: {
                expandedCollections: Array.from(
                  value.state.view.expandedCollections || [],
                ),
              },
            },
          };
          localStorage.setItem(name, JSON.stringify(serialized));
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
    // Expose Sets directly for components expecting the old interface
    expandedServers: store.database.expandedServers,
    expandedDatabases: store.database.expandedDatabases,
    expandedCollectionGroups: store.database.expandedCollectionGroups,
    expandedViewGroups: store.database.expandedViewGroups,
    expandedNodes: store.database.expandedNodes,

    // Actions
    toggleServer: store.toggleServer,
    toggleDatabase: store.toggleDatabase,
    toggleCollectionGroup: store.toggleCollectionGroup,
    toggleViewGroup: store.toggleViewGroup,
    toggleNode: store.toggleNode,
    expandServer: store.expandServer,
    expandDatabase: store.expandDatabase,

    // Helpers
    isServerExpanded: store.isServerExpanded,
    isDatabaseExpanded: store.isDatabaseExpanded,
    isCollectionGroupExpanded: store.isCollectionGroupExpanded,
    isViewGroupExpanded: store.isViewGroupExpanded,
    isNodeExpanded: store.isNodeExpanded,
  };
};
