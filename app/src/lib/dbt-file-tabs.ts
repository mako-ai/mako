/**
 * A dbt-file tab is keyed by `{ projectId, path }`, and the address bar is
 * derived from that (tab-routing.ts). A rename that left the tab alone kept
 * an editor open on a path that no longer exists: the next save failed and
 * the copied link was dead. So the tab follows the file: same tab, new
 * path, new title; the editor reads the file under its new name and the
 * URL follows.
 *
 * Used by a rename made here (dbtStore.renameFile), by the realtime poke of
 * a rename made elsewhere (`dbt.file.updated` with `renamedTo`: another
 * window, the agent), and by an old link opened cold (`followMovedDbtFile`).
 */
import { useConsoleStore } from "../store/consoleStore";
import { basename } from "../utils/path";
import { resolveObjectRef } from "./object-links";

/** Point every open tab on `from` at `to`. Returns how many moved. */
export function retargetDbtFileTabs(
  projectId: string,
  from: string,
  to: string,
): number {
  if (from === to) return 0;
  let moved = 0;
  useConsoleStore.setState(state => {
    for (const tab of Object.values(state.tabs)) {
      if (
        tab.kind !== "dbt-file" ||
        tab.metadata?.projectId !== projectId ||
        tab.metadata.path !== from
      ) {
        continue;
      }
      tab.metadata = { ...tab.metadata, path: to };
      // The title follows only while it is the file's name: one a person
      // set by hand is theirs.
      if (!tab.title || tab.title === basename(from)) tab.title = basename(to);
      moved++;
    }
  });
  return moved;
}

/**
 * An old `/x/<project>/file/<path>` link: when the file was renamed or
 * moved since (here, or with `git mv` on a laptop), point the tab opened
 * for it at where the file is now. Resolves to the new path, or to null
 * when the link is current, names nothing, or the server could not say
 * (then the tab stays on the path as linked and the editor reports it).
 */
export async function followMovedDbtFile(
  workspaceId: string,
  projectId: string,
  path: string,
): Promise<string | null> {
  const resolved = await resolveObjectRef(
    workspaceId,
    "dbt_file",
    `${projectId}/${path}`,
  ).catch(() => null);
  const moved = resolved?.via === "alias" ? resolved.current.slug : undefined;
  if (!moved || moved === path) return null;
  retargetDbtFileTabs(projectId, path, moved);
  return moved;
}
