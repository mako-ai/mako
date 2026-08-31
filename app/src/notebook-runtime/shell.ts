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
