/**
 * Render-debug logging of console store changes (dev only).
 */
import { logRenderDebug } from "../../utils/renderDebug";
import type { ConsoleStore } from "./types";

type ConsoleStoreDebugSnapshot = {
  tabCount: number;
  activeTabId: string | null;
  tabOrder: string;
  loadingKeys: string;
  errorKeys: string;
  activeTabContentLength: number | undefined;
  activeTabViewMode: string | undefined;
};

const createConsoleStoreDebugSnapshot = (
  state: ConsoleStore,
): ConsoleStoreDebugSnapshot => {
  const activeTab = state.activeTabId
    ? state.tabs[state.activeTabId]
    : undefined;
  return {
    tabCount: Object.keys(state.tabs).length,
    activeTabId: state.activeTabId,
    tabOrder: state.tabOrder.join("|"),
    loadingKeys: Object.keys(state.loading)
      .filter(key => state.loading[key])
      .sort()
      .join("|"),
    errorKeys: Object.keys(state.error)
      .filter(key => Boolean(state.error[key]))
      .sort()
      .join("|"),
    activeTabContentLength: activeTab?.content.length,
    activeTabViewMode: activeTab?.resultsViewMode,
  };
};

export function installConsoleStoreDebug(store: {
  getState: () => ConsoleStore;
  subscribe: (listener: (state: ConsoleStore) => void) => unknown;
}): void {
  let previousSnapshot = createConsoleStoreDebugSnapshot(store.getState());

  store.subscribe(state => {
    const nextSnapshot = createConsoleStoreDebugSnapshot(state);
    const changedKeys = Object.keys(nextSnapshot).filter(
      key =>
        !Object.is(
          previousSnapshot[key as keyof ConsoleStoreDebugSnapshot],
          nextSnapshot[key as keyof ConsoleStoreDebugSnapshot],
        ),
    );

    if (changedKeys.length > 0) {
      logRenderDebug("consoleStore changed", {
        changedKeys,
        previous: previousSnapshot,
        next: nextSnapshot,
      });
    }

    previousSnapshot = nextSnapshot;
  });
}
