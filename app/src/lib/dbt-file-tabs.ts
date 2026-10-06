/**
 * dbt-file tabs are keyed by `{ projectId, path }` and the address bar is
 * derived from that metadata (tab-routing.ts), so a rename that left the
 * tab alone kept an editor open on a path that no longer existed — the
 * next save 404'd and the copied link was dead. Retarget the tab instead:
 * same tab id, new path, new title; the editor re-reads the file under
 * its new name and the URL follows.
 *
 * Used by the UI rename (DbtExplorer → dbtStore.renameFile) and by the
 * realtime poke a server-side rename sends (`dbt.file.updated` with
 * `renamedTo`), so an agent / MCP rename moves the tab too.
 */
import { useConsoleStore } from "../store/consoleStore";
import { basename } from "../utils/path";

export function retargetDbtFileTabs(
  projectId: string,
  from: string,
  to: string,
): number {
  if (from === to) return 0;
  let moved = 0;
  useConsoleStore.setState(state => {
    for (const tab of Object.values(state.tabs) as Array<{
      kind?: string;
      title?: string;
      metadata?: Record<string, unknown>;
    }>) {
      if (
        tab.kind !== "dbt-file" ||
        !tab.metadata ||
        tab.metadata.projectId !== projectId ||
        tab.metadata.path !== from
      ) {
        continue;
      }
      tab.metadata = { ...tab.metadata, path: to };
      // Keep a renamed title only when it still matched the file name;
      // a title the user set by hand is theirs.
      if (!tab.title || tab.title === basename(from)) tab.title = basename(to);
      moved++;
    }
  });
  return moved;
}
