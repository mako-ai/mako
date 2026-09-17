/**
 * The Starred section of an explorer: this user's favourites of one kind, as
 * a tree of their own folders — browser bookmarks over the real tree below.
 *
 * A star is a shortcut, never a move: the entity keeps its place in the tree
 * beneath, and a pinned copy of its row sits up here. Rows get their own ids
 * so the tree can tell the pinned copy from the real one, and helpers here
 * translate between the two.
 */
import { Star as StarIcon } from "lucide-react";
import type { ResourceTreeNode, ResourceTreeSection } from "../ResourceTree";
import type { Favourite, FavouriteKind } from "../../store/favouritesStore";

export const STARRED_SECTION_KEY = "starred";
export const STARRED_DROPPABLE_ID = "__section_starred";
/** A pinned copy of an entity row: `__star__<refId>`. */
const STAR_ROW_PREFIX = "__star__";
/** A favourites folder row: `__starfolder__<favourite id>`. */
const STAR_FOLDER_PREFIX = "__starfolder__";

export const starredRowId = (refId: string) => `${STAR_ROW_PREFIX}${refId}`;
export const starredFolderId = (favouriteId: string) =>
  `${STAR_FOLDER_PREFIX}${favouriteId}`;

/** The entity a pinned row points at, or `null` for any other row. */
export function entityIdFromStarredRow(nodeId: string): string | null {
  return nodeId.startsWith(STAR_ROW_PREFIX)
    ? nodeId.slice(STAR_ROW_PREFIX.length)
    : null;
}

/** The favourite row behind a Starred folder node, or `null`. */
export function favouriteIdFromFolderRow(nodeId: string): string | null {
  return nodeId.startsWith(STAR_FOLDER_PREFIX)
    ? nodeId.slice(STAR_FOLDER_PREFIX.length)
    : null;
}

/** Any row that lives under Starred (pinned entity or favourites folder). */
export function isStarredRow(nodeId: string): boolean {
  return (
    nodeId.startsWith(STAR_ROW_PREFIX) || nodeId.startsWith(STAR_FOLDER_PREFIX)
  );
}

/** The id an explorer should act on, whether the row is pinned or real. */
export const realEntityId = (nodeId: string) =>
  entityIdFromStarredRow(nodeId) ?? nodeId;

/**
 * Every starrable row in a tree: the leaves, with folders walked through.
 * Use the RAW store entries, never nodes an explorer has decorated.
 */
export function flattenLeafRows(
  nodes: readonly ResourceTreeNode[],
): ResourceTreeNode[] {
  const out: ResourceTreeNode[] = [];
  const walk = (list: readonly ResourceTreeNode[]) => {
    for (const node of list) {
      if (node.isDirectory) walk(node.children ?? []);
      else out.push(node);
    }
  };
  walk(nodes);
  return out;
}

export interface StarredRowInfo {
  name: string;
  path?: string;
  entityType?: string;
  /** Carried so the pinned row can show who can see the entity. */
  access?: "private" | "workspace";
  owner_id?: string;
  /** Pinned rows may need to be directories (apps expand to their files). */
  isDirectory?: boolean;
  children?: ResourceTreeNode[];
}

/**
 * Build the Starred section for one kind: the user's favourites folders
 * (all of them — a folder may hold several kinds, and an empty one is still
 * theirs to fill) and the items of this kind, each resolved against the
 * explorer's own listing. An item that does not resolve is dropped silently:
 * the entity may be gone, or invisible to this user. Returns nothing when
 * the tree would be empty — the star button is its affordance.
 */
export function buildStarredSection(
  favourites: Favourite[],
  kind: FavouriteKind,
  resolve: (refId: string) => StarredRowInfo | undefined,
  options: { icon?: ResourceTreeSection["icon"]; droppable?: boolean } = {},
): ResourceTreeSection[] {
  const byParent = new Map<string | null, Favourite[]>();
  for (const f of favourites) {
    const list = byParent.get(f.parentId) ?? [];
    list.push(f);
    byParent.set(f.parentId, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }
  let count = 0;
  const build = (parentId: string | null): ResourceTreeNode[] => {
    const out: ResourceTreeNode[] = [];
    for (const f of byParent.get(parentId) ?? []) {
      if (f.type === "folder") {
        out.push({
          id: starredFolderId(f.id),
          name: f.title ?? "",
          path: f.id,
          isDirectory: true,
          entityType: "starred-folder",
          children: build(f.id),
        });
        continue;
      }
      if (f.kind !== kind || !f.refId) continue;
      const row = resolve(f.refId);
      if (!row) continue;
      count++;
      out.push({
        id: starredRowId(f.refId),
        name: row.name,
        path: row.path ?? f.refId,
        isDirectory: row.isDirectory ?? false,
        ...(row.children !== undefined ? { children: row.children } : {}),
        ...(row.entityType ? { entityType: row.entityType } : {}),
        ...(row.access ? { access: row.access } : {}),
        ...(row.owner_id ? { owner_id: row.owner_id } : {}),
      });
    }
    return out;
  };
  const nodes = build(null);
  const hasFolders = favourites.some(f => f.type === "folder");
  if (count === 0 && !hasFolders) return [];
  return [
    {
      key: STARRED_SECTION_KEY,
      label: "Starred",
      icon: options.icon ?? <StarIcon size={16} strokeWidth={1.5} />,
      nodes,
      // A drop here is claimed by onSectionDrop (star it), never read as a
      // sharing change: no defaultAccess.
      ...(options.droppable ? { droppableId: STARRED_DROPPABLE_ID } : {}),
    },
  ];
}
