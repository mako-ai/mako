/**
 * The "My Folders" section of the Apps explorer — a user's private groupings
 * rendered above My Apps / Workspace.
 *
 * This is a pure view over the app list. A folder stores app SLUGS, so nothing
 * here can change an app's identity, sharing or deployment; the section simply
 * offers a second place to reach an app you already have.
 *
 * Rows inside a folder are **leaf shortcuts**, not the drill-down directory
 * rows the home sections use. Two reasons: a folder is a shortcut list, not a
 * second file browser; and the ids must differ from the home row's so the
 * context menu can tell which copy was clicked and offer "Remove from this
 * folder" on it.
 */
import { Folder as FolderIcon } from "lucide-react";

import type { ResourceTreeNode, ResourceTreeSection } from "../ResourceTree";
import type { PersonalFolder } from "../../store/personalFoldersStore";

/** Marks a node as belonging to the personal-folders section. */
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
 * Recognize a personal-folders node id. Returns `null` for every other id, so
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

export interface PersonalSectionApp {
  id: string;
  title: string;
  slug?: string;
}

/**
 * Build the "My Folders" section, or nothing at all when the user has no
 * folders — an empty section would be a permanent empty header in the rail.
 *
 * A key that no longer resolves to an app (deleted, renamed, or never visible
 * to this user) is dropped rather than rendered as a broken row. The stored
 * membership is deliberately left alone: the app may simply be missing from
 * this particular listing.
 */
export function buildPersonalSections(
  folders: PersonalFolder[],
  apps: PersonalSectionApp[],
): ResourceTreeSection[] {
  if (folders.length === 0) return [];

  const bySlug = new Map<string, PersonalSectionApp>();
  for (const app of apps) {
    if (app.slug) bySlug.set(app.slug, app);
  }

  const nodes: ResourceTreeNode[] = folders.map(folder => {
    const children: ResourceTreeNode[] = [];
    for (const key of folder.items) {
      const app = bySlug.get(key);
      if (!app) continue;
      children.push({
        id: personalItemNodeId(folder.id, app.id),
        name: app.title,
        path: app.slug ?? app.id,
        isDirectory: false,
      });
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    return {
      id: personalFolderNodeId(folder.id),
      name: folder.name,
      path: personalFolderNodeId(folder.id),
      isDirectory: true,
      // Always a real array: `undefined` would make ResourceTree treat the
      // folder as lazily loaded and fire onLoadChildren forever.
      children,
    };
  });

  return [
    {
      key: "my-folders",
      label: "My Folders",
      icon: <FolderIcon size={16} strokeWidth={1.5} />,
      nodes,
      // No droppableId/defaultAccess on purpose: dropping on this section
      // header must never be read as a sharing change the way the My Apps and
      // Workspace headers are.
    },
  ];
}
