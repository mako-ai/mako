import { useConsoleStore } from "../store/consoleStore";

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

export function focusAppV2ProjectTab(
  projectId: string,
  title = "App Project",
): string {
  const store = useConsoleStore.getState();
  const existing = Object.values(store.tabs).find(
    tab => tab.kind === "app-v2" && tab.metadata?.projectId === projectId,
  );
  const tabId =
    existing?.id ??
    store.openTab({
      title,
      content: "",
      kind: "app-v2",
      isSaved: true,
      metadata: { projectId },
    });
  if (existing && title !== "App Project" && existing.title !== title) {
    store.updateTitle(existing.id, title);
  }
  store.setActiveTab(tabId);
  return tabId;
}

export function focusAppV2FileTab(projectId: string, path: string): string {
  const store = useConsoleStore.getState();
  const existing = Object.values(store.tabs).find(
    tab =>
      tab.kind === "app-v2-file" &&
      tab.metadata?.projectId === projectId &&
      tab.metadata?.path === path,
  );
  const tabId =
    existing?.id ??
    store.openTab({
      title: basename(path),
      content: "",
      kind: "app-v2-file",
      isSaved: true,
      metadata: { projectId, path },
    });
  store.setActiveTab(tabId);
  return tabId;
}
