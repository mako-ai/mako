/**
 * Apps tab helpers — open-or-focus dedupe for `app` tabs, mirroring
 * app-runtime/shell.ts (v1). One tab per project; the workspace view inside
 * the tab owns file selection, terminal, and preview state (appsStore).
 */
import { useConsoleStore } from "../store/consoleStore";
import { basename } from "../utils/path";

export function focusAppsTab(
  appId: string,
  title: string,
  slug?: string,
): string {
  return useConsoleStore.getState().focusOrOpenTab(
    { kind: "app", metadata: { appId } },
    () => ({
      title: title || "App",
      content: "",
      kind: "app",
      metadata: { appId: appId, appSlug: slug },
    }),
    { title: title || undefined },
  ) as string;
}

/** Open (or focus) a file of an Apps project in its own editor tab. */
export function focusAppsFileTab(
  appId: string,
  path: string,
  slug?: string,
): string {
  const fileName = basename(path);
  return useConsoleStore
    .getState()
    .focusOrOpenTab({ kind: "app-file", metadata: { appId, path } }, () => ({
      title: fileName,
      content: "",
      kind: "app-file",
      metadata: { appId: appId, appSlug: slug, path },
    })) as string;
}

/**
 * Open (or focus) a diff of one repo-relative path, VS Code style: "Working
 * Tree" compares index → working copy (the Changes group), "Index" compares
 * HEAD → index (the Staged Changes group), "commit" shows what one commit
 * did to the file (parent → sha).
 */
export function focusAppsDiffTab(
  appId: string,
  path: string,
  mode: "working" | "index" | "commit",
  slug?: string,
  /** "commit" mode: the commit whose change to `path` is shown. */
  sha?: string,
): string {
  const fileName = basename(path);
  const label =
    mode === "commit"
      ? (sha ?? "").slice(0, 7)
      : mode === "index"
        ? "Index"
        : "Working Tree";
  return useConsoleStore.getState().focusOrOpenTab(
    {
      kind: "app-diff",
      metadata: { appId, path, mode, ...(mode === "commit" ? { sha } : {}) },
    },
    () => ({
      title: `${fileName} (${label})`,
      content: "",
      kind: "app-diff",
      metadata: { appId: appId, appSlug: slug, path, mode, sha },
    }),
  ) as string;
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
