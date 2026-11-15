/**
 * Console store — open editor tabs (consoles and every other tab kind) and
 * the console records behind them. Actions live in slices under `./console/`;
 * this module composes them and owns persistence. The persist name,
 * `partialize` and the storage adapter's key/format handling are unchanged:
 * changing them would wipe users' open tabs.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import { computeConsoleStateHash } from "../utils/stateHash";
import { installConsoleStoreDebug } from "./console/debug";
import {
  blockedDraftSaves,
  draftSaveTimers,
  hasRecentUserEdit,
} from "./console/runtime";
import { consoleStorage, tabForPersistence } from "./console/persistence";
import { createConsoleScheduleSlice } from "./console/schedule-slice";
import { createConsoleServerSlice } from "./console/server-slice";
import { createConsoleSyncSlice } from "./console/sync-slice";
import { createConsoleTabsSlice } from "./console/tabs-slice";
import { initialConsoleState, type ConsoleStore } from "./console/types";
import { renderDebugEnabled } from "../utils/renderDebug";

export type {
  QueryExecuteResult,
  OpenTabInput,
  TabMatch,
} from "./console/types";
export { matchesTab, findTab } from "./console/types";
export {
  markUserEditActivity,
  hasRecentUserEdit,
  hasPendingAgentReview,
  getPendingAgentReview,
  hasPendingDraftSave,
  hasBlockedDraftSave,
  clearBlockedDraftSave,
} from "./console/runtime";
export {
  selectConsoleTabs,
  selectActiveConsoleId,
  selectConsoleById,
  selectTabByKind,
  selectTabBySettingsSection,
} from "./console/selectors";

export const useConsoleStore = create<ConsoleStore>()(
  persist(
    immer((...a) => ({
      ...initialConsoleState,
      ...createConsoleTabsSlice(...a),
      ...createConsoleSyncSlice(...a),
      ...createConsoleServerSlice(...a),
      ...createConsoleScheduleSlice(...a),
    })),
    {
      name: "console-store",
      partialize: state => ({
        tabs: Object.fromEntries(
          Object.entries(state.tabs).map(([id, tab]) => [
            id,
            tabForPersistence(tab),
          ]),
        ),
        tabOrder: state.tabOrder,
        activeTabId: state.activeTabId,
      }),
      storage: consoleStorage,
    },
  ),
);

if (renderDebugEnabled) installConsoleStoreDebug(useConsoleStore);

/**
 * Does this tab hold local edits that are not yet persisted on the server?
 *
 * This is the gate the realtime layer uses before applying a remote copy
 * over the tab. NOTE: this is intentionally NOT `tab.isDirty` — that flag is
 * the VS Code-style "pinned tab" marker (set on first keystroke, set again
 * after explicit saves, never cleared) and says nothing about persistence.
 *
 *  - drafts persist via autosave: unsaved edits exist only in the keystroke
 *    debounce window, while an autosave is queued, or while autosave is
 *    blocked on an unresolved conflict;
 *  - saved consoles persist via explicit save: unsaved edits exist when the
 *    current state hash differs from the hash captured at the last save.
 */
export const hasUnsavedLocalEdits = (consoleId: string): boolean => {
  if (hasRecentUserEdit(consoleId)) return true;
  if (draftSaveTimers.has(consoleId)) return true;
  if (blockedDraftSaves.has(consoleId)) return true;
  const tab = useConsoleStore.getState().tabs[consoleId];
  if (!tab) return false;
  if (tab.isSaved) {
    // Missing baseline hash: cannot prove the tab is clean — be conservative
    // (banner instead of a potentially destructive silent replace).
    if (!tab.savedStateHash) return true;
    const currentHash = computeConsoleStateHash(
      tab.content,
      tab.connectionId,
      tab.databaseId,
      tab.databaseName,
    );
    return currentHash !== tab.savedStateHash;
  }
  return false;
};
