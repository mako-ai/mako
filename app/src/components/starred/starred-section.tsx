/**
 * A Starred section for an explorer that already has its own structure.
 *
 * Apps use personal folders, where a star MOVES the app (see
 * `apps-explorer/personal-sections`). Notebooks and dashboards already have
 * real shared folders their team created, so here a star is a **shortcut**:
 * the entity keeps its place in the tree below and is also pinned on top. The
 * difference is not special-cased anywhere — it falls out of those explorers
 * having no personal folders to be moved out of.
 *
 * Rows get their own ids so the tree can tell the pinned copy from the real
 * one; the real row keeps the active-tab highlight.
 */
import { Star as StarIcon } from "lucide-react";

import type { ResourceTreeNode, ResourceTreeSection } from "../ResourceTree";
import type { PersonalFolder } from "../../store/personalFoldersStore";

export const STARRED_SECTION_KEY = "starred";
/** Marks the pinned copy of a row that also lives in the tree below. */
const STAR_ROW_PREFIX = "__star__";

export const starredRowId = (entityId: string) =>
  `${STAR_ROW_PREFIX}${entityId}`;

/** The entity a pinned row points at, or `null` for an ordinary row. */
export function entityIdFromStarredRow(nodeId: string): string | null {
  return nodeId.startsWith(STAR_ROW_PREFIX)
    ? nodeId.slice(STAR_ROW_PREFIX.length)
    : null;
}

/** The id an explorer should act on, whether the row is pinned or real. */
export const realEntityId = (nodeId: string) =>
  entityIdFromStarredRow(nodeId) ?? nodeId;

/** Keys the user has starred for this kind. */
export function starredKeys(folders: PersonalFolder[]): Set<string> {
  return new Set(folders.find(f => f.system === "starred")?.items ?? []);
}

/**
 * Every starrable row in a tree: the leaves, with folders walked through.
 *
 * Use the RAW store entries, never the nodes an explorer has decorated for
 * rendering. Dashboards is the cautionary case — `withDataSourceNodes` turns
 * each dashboard into a directory and stamps `entityType: "dashboard"` on it,
 * so a lookup written against decorated nodes finds nothing in the raw tree
 * and the Starred section silently renders empty.
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

/**
 * Build the Starred section, or nothing when the user has starred nothing —
 * the star button is its affordance, so an empty header would be pure noise.
 *
 * `resolve` turns a stored key into the row to show; returning `undefined`
 * drops the key silently, since the entity may simply be absent from this
 * listing (deleted, or not visible to this user). The stored membership is
 * left alone.
 */
export function buildStarredSection(
  folders: PersonalFolder[],
  resolve: (
    key: string,
  ) => { name: string; path?: string; entityType?: string } | undefined,
  icon?: ResourceTreeSection["icon"],
): ResourceTreeSection[] {
  const keys = folders.find(f => f.system === "starred")?.items ?? [];
  const nodes: ResourceTreeNode[] = [];
  for (const key of keys) {
    const row = resolve(key);
    if (!row) continue;
    nodes.push({
      id: starredRowId(key),
      name: row.name,
      path: row.path ?? key,
      isDirectory: false,
      // Carry the source row's entityType so a pinned row LOOKS like what it
      // points at. Dashboards' getItemIcon keys off it, so without this the
      // pinned copy renders iconless — the same trap that made the whole
      // section render empty when a lookup matched on entityType.
      ...(row.entityType ? { entityType: row.entityType } : {}),
    });
  }
  if (nodes.length === 0) return [];
  nodes.sort((a, b) => a.name.localeCompare(b.name));

  return [
    {
      key: STARRED_SECTION_KEY,
      label: "Starred",
      icon: icon ?? <StarIcon size={16} strokeWidth={1.5} />,
      nodes,
      // No droppableId/defaultAccess: this section is a personal view, and a
      // drop on it must never be read as a sharing change.
    },
  ];
}
