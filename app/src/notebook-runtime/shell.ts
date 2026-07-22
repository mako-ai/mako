import { useConsoleStore } from "../store/consoleStore";

/**
 * Open (or focus) the editor tab for a notebook. Mirrors `focusAppTab`
 * (app-runtime/shell.ts): the generic tab store (`consoleStore`) owns all tab
 * kinds, so a notebook tab is just `kind: "notebook"` with the id in metadata.
 */
export function focusNotebookTab(notebookId: string, title: string): string {
  const consoleStore = useConsoleStore.getState();
  const existing = Object.values(consoleStore.tabs).find(
    (tab: { kind?: string; metadata?: { notebookId?: string } }) =>
      tab.kind === "notebook" && tab.metadata?.notebookId === notebookId,
  );
  const tabId =
    existing?.id ??
    consoleStore.openTab(
      {
        title,
        content: "",
        kind: "notebook",
        // Notebooks own their own persistence — never auto-save as a console.
        isSaved: true,
        metadata: { notebookId },
      },
      // Notebooks are durable documents, not "preview" tabs: opening one must
      // not evict an existing pristine tab.
      { replacePristine: false },
    );
  // Pin the tab (mark it non-pristine) so a later open — another notebook or a
  // scratch console — doesn't replace it. This is what lets several notebooks
  // stay open at once, like consoles and dashboards. Renders non-italic (a
  // permanent tab), with no "unsaved" indicator.
  consoleStore.updateDirty(tabId, true);
  consoleStore.setActiveTab(tabId);
  return tabId;
}
