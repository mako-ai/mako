/**
 * Where a console sits in the explorer tree, and what this person may do
 * with its place — the client's half of the server's rules, so the
 * "Rename / Move…" and "Move to…" dialogs open on the console's REAL
 * section and folder and offer only what the server would accept.
 *
 * The server stays the judge (a 403/409 is shown as it says); these keep
 * the dialog from proposing a move it will refuse — the e2e saw a name-only
 * rename of a Workspace console land in "My Consoles" (the dialog always
 * preselected it), and a shared editor offered moves that could only fail.
 */
import type { ConsoleEntry } from "../store/consoleTreeStore";
import { consoleFolderTrail, consoleLeafName } from "./console-name";

export type ConsoleSection = "my" | "workspace";

/** A console's spot in the tree: its section and its parent folder. */
export interface ConsoleTreeSpot {
  section: ConsoleSection;
  /** The parent folder's id; null at the section's root. */
  folderId: string | null;
}

function parentOf(
  nodes: ConsoleEntry[],
  id: string,
  parentId: string | null,
): string | null | undefined {
  for (const node of nodes) {
    if (node.id === id) return parentId;
    if (node.isDirectory && node.children) {
      const found = parentOf(node.children, id, node.id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Where the tree lists the console `id`, or null when it does not. */
export function locateInConsoleTree(
  my: ConsoleEntry[],
  workspace: ConsoleEntry[],
  id: string,
): ConsoleTreeSpot | null {
  const inWorkspace = parentOf(workspace, id, null);
  if (inWorkspace !== undefined) {
    return { section: "workspace", folderId: inWorkspace };
  }
  const inMy = parentOf(my, id, null);
  if (inMy !== undefined) return { section: "my", folderId: inMy };
  return null;
}

function childrenOf(
  nodes: ConsoleEntry[],
  folderId: string | null,
): ConsoleEntry[] | null {
  if (folderId === null) return nodes;
  for (const node of nodes) {
    if (node.id === folderId && node.isDirectory) return node.children ?? [];
    if (node.isDirectory && node.children) {
      const found = childrenOf(node.children, folderId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The console already named `name` (case-insensitively, as file names
 * collide) directly in `folderId` of `section` — other than `selfId`, the
 * console being renamed or moved. A private root and the workspace root are
 * different places (different repo folders), so only `section` is searched.
 */
export function consoleNameTakenBy(
  tree: { my: ConsoleEntry[]; workspace: ConsoleEntry[] },
  section: ConsoleSection,
  folderId: string | null,
  name: string,
  selfId?: string,
): ConsoleEntry | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const siblings = childrenOf(
    section === "workspace" ? tree.workspace : tree.my,
    folderId,
  );
  return (
    siblings?.find(
      n => !n.isDirectory && n.id !== selfId && n.name.toLowerCase() === wanted,
    ) ?? null
  );
}

/** What a person may do with a console's place. */
export type RelocationScope =
  /** The owner or a workspace admin: any folder, either section. */
  | { kind: "anywhere" }
  /** Folders of one section only: changing who sees it is not theirs. */
  | { kind: "section"; section: ConsoleSection; reason: string }
  /** Rename where it is: its place is not theirs to change at all. */
  | { kind: "in-place"; reason: string };

/**
 * The server's visibility rule (only the console's owner or a workspace
 * admin may change who sees it), as the dialog applies it:
 * - a console the tree does not list in My Consoles or Workspace (another
 *   member's private console under "Shared with me" — an admin's too):
 *   rename in place. Its folder is its owner's, which this person cannot
 *   see; the dialog would open on THEIR My Consoles root, and a name-only
 *   rename sent from there moved it out of its owner's folder;
 * - owner / admin: anywhere;
 * - a shared editor of a console the workspace sees, listed under
 *   Workspace: Workspace folders only (My Consoles would hide it);
 * - otherwise (a private console shared with them, typically in its
 *   owner's folder they cannot see): rename in place.
 */
export function relocationScope(input: {
  isOwner: boolean;
  isAdmin: boolean;
  /** The console's EFFECTIVE visibility (the server's `access`). */
  access?: "private" | "workspace";
  spot: ConsoleTreeSpot | null;
}): RelocationScope {
  if (!input.spot) {
    return {
      kind: "in-place",
      reason: input.isOwner
        ? "The explorer does not list it yet: you can rename it here."
        : "This console was shared with you: you can rename it here, but it stays in its owner's folder.",
    };
  }
  if (input.isOwner || input.isAdmin) return { kind: "anywhere" };
  if (input.access === "workspace" && input.spot?.section === "workspace") {
    return {
      kind: "section",
      section: "workspace",
      reason:
        "It stays in Workspace: only the console's owner or a workspace admin can change who sees it.",
    };
  }
  return {
    kind: "in-place",
    reason:
      "This console was shared with you: you can rename it here, but moving it is its owner's or a workspace admin's call.",
  };
}

/**
 * The "name taken" sentence for a dialog: it names the EXISTING console —
 * a case twin ("alpha four" typed next to "Alpha Four") used to be
 * refused in the typed name's words — and says why a case twin counts.
 */
export function consoleNameTakenMessage(typed: string, existing: string) {
  const caseOnly = typed !== existing;
  return caseOnly
    ? `A console named “${existing}” already exists here — names that differ only in upper/lower case count as the same. Choose another name.`
    : `A console named “${existing}” already exists here. Choose another name.`;
}

/** What the editor's "Rename / Move…" sends to the server. */
export type RenameMoveRequest =
  /** PATCH /:id/rename — the console keeps its folder, wherever it is. */
  | { route: "rename"; name: string }
  /** PATCH /:id/move — to this folder (and section), maybe renamed. */
  | {
      route: "move";
      folderId: string | null;
      section: ConsoleSection;
      name?: string;
    };

/**
 * The route for the dialog's answer: a MOVE only when the folder or the
 * section changed — and only from a place the tree lists (a console it
 * does not list has no folder the dialog could have started from); a
 * name-only change is a RENAME, which keeps the console's folder on the
 * server (a `move` with the dialog's `folderId: null` put a console shared
 * with an admin at its owner's root). Null: nothing changed.
 */
export function renameMoveRequest(input: {
  scope: RelocationScope;
  /** Where the tree lists the console (null: not in My Consoles/Workspace). */
  from: ConsoleTreeSpot | null;
  /** The folder and section picked in the dialog. */
  to: ConsoleTreeSpot;
  /** The new name, when it changed. */
  renamedTo?: string;
}): RenameMoveRequest | null {
  const { from, to } = input;
  const moved =
    input.scope.kind !== "in-place" &&
    from !== null &&
    (to.folderId !== from.folderId || to.section !== from.section);
  if (moved) {
    return {
      route: "move",
      folderId: to.folderId,
      section: to.section,
      ...(input.renamedTo ? { name: input.renamedTo } : {}),
    };
  }
  return input.renamedTo ? { route: "rename", name: input.renamedTo } : null;
}

/**
 * Each character no file name can carry on every OS, and the visible
 * stand-in the server saves instead (api `cleanConsoleName` — keep the two
 * in step): "Q1: revenue" is saved as "Q1 - revenue", "A/B test" as
 * "A-B test".
 */
const FORBIDDEN_STAND_INS: Readonly<Record<string, string>> = {
  ":": " - ",
  "/": "-",
  "\\": "-",
  "|": "-",
  "*": "-",
  "?": "",
  '"': "'",
  "<": "(",
  ">": ")",
};

/** Zero-width spaces/joiners, the word joiner and a BOM. */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

function normalizeName(name: string): string {
  return name
    .normalize("NFC")
    .replace(INVISIBLE, "")
    .replace(/[\p{Cc}\s]+/gu, " ")
    .trim();
}

/** A console or folder name as the server will save it. */
export function consoleNameAsSaved(name: string): string {
  return normalizeName(
    normalizeName(name).replace(
      /[\\/:*?"<>|]/g,
      ch => FORBIDDEN_STAND_INS[ch] ?? "-",
    ),
  );
}

const RESERVED_ON_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/**
 * A console (or folder) name typed into a dialog: why it cannot be used,
 * or null — judged on the name as it will be SAVED (`consoleNameAsSaved`),
 * by the rules the server refuses with (empty, a leading or trailing dot,
 * a reserved device name, over 120 characters), so the dialog says it
 * inline instead of the save failing.
 */
export function consoleNameProblem(
  name: string,
  kind: "console" | "folder" = "console",
): string | null {
  const what = kind === "console" ? "console" : "folder";
  const saved = consoleNameAsSaved(name);
  if (!saved) return `Give the ${what} a name.`;
  if (saved.length > 120) {
    return `A ${what} name can be at most 120 characters (this one has ${saved.length}).`;
  }
  if (saved.startsWith(".")) return `A ${what} name cannot start with a dot.`;
  if (saved.endsWith(".")) return `A ${what} name cannot end with a dot.`;
  if (RESERVED_ON_WINDOWS.test(saved)) {
    return `“${saved.split(".")[0]}” is a reserved file name on Windows — choose another.`;
  }
  return null;
}

/**
 * What to tell a person about the name they typed, when it will be saved
 * differently ("Saved as “Q1 - revenue”"), or null.
 */
export function consoleNameSavedAsNotice(name: string): string | null {
  const saved = consoleNameAsSaved(name);
  return saved && saved !== name.trim() ? `Will be saved as “${saved}”.` : null;
}

/** The explorer section a console is listed under. */
export type ConsolePlacementSection =
  | "My Consoles"
  | "Workspace"
  | "Shared with me";

/**
 * The breadcrumb's section for a console, from its EFFECTIVE visibility
 * and owner: a private console someone shared with this person is not
 * "My Consoles" (the e2e's shared editor read "My Consoles › Team Drafts"
 * for a console that was never theirs) — it is shared with them.
 */
export function consoleSectionLabel(
  access: "private" | "workspace" | undefined,
  ownerId: string | undefined,
  currentUserId: string | undefined,
): ConsolePlacementSection {
  if (access === "workspace") return "Workspace";
  if (ownerId && currentUserId && ownerId !== currentUserId) {
    return "Shared with me";
  }
  return "My Consoles";
}

/**
 * Where a console sits — ONE rule for the explorer tree and the
 * breadcrumb (the server's `listConsolesSplit` lists by it): effectively
 * workspace → Workspace, in its folders; private and mine → My Consoles,
 * in my folders; another member's private console shared with me →
 * Shared with me, FLAT — its folder is its owner's, which the tree does
 * not show, so the breadcrumb does not name it either (the e2e's tree
 * said "Workspace" while the breadcrumb said "Shared with me › Team
 * Drafts").
 */
export function consolePlacement(input: {
  access: "private" | "workspace" | undefined;
  ownerId: string | undefined;
  currentUserId: string | undefined;
  /** The console's folder trail, root first (from its path). */
  folders: string[];
}): { section: ConsolePlacementSection; folders: string[] } {
  const section = consoleSectionLabel(
    input.access,
    input.ownerId,
    input.currentUserId,
  );
  return {
    section,
    folders: section === "Shared with me" ? [] : input.folders,
  };
}

/**
 * The snackbar after the editor's "Rename / Move…": "Renamed to 'X'" when
 * only the name changed — wherever the console is (a console in a folder
 * read "Moved to 'finance/Alpha Two'" for a rename) — and "Moved to …"
 * when its folder or section did.
 */
export function renameMoveNotice(input: {
  /** The new name, when the name changed. */
  renamedTo?: string;
  /** The folder or section changed. */
  moved: boolean;
  /** Where it is now: its section and folder trail. */
  section: string;
  folders: string[];
  name: string;
}): string {
  if (!input.moved) {
    return `Renamed to '${input.renamedTo ?? input.name}'`;
  }
  const place = [input.section, ...input.folders].join(" › ");
  return input.renamedTo
    ? `Moved to ${place} as '${input.renamedTo}'`
    : `Moved to ${place}`;
}

/**
 * The snackbar after a save: where the console is, in the breadcrumb's
 * words — a console shared with me is "Shared with me", never its owner's
 * folder ("Console saved to 'Team Drafts/Secret Margin ed2'" named a folder
 * the editor cannot see).
 */
export function consoleSavedNotice(input: {
  access: "private" | "workspace" | undefined;
  ownerId: string | undefined;
  currentUserId: string | undefined;
  /** The console's derived path (folders + leaf), as the tab knows it. */
  filePath: string;
  /** Its name (the tab's title); the path's leaf when absent. */
  name?: string;
}): string {
  const name = input.name || consoleLeafName(input.filePath);
  const place = consolePlacement({
    access: input.access,
    ownerId: input.ownerId,
    currentUserId: input.currentUserId,
    folders: consoleFolderTrail(input.filePath, name),
  });
  return `Console saved to ${[place.section, ...place.folders, name].join(" › ")}`;
}

/**
 * The snackbar after the explorer's Duplicate: where the copy went — My
 * Consoles, and the copier's folder of the same path when there is one
 * (`path` is the copy's tree path, folders + name). A copy used to land,
 * unannounced and unopened, in a collapsed folder of another section.
 */
export function consoleCopiedNotice(copy: {
  path: string;
  name: string;
  /** Where it went; a Duplicate's copy is always the copier's. */
  section?: "My Consoles" | "Workspace";
}): string {
  const place = [
    copy.section ?? "My Consoles",
    ...consoleFolderTrail(copy.path, copy.name),
  ];
  return `Copied to ${place.join(" › ")} as '${copy.name}'`;
}

/**
 * The snackbar after the explorer's "Move to…" (it said nothing): where the
 * item is now — "Moved to Workspace › finance" — or "Renamed to 'X'" when
 * only the name changed. Null: nothing changed.
 */
export function treeMoveNotice(input: {
  moved: boolean;
  renamedTo?: string;
  name: string;
  section: "my" | "workspace";
  /** The target folder's trail (`A/B`); empty at the section's root. */
  folderPath?: string;
}): string | null {
  if (!input.moved && !input.renamedTo) return null;
  return renameMoveNotice({
    renamedTo: input.renamedTo,
    moved: input.moved,
    section: input.section === "workspace" ? "Workspace" : "My Consoles",
    folders: (input.folderPath ?? "").split("/").filter(Boolean),
    name: input.renamedTo ?? input.name,
  });
}

/**
 * The snackbar after undoing a delete (Cmd+Z in the explorer): it said
 * nothing, even when the console came back under another name.
 */
export function consoleRestoredNotice(
  name: string,
  restoredAs?: string,
): string {
  return restoredAs && restoredAs !== name
    ? `Restored as '${restoredAs}'`
    : `Restored '${name}'`;
}

/**
 * What deleting a console or a folder does, in the confirm dialog's words
 * — promising only what the UI can do: its consoles go to the trash, and
 * the toast's Undo (or Ctrl+Z) brings them back; the trash has no view.
 * A folder delete is refused by the server when the folder holds another
 * member's console and the person is no workspace admin.
 */
export function consoleDeleteConfirmText(target: {
  name: string;
  isDirectory: boolean;
}): string {
  return target.isDirectory
    ? `Delete the folder “${target.name}” and its subfolders? The consoles in it move to the trash — you can undo this right after. A folder that holds another member's console can only be deleted by them or a workspace admin.`
    : `Move “${target.name}” to the trash? You can undo this right after.`;
}

/** Every console under a folder snapshot (any depth). */
function countConsoles(node: {
  isDirectory?: boolean;
  children?: unknown[];
}): number {
  let n = 0;
  for (const child of (node.children ?? []) as Array<{
    isDirectory?: boolean;
    children?: unknown[];
  }>) {
    n += child.isDirectory ? countConsoles(child) : 1;
  }
  return n;
}

const consoles = (n: number) => `${n} console${n === 1 ? "" : "s"}`;

/** The toast after a folder delete (with its Undo). */
export function consoleFolderTrashedNotice(
  name: string,
  snapshot?: { isDirectory?: boolean; children?: unknown[] },
): string {
  const n = snapshot ? countConsoles(snapshot) : 0;
  return n > 0
    ? `Deleted folder “${name}” — ${consoles(n)} moved to trash`
    : `Deleted folder “${name}”`;
}

/** The toast after undoing a folder delete: what came back, and where. */
export function consoleFolderRestoredNotice(
  name: string,
  outcome: {
    restored: number;
    failed: number;
    atRoot: number;
    folderRecreated: boolean;
    section: "My Consoles" | "Workspace";
  },
): string {
  const parts: string[] = [];
  if (outcome.folderRecreated) {
    const inside = outcome.restored - outcome.atRoot;
    parts.push(
      inside > 0
        ? `Restored folder “${name}” and ${consoles(inside)}`
        : `Restored folder “${name}”`,
    );
    if (outcome.atRoot > 0) {
      parts.push(
        `${consoles(outcome.atRoot)} came back to the root of ${outcome.section}`,
      );
    }
  } else if (outcome.restored > 0) {
    parts.push(
      `The folder “${name}” could not be recreated — ${consoles(outcome.restored)} restored to the root of ${outcome.section}`,
    );
  } else {
    parts.push(`The folder “${name}” could not be recreated`);
  }
  if (outcome.failed > 0) {
    parts.push(`${consoles(outcome.failed)} could not be restored`);
  }
  return parts.join("; ");
}
