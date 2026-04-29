import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";
import { generateObjectId } from "../utils/objectId";
import { ConsoleVersionManager } from "../utils/ConsoleVersionManager";
import { computeConsoleStateHash } from "../utils/stateHash";
import type { ConsoleTab, SettingsSection, TabKind } from "./lib/types";
import type {
  ConsoleContentResponse,
  ConsoleDeleteResponse,
  ConsoleSaveResponse,
  QueryCancelResponse,
  QueryExecuteResponse,
  ScheduledQueryRunsResponse,
  ScheduledQueryScheduleResponse,
} from "../lib/api-types";

interface ConsoleState {
  tabs: Record<string, ConsoleTab>;
  /** Order in which tabs are displayed in the tab bar. Source of truth for the UI. */
  tabOrder: string[];
  activeTabId: string | null;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
}

interface ConsoleActions {
  // Tab management
  openTab: (
    tab: Omit<ConsoleTab, "id" | "isSaved"> & {
      id?: string;
      isSaved?: boolean;
    },
  ) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;
  clearAllConsoles: () => void;
  /** Reorder the tab bar by moving `fromId` to the position of `toId`. */
  reorderTabs: (fromId: string, toId: string) => void;

  // Tab updates
  updateContent: (id: string, content: string) => void;
  updateTitle: (id: string, title: string) => void;
  updateDirty: (id: string, isDirty: boolean) => void;
  updateMetadata: (id: string, metadata?: Record<string, unknown>) => void;
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
  updateChartSpec: (
    id: string,
    chartSpec: Record<string, unknown> | null,
  ) => void;
  updateResultsViewMode: (id: string, mode: "table" | "json" | "chart") => void;

  // Versioning
  getVersionManager: (consoleId: string) => ConsoleVersionManager | null;

