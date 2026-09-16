/**
 * The personal sections of the Apps explorer — this user's Starred list and
 * their own folders — rendered above My Apps / Workspace.
 *
 * Both are views over the same app list; a row here stores an app SLUG and can
 * never change the app's identity, sharing or deployment. They differ in one
 * way that matters:
 *
 * - **Starred** is a shortcut. The app stays in its home section and is also
 *   pinned on top.
 * - A **folder** is a move within this user's view. The app leaves its home
 *   section here (see `folderedKeys`) and lives in exactly one folder. Other
 *   users' views are untouched.
 *
 * Rows inside these sections are **leaf shortcuts**, not the drill-down
 * directory rows the home sections use: a shortlist is not a second file
 * browser, and the ids must differ from the home row's so the context menu can
 * tell which copy was clicked.
 */
import { Folder as FolderIcon, Star as StarIcon } from "lucide-react";

import type { ResourceTreeNode, ResourceTreeSection } from "../ResourceTree";
import type { PersonalFolder } from "../../store/personalFoldersStore";

export const STARRED_SECTION_KEY = "starred";
export const FOLDERS_SECTION_KEY = "my-folders";

/** Marks a node as belonging to a personal section. */
const PF_PREFIX = "__pf__";
/** Separates the folder id from the app id on a shortcut row. */
const PF_ITEM_SEP = "::pfapp::";

export const personalFolderNodeId = (folderId: string) =>
  `${PF_PREFIX}${folderId}`;

export const personalItemNodeId = (folderId: string, appId: string) =>
  `${PF_PREFIX}${folderId}${PF_ITEM_SEP}${appId}`;

export type ParsedPersonalNode =
  | { kind: "personal-folder"; folderId: string }
  | { kind: "personal-item"; folderId: string; appId: string };

/**
 * Recognize a personal-section node id. Returns `null` for every other id, so
 * callers can fall through to the app/file parsing.
 */
export function parsePersonalNodeId(id: string): ParsedPersonalNode | null {
  if (!id.startsWith(PF_PREFIX)) return null;
  const rest = id.slice(PF_PREFIX.length);
  const sep = rest.indexOf(PF_ITEM_SEP);
  if (sep === -1) return { kind: "personal-folder", folderId: rest };
  return {
    kind: "personal-item",
    folderId: rest.slice(0, sep),
    appId: rest.slice(sep + PF_ITEM_SEP.length),
  };
}

export const starredFolder = (folders: PersonalFolder[]) =>
  folders.find(f => f.system === "starred");

export const userFolders = (folders: PersonalFolder[]) =>
  folders.filter(f => !f.system);

/** Keys the user has starred. */
export function starredKeys(folders: PersonalFolder[]): Set<string> {
  return new Set(starredFolder(folders)?.items ?? []);
}

/**
 * Keys filed in one of the user's folders — and therefore HIDDEN from the
 * home sections in this user's view. Starred keys are not included: a star
 * never moves anything.
 */
export function folderedKeys(folders: PersonalFolder[]): Set<string> {
  const keys = new Set<string>();
  for (const f of userFolders(folders)) for (const k of f.items) keys.add(k);
  return keys;
}

/** The user folder holding `key`, if any (a key lives in at most one). */
export function folderOfKey(
  folders: PersonalFolder[],
  key: string | undefined,
): PersonalFolder | undefined {
  if (!key) return undefined;
  return userFolders(folders).find(f => f.items.includes(key));
}

export interface PersonalSectionApp {
  id: string;
  title: string;
  slug?: string;
}

/**
 * Build the Starred and My Folders sections. Each is omitted when it would be
 * empty — a permanent empty header in the rail is worse than none.
 *
 * A key that no longer resolves to an app (deleted, renamed, or not visible to
 * this user) is dropped rather than rendered as a broken row. The stored
 * membership is left alone: the app may simply be missing from this listing.
 */
export function buildPersonalSections(
  folders: PersonalFolder[],
  apps: PersonalSectionApp[],
): ResourceTreeSection[] {
  const bySlug = new Map<string, PersonalSectionApp>();
  for (const app of apps) {
    if (app.slug) bySlug.set(app.slug, app);
  }

  const shortcuts = (folder: PersonalFolder): ResourceTreeNode[] => {
    const rows: ResourceTreeNode[] = [];
    for (const key of folder.items) {
      const app = bySlug.get(key);
      if (!app) continue;
      rows.push({
        id: personalItemNodeId(folder.id, app.id),
        name: app.title,
        path: app.slug ?? app.id,
        isDirectory: false,
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  };

  const sections: ResourceTreeSection[] = [];

  const star = starredFolder(folders);
  const starredRows = star ? shortcuts(star) : [];
  if (starredRows.length > 0) {
    sections.push({
      key: STARRED_SECTION_KEY,
      label: "Starred",
      icon: <StarIcon size={16} strokeWidth={1.5} />,
      // Flat: stars are a list, not a tree.
      nodes: starredRows,
    });
  }

  const mine = userFolders(folders);
  if (mine.length > 0) {
    sections.push({
      key: FOLDERS_SECTION_KEY,
      label: "My Folders",
      icon: <FolderIcon size={16} strokeWidth={1.5} />,
      nodes: mine.map(folder => ({
        id: personalFolderNodeId(folder.id),
        name: folder.name,
        path: personalFolderNodeId(folder.id),
        isDirectory: true,
        // Always a real array: `undefined` would make ResourceTree treat the
        // folder as lazily loaded and fire onLoadChildren forever.
        children: shortcuts(folder),
      })),
      // No droppableId/defaultAccess on purpose: a drop on this header must
      // never be read as a sharing change the way My Apps / Workspace are.
    });
  }

  return sections;
}
