/**
 * Apps v2 tab helpers — open-or-focus dedupe for `app-v2` tabs, mirroring
 * app-runtime/shell.ts (v1). One tab per project; the workspace view inside
 * the tab owns file selection, terminal, and preview state (appsV2Store).
 */
import { useConsoleStore } from "../store/consoleStore";

export function focusAppsV2Tab(appId: string, title: string): string {
  const consoleStore = useConsoleStore.getState();
  const existingTab = Object.values(consoleStore.tabs).find(
    (tab: { kind?: string; metadata?: { appV2Id?: string } }) =>
      tab.kind === "app-v2" && tab.metadata?.appV2Id === appId,
  );

  if (existingTab) {
    if (existingTab.title !== title && title) {
      useConsoleStore.setState(state => {
        const tab = state.tabs[existingTab.id];
        if (tab) tab.title = title;
      });
    }
    consoleStore.setActiveTab(existingTab.id);
    return existingTab.id;
  }

  const tabId = consoleStore.openTab({
    title: title || "App",
    content: "",
    kind: "app-v2",
    metadata: { appV2Id: appId },
  });
  consoleStore.setActiveTab(tabId);
  return tabId;
}
