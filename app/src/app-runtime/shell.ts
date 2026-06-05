import { useConsoleStore } from "../store/consoleStore";
import { useUIStore } from "../store/uiStore";
import { useAppStore } from "../store/appStore";

export function getCurrentWorkspaceId(): string | null {
  return useUIStore.getState().currentWorkspaceId ?? null;
}

/**
 * Open (or focus) a tab for a React app. Optionally focus a specific file in
 * the renderer. Returns the tab id.
 */
export function focusAppTab(
  appId: string,
  title: string,
  filePath?: string,
): string {
  const consoleStore = useConsoleStore.getState();
  const existingTab = Object.values(consoleStore.tabs).find(
    (tab: { kind?: string; metadata?: { appId?: string } }) =>
      tab.kind === "app" && tab.metadata?.appId === appId,
  );

  const tabId =
    existingTab?.id ??
    consoleStore.openTab({
      title,
      content: "",
      kind: "app",
      metadata: { appId },
    });

  consoleStore.setActiveTab(tabId);
  useAppStore.getState().setActiveApp(appId);
  if (filePath) {
    useAppStore.getState().setFocusedFile(appId, filePath);
  }
  return tabId;
}