  // API operations
  loadConsole: (
    workspaceId: string,
    consoleId: string,
    options?: { openScheduledRuns?: boolean },
  ) => Promise<void>;
  reloadConsole: (workspaceId: string, consoleId: string) => Promise<void>;
  fetchConsoleContent: (
    workspaceId: string,
    consoleId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ConsoleContentResponse | null>;
  saveConsole: (
    workspaceId: string,
    tabId: string,
    content: string,
    path: string,
    connectionId?: string,
    databaseName?: string,
    databaseId?: string,
    chartSpec?: Record<string, unknown>,
    resultsViewMode?: string,
    comment?: string,
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
      pageSize?: number;
      cursor?: string | null;
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
  generateVersionComment: (
    workspaceId: string,
    consoleId: string,
    versionId: string,
    payload: {
      previousContent: string;
      newContent: string;
      language: string;
      source: "user" | "ai";
      aiPrompt?: string;
      title?: string;
    },
  ) => void;
  generateSaveComment: (
    workspaceId: string,
    consoleId: string,
    payload: {
      newContent: string;
      source: "user" | "ai";
    },
    signal?: AbortSignal,
  ) => Promise<{ comment: string | null; diff: string | null }>;
  setSchedule: (
    workspaceId: string,
    consoleId: string,
    input: { name: string; cron: string; timezone: string },
  ) => Promise<ScheduledQueryScheduleResponse>;
  removeSchedule: (
    workspaceId: string,
    consoleId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  runScheduledNow: (
    workspaceId: string,
    consoleId: string,
  ) => Promise<ScheduledQueryScheduleResponse>;
  listScheduledRuns: (
    workspaceId: string,
    consoleId: string,
    limit?: number,
  ) => Promise<ScheduledQueryRunsResponse>;
}

type ConsoleStore = ConsoleState & ConsoleActions;

const initialState: ConsoleState = {
  tabs: {},
  tabOrder: [],
  activeTabId: null,
  loading: {},
  error: {},
};

// Store version managers for each console tab
const versionManagers = new Map<string, ConsoleVersionManager>();
const versionCommentControllers = new Map<string, AbortController>();
const versionCommentTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
            state.tabOrder = state.tabOrder.filter(t => t !== pristineTabId);
          }
          const isExisting = !!state.tabs[id];
          state.tabs[id] = {
            ...tab,
            id,
            content,
            isSaved: tab.isSaved ?? !!tab.filePath,
            savedStateHash,
            kind: tab.kind || "console",
            isDirty: tab.isDirty ?? false,
          };
          if (!isExisting && !state.tabOrder.includes(id)) {
            state.tabOrder.push(id);
          }
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
          const prevIndex = state.tabOrder.indexOf(id);
          state.tabOrder = state.tabOrder.filter(t => t !== id);
          if (state.activeTabId === id) {
            if (state.tabOrder.length === 0) {
              state.activeTabId = null;
            } else {
              // Prefer the tab that took this one's slot, else the previous one.
              const nextIndex = Math.min(
                Math.max(prevIndex, 0),
                state.tabOrder.length - 1,
              );
              state.activeTabId = state.tabOrder[nextIndex] ?? null;
            }
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

      reorderTabs: (fromId, toId) => {
        if (fromId === toId) return;
        set(state => {
          const fromIndex = state.tabOrder.indexOf(fromId);
          const toIndex = state.tabOrder.indexOf(toId);
          if (fromIndex < 0 || toIndex < 0) return;
          const [moved] = state.tabOrder.splice(fromIndex, 1);
          state.tabOrder.splice(toIndex, 0, moved);
        });
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

      updateMetadata: (id, metadata) =>
        set(state => {
          const tab = state.tabs[id];
          if (tab) {
            if (metadata && Object.keys(metadata).length > 0) {
              tab.metadata = metadata;
            } else {
              delete tab.metadata;
            }
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

      updateChartSpec: (id, chartSpec) =>
        set(state => {
          const tab = state.tabs[id];
          if (tab) {
            tab.chartSpec = chartSpec ?? undefined;
          }
        }),

      updateResultsViewMode: (id, mode) =>
        set(state => {
          const tab = state.tabs[id];
          if (tab) {
            tab.resultsViewMode = mode;
          }
        }),

      // Versioning
      getVersionManager: consoleId => versionManagers.get(consoleId) || null,

      // API operations
      loadConsole: async (workspaceId, consoleId, options) => {
        // Check if console is already loaded
        if (get().tabs[consoleId]) {
          if (options?.openScheduledRuns) {
            const existingMetadata = get().tabs[consoleId].metadata;
            get().updateMetadata(consoleId, {
              ...(existingMetadata || {}),
              openScheduledRuns: true,
            });
          }
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
              chartSpec: res.chartSpec,
              resultsViewMode: res.resultsViewMode,
              schedule: res.schedule,
              scheduledRun: res.scheduledRun,
              access: res.access,
              owner_id: res.owner_id,
              readOnly: res.readOnly,
              metadata: options?.openScheduledRuns
                ? { openScheduledRuns: true }
                : undefined,
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

      reloadConsole: async (workspaceId, consoleId) => {
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
              chartSpec: res.chartSpec,
              resultsViewMode: res.resultsViewMode,
            });
            get().setActiveTab(res.id);
          }
        } catch {
          // silent
        }
      },

      fetchConsoleContent: async (workspaceId, consoleId, options) => {
        try {
          const res = await apiClient.get<ConsoleContentResponse>(
            `/workspaces/${workspaceId}/consoles/content`,
            { id: consoleId },
            { signal: options?.signal },
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
                tab.access = res.access;
                tab.owner_id = res.owner_id;
                tab.readOnly = res.readOnly;
                tab.schedule = res.schedule;
                tab.scheduledRun = res.scheduledRun;
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
          if (e instanceof Error && e.name === "AbortError") {
            return null;
          }
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
        chartSpec,
        resultsViewMode,
        comment,
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
                chartSpec: chartSpec ?? null,
                resultsViewMode,
                comment: comment ?? "",
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

          if (res.success) {
            return { success: true, path: cleanPath };
          }
          return { success: false, error: res.error || "Save failed" };
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
              pageSize: options?.pageSize,
              cursor: options?.cursor,
              mode: "preview",
              source: "console_ui",
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

      generateVersionComment: (workspaceId, consoleId, versionId, payload) => {
        const DEBOUNCE_MS = 800;

        const existingTimer = versionCommentTimers.get(consoleId);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        const vm = versionManagers.get(consoleId);
        if (vm) {
          vm.updateVersion(versionId, { aiCommentStatus: "pending" });
        }

        const fire = async () => {
          versionCommentTimers.delete(consoleId);

          const prev = versionCommentControllers.get(consoleId);
          if (prev) prev.abort();

          const controller = new AbortController();
          versionCommentControllers.set(consoleId, controller);

          try {
            const res = await apiClient.post<{
              success: boolean;
              comment: string | null;
            }>(
              `/workspaces/${workspaceId}/consoles/${consoleId}/version-comment`,
              payload,
              { signal: controller.signal },
            );

            if (res.success && res.comment && vm) {
              vm.updateVersion(versionId, {
                aiComment: res.comment,
                aiCommentStatus: "done",
              });
            } else if (vm) {
              vm.updateVersion(versionId, { aiCommentStatus: "failed" });
            }
          } catch (_e) {
            if (vm) {
              vm.updateVersion(versionId, { aiCommentStatus: "failed" });
            }
          } finally {
            versionCommentControllers.delete(consoleId);
          }
        };

        if (payload.source === "ai") {
          void fire();
        } else {
          const timer = setTimeout(() => void fire(), DEBOUNCE_MS);
          versionCommentTimers.set(consoleId, timer);
        }
      },

      generateSaveComment: async (workspaceId, consoleId, payload, signal) => {
        try {
          const res = await apiClient.post<{
            success: boolean;
            comment: string | null;
            diff: string | null;
          }>(
            `/workspaces/${workspaceId}/consoles/${consoleId}/version-comment`,
            payload,
            { signal },
          );
          return res.success
            ? { comment: res.comment ?? null, diff: res.diff ?? null }
            : { comment: null, diff: null };
        } catch {
          return { comment: null, diff: null };
        }
      },

      setSchedule: async (workspaceId, consoleId, input) => {
        try {
          const response = await apiClient.put<ScheduledQueryScheduleResponse>(
            `/workspaces/${workspaceId}/consoles/${consoleId}/schedule`,
            input,
          );

          if (response.success) {
            set(state => {
              const tab = state.tabs[consoleId];
              if (tab) {
                tab.title = response.console?.name || input.name;
                tab.schedule = response.schedule;
                tab.scheduledRun = response.scheduledRun;
              }
            });
          }

          return response;
        } catch (e) {
          return {
            success: false,
            error: e instanceof Error ? e.message : "Failed to update schedule",
          } as ScheduledQueryScheduleResponse;
        }
      },

      removeSchedule: async (workspaceId, consoleId) => {
        try {
          const response = await apiClient.delete<{
            success: boolean;
            error?: string;
          }>(`/workspaces/${workspaceId}/consoles/${consoleId}/schedule`);

          if (response.success) {
            set(state => {
              const tab = state.tabs[consoleId];
              if (tab) {
                delete tab.schedule;
                if (tab.scheduledRun) {
                  delete tab.scheduledRun.nextAt;
                }
              }
            });
          }

          return response;
        } catch (e) {
          return {
            success: false,
            error: e instanceof Error ? e.message : "Failed to remove schedule",
          };
        }
      },

      runScheduledNow: async (workspaceId, consoleId) => {
        try {
          return await apiClient.post<ScheduledQueryScheduleResponse>(
            `/workspaces/${workspaceId}/consoles/${consoleId}/schedule/run`,
          );
        } catch (e) {
          return {
            success: false,
            error: e instanceof Error ? e.message : "Failed to run schedule",
          } as ScheduledQueryScheduleResponse;
        }
      },

      listScheduledRuns: async (workspaceId, consoleId, limit = 50) => {
        try {
          return await apiClient.get<ScheduledQueryRunsResponse>(
            `/workspaces/${workspaceId}/consoles/${consoleId}/schedule/runs`,
            { limit: String(limit) },
          );
        } catch (e) {
          return {
            success: false,
            runs: [],
            error: e instanceof Error ? e.message : "Failed to load runs",
          } as ScheduledQueryRunsResponse & { error?: string };
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
          } catch (_e) {
            // Auto-save failure - silently ignore as this is a best-effort operation
          }
        }, DRAFT_SAVE_DEBOUNCE_MS);

        draftSaveTimers.set(consoleId, timer);
      },
    })),
    {
      name: "console-store",
      partialize: state => ({
        tabs: state.tabs,
        tabOrder: state.tabOrder,
        activeTabId: state.activeTabId,
      }),
      storage: {
        getItem: name => {
          const str = localStorage.getItem(name);
          if (str) {
            const data = JSON.parse(str);
            if (data.state?.tabs) {
              // Rebuild or reconcile tabOrder with the current tabs map so
              // upgrading users don't end up with an empty tab strip.
              const tabIds = Object.keys(data.state.tabs);
              const persistedOrder: string[] = Array.isArray(
                data.state.tabOrder,
              )
                ? data.state.tabOrder.filter((id: string) =>
                    Object.prototype.hasOwnProperty.call(data.state.tabs, id),
                  )
                : [];
              const missing = tabIds.filter(id => !persistedOrder.includes(id));
              data.state.tabOrder = [...persistedOrder, ...missing];

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
export const selectConsoleTabs = (state: ConsoleStore): ConsoleTab[] => {
  // Return tabs in tabOrder, falling back to insertion order for any orphans.
  const ordered: ConsoleTab[] = [];
  const seen = new Set<string>();
  for (const id of state.tabOrder) {
    const tab = state.tabs[id];
    if (tab) {
      ordered.push(tab);
      seen.add(id);
    }
  }
  for (const [id, tab] of Object.entries(state.tabs)) {
    if (!seen.has(id)) ordered.push(tab);
  }
  return ordered;
};
export const selectActiveConsoleId = (state: ConsoleStore) => state.activeTabId;
export const selectConsoleById =
  (id: string) =>
  (state: ConsoleStore): ConsoleTab | undefined =>
    state.tabs[id];
export const selectTabByKind =
  (kind: TabKind) =>
  (state: ConsoleStore): ConsoleTab | undefined =>
    Object.values(state.tabs).find(tab => tab.kind === kind);
export const selectTabBySettingsSection =
  (section: SettingsSection) =>
  (state: ConsoleStore): ConsoleTab | undefined =>
    Object.values(state.tabs).find(
      tab => tab.kind === "settings" && tab.settingsSection === section,
    );
