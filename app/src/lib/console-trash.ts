/**
 * The console trash, as the explorer talks about it and undoes it.
 *
 * Deleting a console — or a folder, with everything in it — moves the
 * consoles to the trash on the server; nothing is erased. There is no
 * trash view: the way back is the Undo offered right after the delete
 * (and Ctrl+Z in the tree), so the copy here promises exactly that and
 * nothing more.
 */

/** What `DELETE /consoles/folders/{id}` answers: what went to the trash. */
export interface TrashedFolder {
  folders: Array<{
    id: string;
    name: string;
    parentId: string | null;
    access: "private" | "workspace";
  }>;
  consoles: Array<{ id: string; name: string; folderId: string | null }>;
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The confirm dialog before a folder goes (a console goes without one). */
export function folderDeleteConfirmText(name: string): string {
  return `“${name}” will be removed, and the consoles in it — in its subfolders too — moved to the trash. You can undo this right after.`;
}

/** The toast after a delete; its action is Undo. */
export function trashedNotice(
  name: string,
  folder?: TrashedFolder | null,
): string {
  if (!folder) return `Moved “${name}” to trash`;
  const count = folder.consoles.length;
  return count === 0
    ? `Deleted the empty folder “${name}”`
    : `Deleted the folder “${name}” and moved ${plural(count, "console")} to trash`;
}

/** After an Undo of a console: under which name it is back. */
export function consoleRestoredNotice(
  name: string,
  restoredAs: string,
): string {
  return restoredAs === name
    ? `Restored “${name}”`
    : `Restored as “${restoredAs}”: the name “${name}” was taken meanwhile`;
}

export interface FolderRestoreOutcome {
  /** The folder itself is back (its subfolders may still have failed). */
  folderRecreated: boolean;
  /** Consoles back in the folder they were in. */
  inPlace: number;
  /** Consoles back at the root, because their folder could not be made. */
  atRoot: number;
  /** Consoles that could not be restored at all. */
  failed: number;
}

export interface FolderRestoreDeps {
  /** Create a folder; null when it could not be created. */
  createFolder: (
    name: string,
    parentId: string | null,
    access: "private" | "workspace",
  ) => Promise<string | null>;
  /** Restore a console into a folder (null = the root); false on failure. */
  restoreConsole: (id: string, folderId: string | null) => Promise<boolean>;
}

/**
 * Undo a folder delete: recreate the folder and its subfolders (parents
 * first), then restore each console into the folder it was in. A folder
 * that cannot be recreated — its name was taken, its parent is gone — does
 * not lose its consoles: they come back at the root, and the outcome says
 * so.
 */
export async function restoreTrashedFolder(
  deps: FolderRestoreDeps,
  trashed: TrashedFolder,
  parentId: string | null,
): Promise<FolderRestoreOutcome> {
  const [root, ...rest] = trashed.folders;
  const recreated = new Map<string, string>();
  if (root) {
    const id = await deps.createFolder(root.name, parentId, root.access);
    if (id) recreated.set(root.id, id);
  }
  // The server lists a folder before the folders inside it.
  for (const folder of rest) {
    const parent = folder.parentId ? recreated.get(folder.parentId) : undefined;
    if (!parent) continue;
    const id = await deps.createFolder(folder.name, parent, folder.access);
    if (id) recreated.set(folder.id, id);
  }
  const outcome: FolderRestoreOutcome = {
    folderRecreated: Boolean(root && recreated.has(root.id)),
    inPlace: 0,
    atRoot: 0,
    failed: 0,
  };
  for (const item of trashed.consoles) {
    const target = item.folderId ? recreated.get(item.folderId) : undefined;
    if (await deps.restoreConsole(item.id, target ?? null)) {
      if (target) outcome.inPlace += 1;
      else outcome.atRoot += 1;
    } else {
      outcome.failed += 1;
    }
  }
  return outcome;
}

/** After an Undo of a folder: what came back, and where. */
export function folderRestoredNotice(
  name: string,
  outcome: FolderRestoreOutcome,
  sectionLabel: string,
): string {
  const parts: string[] = [];
  const back = outcome.inPlace + outcome.atRoot;
  if (outcome.folderRecreated) {
    parts.push(
      outcome.inPlace === 0
        ? `Restored the folder “${name}”`
        : `Restored the folder “${name}” and ${plural(outcome.inPlace, "console")} in it`,
    );
    if (outcome.atRoot > 0) {
      parts.push(
        `${plural(outcome.atRoot, "console")} from a subfolder that could not be recreated ${outcome.atRoot === 1 ? "is" : "are"} at the root of ${sectionLabel}`,
      );
    }
  } else {
    parts.push(
      back === 0
        ? `The folder “${name}” could not be recreated`
        : `The folder “${name}” could not be recreated: ${plural(back, "console")} restored to the root of ${sectionLabel}`,
    );
  }
  if (outcome.failed > 0) {
    parts.push(`${plural(outcome.failed, "console")} could not be restored`);
  }
  return `${parts.join(". ")}.`;
}
