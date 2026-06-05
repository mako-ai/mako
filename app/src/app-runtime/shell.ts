import { useConsoleStore } from "../store/consoleStore";
import { useUIStore } from "../store/uiStore";
import { useAppStore } from "../store/appStore";

export function getCurrentWorkspaceId(): string | null {
  return useUIStore.getState().currentWorkspaceId ?? null;
}

/** Open (or focus) the full-screen preview tab for a React app. */
export function focusAppTab(appId: string, title: string): string {
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
  return tabId;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

/** Open (or focus) a full-screen editor tab for a single file within an app. */
export function focusAppFileTab(appId: string, path: string): string {
  const consoleStore = useConsoleStore.getState();
  const existingTab = Object.values(consoleStore.tabs).find(
    (tab: { kind?: string; metadata?: { appId?: string; path?: string } }) =>
      tab.kind === "app-file" &&
      tab.metadata?.appId === appId &&
      tab.metadata?.path === path,
  );

  const tabId =
    existingTab?.id ??
    consoleStore.openTab({
      title: basename(path),
      content: "",
      kind: "app-file",
      metadata: { appId, path },
    });

  consoleStore.setActiveTab(tabId);
  useAppStore.getState().setActiveApp(appId);
  return tabId;
}
