import { useConsoleStore } from "../store/consoleStore";

/**
 * Open (or focus) the editor tab for a notebook. The generic tab store owns
 * all tab kinds, so a notebook tab is just `kind: "notebook"` with the id in
 * metadata. Notebooks are durable documents, not previews: they open pinned
 * and never evict a pristine tab, so several stay open at once.
 */
export function focusNotebookTab(notebookId: string, title: string): string {
  return useConsoleStore.getState().focusOrOpenTab(
    { kind: "notebook", metadata: { notebookId } },
    () => ({
      title,
      content: "",
      kind: "notebook",
      // Notebooks own their own persistence — never auto-save as a console.
      isSaved: true,
      metadata: { notebookId },
    }),
    { replacePristine: false, pin: true },
  ) as string;
}

/**
 * Close every tab for a notebook that no longer resolves (a dead `/n/:id`
 * link): persisted tabs would otherwise restore the same dead id on every
 * reload. Returns whether anything was closed.
 */
export function closeNotebookTabsFor(notebookId: string): boolean {
  const store = useConsoleStore.getState();
  const doomed = Object.values(store.tabs).filter(
    (tab: { id: string; kind?: string; metadata?: { notebookId?: string } }) =>
      tab.kind === "notebook" && tab.metadata?.notebookId === notebookId,
  );
  for (const tab of doomed) store.closeTab(tab.id);
  return doomed.length > 0;
}
