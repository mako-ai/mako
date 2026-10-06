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

/** A console name typed into a dialog: why it cannot be used, or null. */
export function consoleNameProblem(name: string): string | null {
  if (!name.trim()) return "Give the console a name.";
  if (name.includes("/")) {
    return "A name cannot contain “/” — choose the folder below.";
  }
  return null;
}

/**
 * The breadcrumb's section for a console, from its EFFECTIVE visibility
 * and owner: a private console someone shared with this person is not
 * "My Consoles" (the e2e's shared editor read "My Consoles › Team Drafts"
 * for a console that was never theirs) — it is shared with them, and the
 * folder trail that follows is its real folder, its owner's.
 */
export function consoleSectionLabel(
  access: "private" | "workspace" | undefined,
  ownerId: string | undefined,
  currentUserId: string | undefined,
): string {
  if (access === "workspace") return "Workspace";
  if (ownerId && currentUserId && ownerId !== currentUserId) {
    return "Shared with me";
  }
  return "My Consoles";
}
