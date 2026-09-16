/**
 * This user's personal sections of the Apps explorer — Starred, then each of
 * their folders — rendered above My Apps / Workspace.
 *
 * Flat, like Slack's sidebar: every list is a TOP-LEVEL section holding app
 * rows directly. There are no folder rows and no nesting, so there is nothing
 * to expand into a second file browser.
 *
 * **One home per app**: an app sits in exactly one place in this user's view —
 * Starred, or one folder, or its access-based home section. Filing moves it;
 * starring moves it. `placedKeys` is what the explorer subtracts from the home
 * sections. A row here stores an app SLUG and can never change the app's
 * identity, sharing or deployment, and nobody else's view changes.
 */
import { Folder as FolderIcon, Star as StarIcon } from "lucide-react";

import type { ResourceTreeNode, ResourceTreeSection } from "../ResourceTree";
import type { PersonalFolder } from "../../store/personalFoldersStore";

/** Marks an app row inside a personal section. */
const PF_PREFIX = "__pf__";
/** Separates the list id from the app id on such a row. */
const PF_ITEM_SEP = "::pfapp::";
/** Marks a ResourceTree section that is one of this user's lists. */
const PF_SECTION_PREFIX = "__pfsec__";

export const personalItemNodeId = (listId: string, appId: string) =>
  `${PF_PREFIX}${listId}${PF_ITEM_SEP}${appId}`;

export interface ParsedPersonalItem {
  kind: "personal-item";
  listId: string;
  appId: string;
}

/**
 * Recognize an app row inside a personal section. Returns `null` for every
 * other id, so callers fall through to the app/file parsing.
 */
export function parsePersonalNodeId(id: string): ParsedPersonalItem | null {
  if (!id.startsWith(PF_PREFIX)) return null;
  const rest = id.slice(PF_PREFIX.length);
  const sep = rest.indexOf(PF_ITEM_SEP);
  if (sep === -1) return null;
  return {
    kind: "personal-item",
    listId: rest.slice(0, sep),
    appId: rest.slice(sep + PF_ITEM_SEP.length),
  };
}

export const sectionKeyForList = (listId: string) =>
  `${PF_SECTION_PREFIX}${listId}`;

/** The list a personal section belongs to, or `null` for My Apps/Workspace. */
export function listIdFromSectionKey(sectionKey: string): string | null {
  return sectionKey.startsWith(PF_SECTION_PREFIX)
    ? sectionKey.slice(PF_SECTION_PREFIX.length)
    : null;
}

export const starredList = (folders: PersonalFolder[]) =>
  folders.find(f => f.system === "starred");

export const userFolders = (folders: PersonalFolder[]) =>
  folders.filter(f => !f.system);

/** Keys the user has starred — what the star toggle reads. */
export function starredKeys(folders: PersonalFolder[]): Set<string> {
  return new Set(starredList(folders)?.items ?? []);
}

/**
 * Every key FILED in one of this user's folders, and therefore hidden from the
 * access-based home sections in this user's view.
 *
 * Starred is excluded on purpose: a star is an overlay, so a starred app still
 * appears in its folder or its access section as well as at the top. That is
 * what keeps Apps behaving like notebooks and dashboards, where a star has
 * always been a pure shortcut.
 */
export function placedKeys(folders: PersonalFolder[]): Set<string> {
  const keys = new Set<string>();
  for (const f of userFolders(folders)) for (const k of f.items) keys.add(k);
  return keys;
}

/**
 * The list holding `key`, since a key lives in exactly one. Used to point the
 * active-row highlight at the app's only row.
 */
export function listOfKey(
  folders: PersonalFolder[],
  key: string | undefined,
): PersonalFolder | undefined {
  if (!key) return undefined;
  return folders.find(f => f.items.includes(key));
}

export interface PersonalSectionApp {
  id: string;
  title: string;
  slug?: string;
}

/**
 * Starred first, then each folder, each as its own section.
 *
 * Starred is omitted while empty — the star button is its affordance, so an
 * empty header would be pure noise. A user's folder is NOT: it stays visible
 * while empty, because a folder you just made has to be somewhere to drop
 * apps onto.
 *
 * A key that no longer resolves to an app (deleted, renamed, or not visible to
 * this user) is dropped rather than rendered as a broken row; the stored
 * membership is left alone, since the app may simply be missing from this
 * listing.
 */
export function buildPersonalSections(
  folders: PersonalFolder[],
  apps: PersonalSectionApp[],
): ResourceTreeSection[] {
  const bySlug = new Map<string, PersonalSectionApp>();
  for (const app of apps) {
    if (app.slug) bySlug.set(app.slug, app);
  }

  const rowsOf = (list: PersonalFolder): ResourceTreeNode[] => {
    const rows: ResourceTreeNode[] = [];
    for (const key of list.items) {
      const app = bySlug.get(key);
      if (!app) continue;
      rows.push({
        id: personalItemNodeId(list.id, app.id),
        name: app.title,
        path: app.slug ?? app.id,
        isDirectory: false,
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  };

  /**
   * `droppableId` makes the header a drop target; `defaultAccess` is
   * deliberately absent, so even if a drop ever reached the generic handler it
   * could not be read as a sharing change the way My Apps / Workspace are.
   */
  const sectionFor = (
    list: PersonalFolder,
    label: string,
    icon: ResourceTreeSection["icon"],
  ): ResourceTreeSection => ({
    key: sectionKeyForList(list.id),
    label,
    icon,
    nodes: rowsOf(list),
    droppableId: `__pfdrop__${list.id}`,
  });

  const sections: ResourceTreeSection[] = [];

  const star = starredList(folders);
  if (star && star.items.length > 0) {
    const section = sectionFor(
      star,
      "Starred",
      <StarIcon size={16} strokeWidth={1.5} />,
    );
    if (section.nodes.length > 0) sections.push(section);
  }

  for (const folder of userFolders(folders)) {
    sections.push(
      sectionFor(
        folder,
        folder.name,
        <FolderIcon size={16} strokeWidth={1.5} />,
      ),
    );
  }

  return sections;
}
