import { useConsoleStore } from "../store/consoleStore";
import { useUIStore } from "../store/uiStore";

export function getCurrentWorkspaceId(): string | null {
  return useUIStore.getState().currentWorkspaceId ?? null;
}

export function focusDashboardTab(dashboardId: string, title: string): string {
  const consoleStore = useConsoleStore.getState();
  const existingTab = Object.values(consoleStore.tabs).find(
    (tab: any) =>
      tab.kind === "dashboard" && tab.metadata?.dashboardId === dashboardId,
  );

  const tabId =
    existingTab?.id ??
    consoleStore.openTab({
      title,
      content: "",
      kind: "dashboard",
      metadata: { dashboardId },
    });

  consoleStore.setActiveTab(tabId);
  useUIStore.getState().setLeftPane("dashboards");
  return tabId;
}
