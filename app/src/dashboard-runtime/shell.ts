import { useConsoleStore } from "../store/consoleStore";
import { useUIStore } from "../store/uiStore";

export function focusDashboardTab(dashboardId: string, title: string): string {
  const tabId = useConsoleStore
    .getState()
    .focusOrOpenTab({ kind: "dashboard", metadata: { dashboardId } }, () => ({
      title,
      content: "",
      kind: "dashboard",
      metadata: { dashboardId },
    })) as string;
  useUIStore.getState().setLeftPane("dashboards");
  return tabId;
}

/**
 * Close every tab of a dashboard that no longer resolves (a dead `/d/:id`
 * link) — the dashboard itself and its data-source editors — so persisted
 * tabs do not restore the same dead id on every reload.
 */
export function closeDashboardTabsFor(dashboardId: string): boolean {
  const store = useConsoleStore.getState();
  const doomed = Object.values(store.tabs).filter(
    (tab: { id: string; kind?: string; metadata?: { dashboardId?: string } }) =>
      (tab.kind === "dashboard" || tab.kind === "dashboard-data-source") &&
      tab.metadata?.dashboardId === dashboardId,
  );
  for (const tab of doomed) store.closeTab(tab.id);
  return doomed.length > 0;
}

/**
 * Open a dashboard data source full-screen in its own editor tab (same
 * experience as app data bindings).
 */
export function focusDashboardDataSourceTab(
  dashboardId: string,
  dataSourceId: string,
  title: string,
): string {
  return useConsoleStore.getState().focusOrOpenTab(
    {
      kind: "dashboard-data-source",
      metadata: { dashboardId, dataSourceId },
    },
    () => ({
      title,
      content: "",
      kind: "dashboard-data-source",
      isSaved: true,
      metadata: { dashboardId, dataSourceId },
    }),
  ) as string;
}

/**
 * Keep a dashboard's tab label on its title. The label was set once, when
 * the tab opened: a rename (the tree, another window, the agent) or a
 * title edited in the definition left it — persisted — on the old name.
 */
export function syncDashboardTabTitle(
  dashboardId: string,
  title: string | undefined,
): void {
  if (!title) return;
  useConsoleStore.setState(state => {
    for (const tab of Object.values(state.tabs) as Array<{
      kind?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }>) {
      if (
        tab.kind === "dashboard" &&
        tab.metadata?.dashboardId === dashboardId &&
        tab.title !== title
      ) {
        tab.title = title;
      }
    }
  });
}
