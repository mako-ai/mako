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
    consoleStore.openTab({
      title,
      content: "",
      kind: "notebook",
      // Notebooks own their own persistence — never auto-save as a console.
      isSaved: true,
      metadata: { notebookId },
    });
  consoleStore.setActiveTab(tabId);
  return tabId;
}
