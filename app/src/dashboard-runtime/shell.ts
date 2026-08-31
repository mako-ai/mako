import { useConsoleStore } from "../store/consoleStore";
import { useUIStore } from "../store/uiStore";

export function getCurrentWorkspaceId(): string | null {
  return useUIStore.getState().currentWorkspaceId ?? null;
}

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
