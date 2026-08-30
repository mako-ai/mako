/**
 * Apps tab helpers — open-or-focus dedupe for `app` tabs, mirroring
 * app-runtime/shell.ts (v1). One tab per project; the workspace view inside
 * the tab owns file selection, terminal, and preview state (appsStore).
 */
import { useConsoleStore } from "../store/consoleStore";

export function focusAppsTab(
  appId: string,
  title: string,
  slug?: string,
): string {
  const consoleStore = useConsoleStore.getState();
  const existingTab = Object.values(consoleStore.tabs).find(
    (tab: { kind?: string; metadata?: { appId?: string } }) =>
      tab.kind === "app" && tab.metadata?.appId === appId,
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
    kind: "app",
    metadata: { appId: appId, appSlug: slug },
  });
  consoleStore.setActiveTab(tabId);
  return tabId;
}

/** Open (or focus) a file of an Apps project in its own editor tab. */
export function focusAppsFileTab(
  appId: string,
  path: string,
  slug?: string,
): string {
  const consoleStore = useConsoleStore.getState();
  const existingTab = Object.values(consoleStore.tabs).find(
    (tab: { kind?: string; metadata?: { appId?: string; path?: string } }) =>
      tab.kind === "app-file" &&
      tab.metadata?.appId === appId &&
      tab.metadata?.path === path,
  );
  if (existingTab) {
    consoleStore.setActiveTab(existingTab.id);
    return existingTab.id;
  }
  const fileName = path.split("/").pop() || path;
  const tabId = consoleStore.openTab({
    title: fileName,
    content: "",
    kind: "app-file",
    metadata: { appId: appId, appSlug: slug, path },
  });
  consoleStore.setActiveTab(tabId);
  return tabId;
}

/**
 * Open (or focus) a diff of one repo-relative path, VS Code style: "Working
 * Tree" compares index → working copy (the Changes group), "Index" compares
 * HEAD → index (the Staged Changes group).
 */
export function focusAppsDiffTab(
  appId: string,
  path: string,
  mode: "working" | "index",
  slug?: string,
): string {
  const consoleStore = useConsoleStore.getState();
  const existingTab = Object.values(consoleStore.tabs).find(
    (tab: {
      kind?: string;
      metadata?: { appId?: string; path?: string; mode?: string };
    }) =>
      tab.kind === "app-diff" &&
      tab.metadata?.appId === appId &&
      tab.metadata?.path === path &&
      tab.metadata?.mode === mode,
  );
  if (existingTab) {
    consoleStore.setActiveTab(existingTab.id);
    return existingTab.id;
  }
  const fileName = path.split("/").pop() || path;
  const tabId = consoleStore.openTab({
    title: `${fileName} (${mode === "index" ? "Index" : "Working Tree"})`,
    content: "",
    kind: "app-diff",
    metadata: { appId: appId, appSlug: slug, path, mode },
  });
  consoleStore.setActiveTab(tabId);
  return tabId;
}

/**
 * Close any `app` / `app-file` tab pointing at an app that no longer
 * exists, and report whether anything was closed.
 *
 * Tabs outlive the apps they point at: they are persisted, so deleting an app
 * (or opening a link to one in another workspace) leaves a tab whose id
 * resolves to nothing. Without this the workspace view still renders — chrome,
 * breadcrumb and a live Publish button for an app that is not there — and
 * reloading does not help, because the same dead id is restored every time.
 */
export function closeAppsTabsFor(appId: string): boolean {
  const store = useConsoleStore.getState();
  const doomed = Object.values(store.tabs).filter(
    (tab: { id: string; kind?: string; metadata?: { appId?: string } }) =>
      (tab.kind === "app" ||
        tab.kind === "app-file" ||
        tab.kind === "app-diff") &&
      tab.metadata?.appId === appId,
  );
  for (const tab of doomed) store.closeTab(tab.id);
  return doomed.length > 0;
}

/**
 * Close every Apps tab whose app is not in `validIds`.
 *
 * Tabs are persisted per workspace but outlive the apps they point at: an app
 * gets deleted, or a link is opened against a workspace that never had it. The
 * leftover tab still rendered the full workspace view — breadcrumb, terminal,
 * and a live Publish button — wrapped around nothing.
 *
 * Call this only after a SUCCESSFUL listing. On a failed request the set is
 * empty, and closing every tab because the network blipped would be worse than
 * the bug.
 */
export function reconcileAppsTabs(validIds: Set<string>): void {
  const store = useConsoleStore.getState();
  const stale = Object.values(store.tabs).filter(
    (tab: { id: string; kind?: string; metadata?: { appId?: string } }) => {
      if (tab.kind !== "app" && tab.kind !== "app-file") return false;
      const id = tab.metadata?.appId;
      return Boolean(id) && !validIds.has(id!);
    },
  );
  for (const tab of stale) store.closeTab(tab.id);
}
