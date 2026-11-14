/**
 * A dbt-file tab is keyed by `{ projectId, path }`, and the address bar is
 * derived from that (tab-routing.ts). A rename that left the tab alone kept
 * an editor open on a path that no longer exists: the next save failed and
 * the copied link was dead. So the tab follows the file: same tab, new
 * path, new title; the editor reads the file under its new name and the
 * URL follows. A file never ends up with two tabs.
 *
 * Used by a rename made here (dbtStore.renameFile), by the realtime poke of
 * a rename made elsewhere (`dbt.file.updated` with `renamedTo`: another
 * window, the agent), by an old link opened cold and by a tab restored on a
 * path its file has since left (`followMovedDbtFile`).
 */
import { useConsoleStore } from "../store/consoleStore";
import { basename } from "../utils/path";
import { resolveObjectRef } from "./object-links";

/**
 * Point the open tabs on `from` at `to`, and leave ONE tab for the file. A
 * tab already on `to` (restored from the last session, or opened by an
 * earlier visit of the same old link) is kept and focused, and the tabs on
 * `from` close; without one, the first tab on `from` moves and any twin of
 * it closes. Returns how many tabs were on `from`.
 */
export function retargetDbtFileTabs(
  projectId: string,
  from: string,
  to: string,
): number {
  if (from === to) return 0;
  const store = useConsoleStore.getState();
  const on = (path: string) =>
    Object.keys(store.tabs).filter(id => {
      const tab = store.tabs[id];
      return (
        tab?.kind === "dbt-file" &&
        tab.metadata?.projectId === projectId &&
        tab.metadata.path === path
      );
    });
  const moving = on(from);
  if (moving.length === 0) return 0;
  const existing = on(to)[0];
  const keep = existing ?? moving[0];
  if (!existing) {
    useConsoleStore.setState(state => {
      const tab = state.tabs[keep];
      tab.metadata = { ...tab.metadata, path: to };
      // The title follows only while it is the file's name: one a person
      // set by hand is theirs.
      if (!tab.title || tab.title === basename(from)) tab.title = basename(to);
    });
  }
  // Focus moves to the kept tab BEFORE its twins close, so closing the
  // active one does not hand the focus to a neighbour.
  if (store.activeTabId && moving.includes(store.activeTabId)) {
    store.setActiveTab(keep);
  }
  for (const id of moving) {
    if (id !== keep) store.closeTab(id);
  }
  return moving.length;
}

/**
 * An old `/x/<project>/file/<path>` link: when the file was renamed or
 * moved since (here, or with `git mv` on a laptop), point the tab opened
 * for it at where the file is now. Resolves to the new path, or to null
 * when the link is current, names nothing, or the server could not say
 * (then the tab stays on the path as linked and the editor reports it).
 */
export function followMovedDbtFile(
  workspaceId: string,
  projectId: string,
  path: string,
): Promise<string | null> {
  // The link's own check and the editor's (its first read of the old path
  // fails) ask at the same moment: one request answers both.
  const key = `${workspaceId}\0${projectId}\0${path}`;
  let asking = inFlight.get(key);
  if (!asking) {
    asking = resolveObjectRef(workspaceId, "dbt_file", `${projectId}/${path}`)
      .catch(() => null)
      .then(resolved =>
        resolved?.via === "alias" ? (resolved.current.slug ?? null) : null,
      )
      .finally(() => inFlight.delete(key));
    inFlight.set(key, asking);
  }
  return asking.then(moved => {
    if (!moved || moved === path) return null;
    retargetDbtFileTabs(projectId, path, moved);
    return moved;
  });
}

const inFlight = new Map<string, Promise<string | null>>();
