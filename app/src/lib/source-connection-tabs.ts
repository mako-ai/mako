/**
 * Source-connection tabs outlive the credential they point at.
 *
 * A tab's identity is `kind: "connectors"` + `content` (the source-connection
 * id). Deleting the row — or loading a `/cx/:id` link that no longer resolves
 * — used to leave the tab open. SourceConnectionTab then GETs 404 and shows
 * "Failed to load source connection", and because tabs are persisted, reload
 * restored the same dead id. Apps already close their tabs in this situation
 * (`closeAppsTabsFor` / `reconcileAppsTabs`); source connections did not.
 */
import { useConsoleStore } from "../store/consoleStore";

function isSourceConnectionTab(
  tab: { kind?: string; content?: unknown },
  sourceId: string,
): boolean {
  return tab.kind === "connectors" && tab.content === sourceId;
}

/** Close every source-connection tab pointing at `sourceId`. */
export function closeSourceConnectionTabsFor(sourceId: string): boolean {
  if (!sourceId) return false;
  const store = useConsoleStore.getState();
  const doomed = Object.values(store.tabs).filter(tab =>
    isSourceConnectionTab(tab, sourceId),
  );
  for (const tab of doomed) store.closeTab(tab.id);
  return doomed.length > 0;
}

/**
 * Close persisted source-connection tabs whose ids are not in `validIds`.
 *
 * Call only after a SUCCESSFUL listing. An empty set from a failed request
 * would close every open source-connection tab because the network blipped.
 * Unsaved "New source connection" tabs have empty `content` and are kept.
 */
export function reconcileSourceConnectionTabs(validIds: Set<string>): void {
  const store = useConsoleStore.getState();
  const stale = Object.values(store.tabs).filter(tab => {
    if (tab.kind !== "connectors") return false;
    const id = typeof tab.content === "string" ? tab.content : "";
    return Boolean(id) && !validIds.has(id);
  });
  for (const tab of stale) store.closeTab(tab.id);
}
