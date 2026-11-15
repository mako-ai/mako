/**
 * Tab strip and per-tab local state: open/focus/close, ordering, and the
 * field updaters.
 */
import { generateObjectId } from "../../utils/objectId";
import { ConsoleVersionManager } from "../../utils/ConsoleVersionManager";
import { computeConsoleStateHash } from "../../utils/stateHash";
import {
  versionManagers,
  pendingAgentReviews,
  cancelAutoSave,
  normalizeScheduledRunSnapshotForTab,
} from "./runtime";
import type { ConsoleSlice } from "./slice";
import { findTab } from "./types";

type Keys =
  | "openTab"
  | "focusOrOpenTab"
  | "closeTab"
  | "setActiveTab"
  | "clearAllConsoles"
  | "reorderTabs"
  | "updateContent"
  | "updateTitle"
  | "updateVersion"
  | "updateDraftRevision"
  | "updateDirty"
  | "updateMetadata"
  | "updateIcon"
  | "updateConnection"
  | "updateDatabase"
  | "updateFilePath"
  | "updateAccess"
  | "updateSavedState"
  | "updateChartSpec"
  | "updateResultsViewMode"
  | "getVersionManager"
  | "updateTabScheduledRun"
  | "openConsoleLoadErrorTab";

export const createConsoleTabsSlice: ConsoleSlice<Keys> = (set, get) => ({
  openTab: (tab, options) => {
    const id = tab.id || generateObjectId();
    const content = tab.content || "";

    // The preview-tab invariant (VS Code): at most ONE preview tab is
    // open at a time. A tab is a preview until it is pinned (`isDirty`,
    // rendered italic until then); opening another tab replaces it.
    // This rule is kind-agnostic — the store owns the invariant, and
    // each kind owns exactly one duty: pin the tab when its content is
    // modified (console: first keystroke; app-file / dbt-file: first
    // keystroke; app workbench: entering edit mode; flow: entering edit;
    // notebook / dbt-console / connector /
    // plan: durable documents, pinned at open). A double-click on the
    // tab title pins any kind.
    //
    // History: this used to check `kind === "console"` only. That was
    // added when opening a second app closed the first app's tab — but
    // the real defect was that the app workbench never pinned itself
    // when work started in it, so the "fix" quietly dropped the
    // invariant for every non-console kind and app tabs piled up.
    const replacePristine = options?.replacePristine ?? true;
    const pristineTabId = replacePristine
      ? Object.keys(get().tabs).find(tabId => {
          const candidate = get().tabs[tabId];
          return tabId !== id && !candidate.isDirty;
        })
      : undefined;

    if (tab.kind === undefined || tab.kind === "console") {
      versionManagers.set(id, new ConsoleVersionManager(id));
    }

    const savedStateHash =
      tab.savedStateHash ??
      (tab.filePath && !options?.preserveMissingSavedStateHash
        ? computeConsoleStateHash(
            content,
            tab.connectionId,
            tab.databaseId,
            tab.databaseName,
          )
        : undefined);

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

  focusOrOpenTab: (match, create, options) => {
    const existing = findTab(match)(get());
    if (existing) {
      if (options?.title && options.title !== existing.title) {
        set(state => {
          const tab = state.tabs[existing.id];
          if (tab) tab.title = options.title as string;
        });
      }
      if (options?.pin) get().updateDirty(existing.id, true);
      get().setActiveTab(existing.id);
      return existing.id;
    }
    const input = create?.();
    if (!input) return null;
    const id = get().openTab(
      input,
      options?.replacePristine === undefined
        ? undefined
        : { replacePristine: options.replacePristine },
    );
    if (options?.pin) get().updateDirty(id, true);
    get().setActiveTab(id);
    return id;
  },

  closeTab: id => {
    const versionManager = versionManagers.get(id);
    if (versionManager) {
      versionManager.cleanup();
      versionManagers.delete(id);
    }

    cancelAutoSave(id);
    pendingAgentReviews.delete(id);

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
      if (state.activeTabId === id) return;
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
        if (tab.content === content) return;
        tab.content = content;
      }
    }),

  updateTitle: (id, title) =>
    set(state => {
      const tab = state.tabs[id];
      if (tab) {
        if (tab.title === title) return;
        tab.title = title;
      }
    }),

  updateVersion: (id, version) =>
    set(state => {
      const tab = state.tabs[id];
      if (tab) {
        tab.version = version;
      }
    }),

  updateDraftRevision: (id, draftRevision) =>
    set(state => {
      const tab = state.tabs[id];
      if (tab) {
        tab.draftRevision = draftRevision;
      }
    }),

  updateDirty: (id, isDirty) =>
    set(state => {
      const tab = state.tabs[id];
      if (tab) {
        if (tab.isDirty === isDirty) return;
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
        if (tab.icon === icon) return;
        tab.icon = icon;
      }
    }),

  updateConnection: (id, connectionId) =>
    set(state => {
      const tab = state.tabs[id];
      if (tab) {
        if (tab.connectionId === connectionId) return;
        tab.connectionId = connectionId;
      }
    }),

  updateDatabase: (id, databaseId, databaseName) =>
    set(state => {
      const tab = state.tabs[id];
      if (tab) {
        if (
          tab.databaseId === databaseId &&
          tab.databaseName === databaseName
        ) {
          return;
        }
        tab.databaseId = databaseId;
        tab.databaseName = databaseName;
      }
    }),

  updateFilePath: (id, filePath) =>
    set(state => {
      const tab = state.tabs[id];
      if (tab) {
        if (tab.filePath === filePath) return;
        tab.filePath = filePath;
      }
    }),

  updateAccess: (id, access) =>
    set(state => {
      const tab = state.tabs[id];
      if (tab) {
        if (tab.access === access) return;
        tab.access = access;
      }
    }),

  updateSavedState: (id, isSaved, savedStateHash) =>
    set(state => {
      const tab = state.tabs[id];
      if (tab) {
        if (tab.isSaved === isSaved && tab.savedStateHash === savedStateHash) {
          return;
        }
        tab.isSaved = isSaved;
        tab.savedStateHash = savedStateHash;
      }
    }),

  updateChartSpec: (id, chartSpec) =>
    set(state => {
      const tab = state.tabs[id];
      if (tab) {
        if (tab.chartSpec === (chartSpec ?? undefined)) return;
        tab.chartSpec = chartSpec ?? undefined;
      }
    }),

  updateResultsViewMode: (id, mode) =>
    set(state => {
      const tab = state.tabs[id];
      if (tab) {
        if (tab.resultsViewMode === mode) return;
        tab.resultsViewMode = mode;
      }
    }),

  // Versioning

  getVersionManager: consoleId => versionManagers.get(consoleId) || null,

  // API operations

  updateTabScheduledRun: (tabId, scheduledRun) =>
    set(state => {
      const tab = state.tabs[tabId];
      if (!tab || scheduledRun == null) return;
      tab.scheduledRun = normalizeScheduledRunSnapshotForTab(scheduledRun);
    }),

  openConsoleLoadErrorTab: (consoleId, loadError) => {
    get().openTab(
      {
        id: consoleId,
        title: "Console",
        content: "",
        kind: "console",
        isSaved: false,
        metadata: { loadError },
      },
      { replacePristine: false },
    );
  },
});
