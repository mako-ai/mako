import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";
import { generateObjectId } from "../utils/objectId";
import { ConsoleVersionManager } from "../utils/ConsoleVersionManager";
import { computeConsoleStateHash } from "../utils/stateHash";
import type { ConsoleTab, TabKind } from "./lib/types";
import type {
  ConsoleContentResponse,
  ConsoleDeleteResponse,
  ConsoleSaveResponse,
  QueryCancelResponse,
  QueryExecuteResponse,
} from "../lib/api-types";

interface ConsoleState {
  tabs: Record<string, ConsoleTab>;
  activeTabId: string | null;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
}

interface ConsoleActions {
  // Tab management
  openTab: (tab: Omit<ConsoleTab, "id"> & { id?: string }) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;
  clearAllConsoles: () => void;

  // Tab updates
  updateContent: (id: string, content: string) => void;
  updateTitle: (id: string, title: string) => void;
  updateDirty: (id: string, isDirty: boolean) => void;
  updateIcon: (id: string, icon: string) => void;
  updateConnection: (id: string, connectionId?: string) => void;
  updateDatabase: (
    id: string,
    databaseId?: string,
    databaseName?: string,
  ) => void;
  updateFilePath: (id: string, filePath: string) => void;
  updateSavedState: (
    id: string,
    isSaved: boolean,
    savedStateHash: string,
  ) => void;

  // Versioning
  getVersionManager: (consoleId: string) => ConsoleVersionManager | null;

  // API operations
  loadConsole: (workspaceId: string, consoleId: string) => Promise<void>;
  fetchConsoleContent: (
    workspaceId: string,
    consoleId: string,
  ) => Promise<ConsoleContentResponse | null>;
  saveConsole: (
    workspaceId: string,
    tabId: string,
    content: string,
    path: string,
    connectionId?: string,
    databaseName?: string,
    databaseId?: string,
  ) => Promise<ConsoleSaveResponse>;
  deleteConsole: (
    workspaceId: string,
    consoleId: string,
  ) => Promise<ConsoleDeleteResponse>;
  executeQuery: (
    workspaceId: string,
    connectionId: string,
    query: string,
    options?: {
      databaseName?: string;
      databaseId?: string;
      executionId?: string;
      signal?: AbortSignal;
    },
  ) => Promise<QueryExecuteResponse>;
  cancelQuery: (
    workspaceId: string,
    executionId: string,
  ) => Promise<QueryCancelResponse>;
  autoSaveConsole: (
    workspaceId: string,
    consoleId: string,
    content: string,
    title?: string,
    connectionId?: string,
    databaseId?: string,
    databaseName?: string,
  ) => void;
}

type ConsoleStore = ConsoleState & ConsoleActions;

const initialState: ConsoleState = {
  tabs: {},
  activeTabId: null,
  loading: {},
  error: {},
};

// Store version managers for each console tab
const versionManagers = new Map<string, ConsoleVersionManager>();

// Debounce timers for draft console saves (per console ID)
const draftSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Track last saved content hash to avoid redundant API calls
const lastSavedContentHash = new Map<string, string>();
const DRAFT_SAVE_DEBOUNCE_MS = 2000; // 2 seconds debounce

const cancelAutoSave = (consoleId: string): void => {
  const timer = draftSaveTimers.get(consoleId);
  if (timer) {
    clearTimeout(timer);
    draftSaveTimers.delete(consoleId);
  }
  lastSavedContentHash.delete(consoleId);
};

const shouldAutoSave = (getState: () => ConsoleState, consoleId: string) => {
  const tab = getState().tabs[consoleId];
  return tab ? !tab.isSaved : true;
};

