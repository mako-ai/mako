/**
 * Shortcut sections: a short, read-only list of entity rows pinned above an
 * explorer's real tree — "Recently viewed", "Popular". The same idea as
 * Starred (starred-section.tsx) without the folders: a shortcut is a view of
 * a row that lives in the tree below, so it gets its own node id, and the
 * explorer translates back with {@link parseShortcutRow}.
 *
 * Shared by every explorer that wants one; do not fork per kind.
 */
import type { ReactNode } from "react";
import type { ResourceTreeNode, ResourceTreeSection } from "../ResourceTree";
import type { StarredRowInfo } from "./starred-section";

/** `__shortcut__<sectionKey>::<refId>`. */
const SHORTCUT_PREFIX = "__shortcut__";
const SHORTCUT_SEP = "::";

export const shortcutRowId = (sectionKey: string, refId: string) =>
  `${SHORTCUT_PREFIX}${sectionKey}${SHORTCUT_SEP}${refId}`;

/** The section and entity a shortcut row points at, or `null`. */
export function parseShortcutRow(
  nodeId: string,
): { sectionKey: string; refId: string } | null {
  if (!nodeId.startsWith(SHORTCUT_PREFIX)) return null;
  const rest = nodeId.slice(SHORTCUT_PREFIX.length);
  const sep = rest.indexOf(SHORTCUT_SEP);
  if (sep < 0) return null;
  return {
    sectionKey: rest.slice(0, sep),
    refId: rest.slice(sep + SHORTCUT_SEP.length),
  };
}

/**
 * Build one shortcut section from an ordered list of entity ids. Ids that
 * do not resolve (gone, or invisible to this user) are dropped, and the
 * section is omitted entirely when nothing is left — an empty "Popular"
 * header is noise, not information.
 */
export function buildShortcutSection(options: {
  key: string;
  label: string;
  icon?: ReactNode;
  refIds: readonly string[];
  resolve: (refId: string) => StarredRowInfo | undefined;
  limit?: number;
}): ResourceTreeSection[] {
  const nodes: ResourceTreeNode[] = [];
  const seen = new Set<string>();
  for (const refId of options.refIds) {
    if (seen.has(refId)) continue;
    seen.add(refId);
    const row = options.resolve(refId);
    if (!row) continue;
    nodes.push({
      id: shortcutRowId(options.key, refId),
      name: row.name,
      path: row.path ?? refId,
      isDirectory: false,
      ...(row.entityType ? { entityType: row.entityType } : {}),
      ...(row.access ? { access: row.access } : {}),
      ...(row.owner_id ? { owner_id: row.owner_id } : {}),
    });
    if (options.limit && nodes.length >= options.limit) break;
  }
  if (nodes.length === 0) return [];
  return [
    {
      key: options.key,
      label: options.label,
      ...(options.icon ? { icon: options.icon } : {}),
      nodes,
    },
  ];
}