export const useConsoleStore = create<ConsoleStore>()(
  persist(
    immer((set, get) => ({
      ...initialState,

      // Tab management
      openTab: tab => {
        const id = tab.id || generateObjectId();
        const content = tab.content || "";

        // Replace first pristine tab if present
        const pristineTabId = Object.keys(get().tabs).find(
          tabId => !get().tabs[tabId].isDirty,
        );

        if (tab.kind === undefined || tab.kind === "console") {
          versionManagers.set(id, new ConsoleVersionManager(id));
        }

        const savedStateHash = tab.filePath
          ? computeConsoleStateHash(
              content,
              tab.connectionId,
              tab.databaseId,
              tab.databaseName,
            )
          : tab.savedStateHash;

        set(state => {
          if (pristineTabId && pristineTabId !== id) {
            delete state.tabs[pristineTabId];
          }
          state.tabs[id] = {
            ...tab,
            id,
            content,
            isSaved: tab.isSaved ?? !!tab.filePath,
            savedStateHash,
            kind: tab.kind || "console",
            isDirty: tab.isDirty ?? false,
          };
          state.activeTabId = id;
        });

        return id;
      },

      closeTab: id => {
        const versionManager = versionManagers.get(id);
        if (versionManager) {
          versionManager.cleanup();
          versionManagers.delete(id);
        }

        cancelAutoSave(id);

        set(state => {
          delete state.tabs[id];
          if (state.activeTabId === id) {
            state.activeTabId = Object.keys(state.tabs)[0] || null;
          }
        });
      },

      setActiveTab: id =>
        set(state => {
          state.activeTabId = id;
        }),

      clearAllConsoles: () => {
        Object.keys(get().tabs).forEach(tabId => get().closeTab(tabId));
      },

      // Tab updates
      updateContent: (id, content) =>
        set(state => {
          const tab = state.tabs[id];
          if (tab) {
            tab.content = content;
          }
        }),

      updateTitle: (id, title) =>
        set(state => {
          const tab = state.tabs[id];
          if (tab) {
            tab.title = title;
          }
        }),

      updateDirty: (id, isDirty) =>
        set(state => {
          const tab = state.tabs[id];
          if (tab) {
            tab.isDirty = isDirty;
          }
        }),

      updateIcon: (id, icon) =>
        set(state => {
          const tab = state.tabs[id];
          if (tab) {
            tab.icon = icon;
          }
        }),

      updateConnection: (id, connectionId) =>
        set(state => {
          const tab = state.tabs[id];
          if (tab) {
            tab.connectionId = connectionId;
          }
        }),

      updateDatabase: (id, databaseId, databaseName) =>
        set(state => {
          const tab = state.tabs[id];
          if (tab) {
            tab.databaseId = databaseId;
            tab.databaseName = databaseName;
          }
        }),

      updateFilePath: (id, filePath) =>
        set(state => {
          const tab = state.tabs[id];
          if (tab) {
            tab.filePath = filePath;
          }
        }),

      updateSavedState: (id, isSaved, savedStateHash) =>
        set(state => {
          const tab = state.tabs[id];
          if (tab) {
            tab.isSaved = isSaved;
            tab.savedStateHash = savedStateHash;
          }
        }),

      // Versioning
      getVersionManager: consoleId => versionManagers.get(consoleId) || null,

      // API operations
      loadConsole: async (workspaceId, consoleId) => {
        // Check if console is already loaded
        if (get().tabs[consoleId]) {
          get().setActiveTab(consoleId);
          return;
        }

        set(state => {
          state.loading[consoleId] = true;
          state.error[consoleId] = null;
        });

        try {
          const res = await apiClient.get<ConsoleContentResponse>(
            `/workspaces/${workspaceId}/consoles/content`,
            { id: consoleId },
          );

          if (res.success) {
            const content = res.content || "";
            const filePath = res.path || res.name;

            get().openTab({
              id: res.id,
              title: res.name || res.path || "Console",
              content,
              isSaved: res.isSaved ?? !!filePath,
              connectionId: res.connectionId,
              databaseId: res.databaseId,
              databaseName: res.databaseName,
              filePath,
              kind: "console",
            });
            get().setActiveTab(res.id);
          } else {
            set(state => {
              state.error[consoleId] = "Failed to load console";
            });
          }
        } catch (e) {
          console.error("Failed to load console", e);
          set(state => {
            state.error[consoleId] =
              e instanceof Error ? e.message : "Failed to load console";
          });
        } finally {
          set(state => {
            delete state.loading[consoleId];
          });
        }
      },

      fetchConsoleContent: async (workspaceId, consoleId) => {
        try {
          const res = await apiClient.get<ConsoleContentResponse>(
            `/workspaces/${workspaceId}/consoles/content`,
            { id: consoleId },
          );

          if (res.success) {
            const filePath = res.path || res.name;
            set(state => {
              const tab = state.tabs[consoleId];
              if (tab) {
                tab.content = res.content || "";
                tab.connectionId = res.connectionId;
                tab.databaseId = res.databaseId;
                tab.databaseName = res.databaseName;
                tab.filePath = filePath;
              }
            });

            if (filePath) {
              const savedStateHash = computeConsoleStateHash(
                res.content || "",
                res.connectionId,
                res.databaseId,
                res.databaseName,
              );
              get().updateSavedState(consoleId, true, savedStateHash);
            }
          }

          return res.success ? res : null;
        } catch (e) {
          console.error("Failed to fetch console content", e);
          return null;
        }
      },

      saveConsole: async (
        workspaceId,
        tabId,
        content,
        path,
        connectionId,
        databaseName,
        databaseId,
      ) => {
        try {
          const cleanPath = path.endsWith(".js") ? path.slice(0, -3) : path;
          const response = await fetch(
            `/api/workspaces/${workspaceId}/consoles/${tabId}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                content,
                path: cleanPath,
                connectionId,
                databaseName,
                databaseId,
                isSaved: true,
              }),
            },
          );

          const res = (await response.json()) as ConsoleSaveResponse;

          if (response.status === 409 && res.error === "conflict") {
            return {
              success: false,
              error: "conflict",
              conflict: res.conflict,
            };
          }

          if (!response.ok) {
            return { success: false, error: res.error || "Save failed" };
          }

          return res.success
            ? { success: true, path: cleanPath }
            : { success: false, error: res.error || "Save failed" };
        } catch (e) {
          return {
            success: false,
            error: e instanceof Error ? e.message : "Save failed",
          };
        }
      },

      deleteConsole: async (workspaceId, consoleId) => {
        try {
          return await apiClient.delete<ConsoleDeleteResponse>(
            `/workspaces/${workspaceId}/consoles/${consoleId}`,
          );
        } catch (e) {
          return {
            success: false,
            error: e instanceof Error ? e.message : "Delete failed",
          };
        }
      },

      executeQuery: async (workspaceId, connectionId, query, options) => {
        try {
          const res = await apiClient.post<QueryExecuteResponse>(
            `/workspaces/${workspaceId}/execute`,
            {
              connectionId,
              query,
              databaseId: options?.databaseId,
              databaseName: options?.databaseName,
              executionId: options?.executionId,
            },
            { signal: options?.signal },
          );

          return res.success
            ? res
            : { success: false, error: res.error || "Execution failed" };
        } catch (e) {
          if (e instanceof Error && e.name === "AbortError") {
            return { success: false, error: "Query cancelled" };
          }
          return {
            success: false,
            error: e instanceof Error ? e.message : "Execution failed",
          };
        }
      },

      cancelQuery: async (workspaceId, executionId) => {
        try {
          return await apiClient.post<QueryCancelResponse>(
            `/workspaces/${workspaceId}/execute/cancel`,
            { executionId },
          );
        } catch (e) {
          return {
            success: false,
            error: e instanceof Error ? e.message : "Cancel failed",
          };
        }
      },

      autoSaveConsole: (
        workspaceId,
        consoleId,
        content,
        title,
        connectionId,
        databaseId,
        databaseName,
      ) => {
        if (!content?.trim() || content === "loading...") return;
        if (!shouldAutoSave(get, consoleId)) return;

        const stateHash = computeConsoleStateHash(
          content,
          connectionId,
          databaseId,
          databaseName,
        );
        if (lastSavedContentHash.get(consoleId) === stateHash) {
          return;
        }

        const existingTimer = draftSaveTimers.get(consoleId);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(async () => {
          draftSaveTimers.delete(consoleId);
          if (!shouldAutoSave(get, consoleId)) return;

          try {
            await apiClient.put(
              `/workspaces/${workspaceId}/consoles/${consoleId}`,
              {
                content,
                title,
                connectionId,
                databaseId,
                databaseName,
              },
            );
            lastSavedContentHash.set(consoleId, stateHash);
          } catch (e) {
            console.debug("[AutoSave] Failed to save console:", e);
          }
        }, DRAFT_SAVE_DEBOUNCE_MS);

        draftSaveTimers.set(consoleId, timer);
      },
    })),
    {
      name: "console-store",
      partialize: state => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
      }),
      storage: {
        getItem: name => {
          const str = localStorage.getItem(name);
          if (str) {
            const data = JSON.parse(str);
            if (data.state?.tabs) {
              Object.values(data.state.tabs).forEach((tab: any) => {
                if (
                  tab.databaseId === undefined &&
                  tab.metadata?.queryOptions
                ) {
                  tab.databaseId =
                    tab.metadata.queryOptions.databaseId ||
                    tab.metadata.queryOptions.databaseName;
                }
                if (
                  tab.databaseName === undefined &&
                  tab.metadata?.queryOptions
                ) {
                  tab.databaseName = tab.metadata.queryOptions.databaseLabel;
                }
                if (tab.isSaved === undefined) {
                  tab.isSaved = !!tab.filePath;
                }
                if (tab.savedStateHash === undefined && tab.filePath) {
                  const savedContent = tab.initialContent ?? tab.content ?? "";
                  const savedConnId = tab.savedConnectionId ?? tab.connectionId;
                  const savedDbId = tab.savedDatabaseId ?? tab.databaseId;
                  const savedDbName = tab.savedDatabaseName ?? tab.databaseName;
                  tab.savedStateHash = computeConsoleStateHash(
                    savedContent,
                    savedConnId,
                    savedDbId,
                    savedDbName,
                  );
                }
                delete tab.initialContent;
                delete tab.dbContentHash;
                delete tab.savedConnectionId;
                delete tab.savedDatabaseId;
                delete tab.savedDatabaseName;
              });
            }
            return data;
          }

          // Migration: fallback to app-store data if present
          const legacy = localStorage.getItem("app-store");
          if (legacy) {
            try {
              const parsed = JSON.parse(legacy);
              const tabs = parsed.state?.consoles?.tabs || {};
              const activeTabId = parsed.state?.consoles?.activeTabId || null;

              Object.values(tabs).forEach((tab: any) => {
                if (
                  tab.databaseId === undefined &&
                  tab.metadata?.queryOptions
                ) {
                  tab.databaseId =
                    tab.metadata.queryOptions.databaseId ||
                    tab.metadata.queryOptions.databaseName;
                }
                if (
                  tab.databaseName === undefined &&
                  tab.metadata?.queryOptions
                ) {
                  tab.databaseName = tab.metadata.queryOptions.databaseLabel;
                }
                if (tab.isSaved === undefined) {
                  tab.isSaved = !!tab.filePath;
                }
                if (tab.savedStateHash === undefined && tab.filePath) {
                  const savedContent = tab.initialContent ?? tab.content ?? "";
                  const savedConnId = tab.savedConnectionId ?? tab.connectionId;
                  const savedDbId = tab.savedDatabaseId ?? tab.databaseId;
                  const savedDbName = tab.savedDatabaseName ?? tab.databaseName;
                  tab.savedStateHash = computeConsoleStateHash(
                    savedContent,
                    savedConnId,
                    savedDbId,
                    savedDbName,
                  );
                }
                delete tab.initialContent;
                delete tab.dbContentHash;
                delete tab.savedConnectionId;
                delete tab.savedDatabaseId;
                delete tab.savedDatabaseName;
              });

              return {
                state: {
                  tabs,
                  activeTabId,
                  loading: {},
                  error: {},
                },
                version: 0,
              };
            } catch (error) {
              console.error("Failed to parse legacy console store:", error);
            }
          }

          return null;
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

// Selectors
export const selectConsoleTabs = (state: ConsoleStore): ConsoleTab[] =>
  Object.values(state.tabs);
export const selectActiveConsoleId = (state: ConsoleStore) => state.activeTabId;
export const selectConsoleById =
  (id: string) =>
  (state: ConsoleStore): ConsoleTab | undefined =>
    state.tabs[id];
export const selectTabByKind =
  (kind: TabKind) =>
  (state: ConsoleStore): ConsoleTab | undefined =>
    Object.values(state.tabs).find(tab => tab.kind === kind);
