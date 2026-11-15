import type { ResourceTreeNode, ResourceTreeSection } from "./types";
import { getFolderDropTargetId } from "./utils";

/**
 * One rendered line of the tree. The nested tree is flattened into rows so
 * it can be virtualized; `parent` (the index of the enclosing section header
 * or expanded folder header) and `scopeEnd` (the last row a header's scope
 * covers) keep enough structure for sticky headers and drop targets.
 */
export type FlatRow =
  | {
      kind: "section-header";
      key: string;
      section: ResourceTreeSection;
      scopeEnd: number;
    }
  | {
      kind: "section-empty";
      key: string;
      section: ResourceTreeSection;
      parent: number | null;
      dropTarget: string | undefined;
    }
  | {
      kind: "folder";
      key: string;
      node: ResourceTreeNode;
      depth: number;
      sectionKey: string;
      isExpanded: boolean;
      /** Own index when collapsed (a collapsed folder has no scope below it). */
      scopeEnd: number;
      parent: number | null;
    }
  | {
      kind: "file";
      key: string;
      node: ResourceTreeNode;
      depth: number;
      sectionKey: string;
      parent: number | null;
      dropTarget: string | undefined;
    }
  | {
      kind: "skeleton" | "empty";
      key: string;
      /** Depth of the folder whose children are loading / empty. */
      depth: number;
      parent: number;
      dropTarget: string | undefined;
    }
  | { kind: "spacer"; key: string };

export type HeaderRow = Extract<FlatRow, { kind: "section-header" | "folder" }>;

export interface FlattenOptions {
  showFiles: boolean;
  enableDragDrop: boolean;
  sectionExpanded: Record<string, boolean>;
  isNodeExpanded: (node: ResourceTreeNode) => boolean;
  isLoadingChildren?: (node: ResourceTreeNode) => boolean;
}

/**
 * Flatten the visible part of the (already search-filtered) sections, in
 * exactly the order the nested tree rendered them.
 */
export function flattenTreeRows(
  sections: ResourceTreeSection[],
  options: FlattenOptions,
): FlatRow[] {
  const rows: FlatRow[] = [];
  const { showFiles, enableDragDrop, sectionExpanded } = options;

  const visit = (
    nodes: ResourceTreeNode[],
    depth: number,
    sectionKey: string,
    parent: number | null,
    // What a drop on a plain row here targets: the enclosing folder's
    // content area, or the section (when it is a drop target).
    contentDropTarget: string | undefined,
  ) => {
    for (const node of nodes) {
      if (!showFiles && !node.isDirectory) continue;

      if (!node.isDirectory) {
        rows.push({
          kind: "file",
          key: `file-${node.id}`,
          node,
          depth,
          sectionKey,
          parent,
          dropTarget: contentDropTarget,
        });
        continue;
      }

      const isExpanded = options.isNodeExpanded(node);
      const index = rows.length;
      const folderRow: Extract<FlatRow, { kind: "folder" }> = {
        kind: "folder",
        key: `folder-${node.id}`,
        node,
        depth,
        sectionKey,
        isExpanded,
        scopeEnd: index,
        parent,
      };
      rows.push(folderRow);
      if (!isExpanded) continue;

      const childTarget = enableDragDrop
        ? getFolderDropTargetId(node.id)
        : undefined;
      const loading = !!options.isLoadingChildren?.(node);
      if (loading || node.children === undefined) {
        for (let i = 0; i < 3; i++) {
          rows.push({
            kind: "skeleton",
            key: `child-skel-${node.id}-${i}`,
            depth,
            parent: index,
            dropTarget: childTarget,
          });
        }
      } else {
        const before = rows.length;
        visit(node.children, depth + 1, sectionKey, index, childTarget);
        if (rows.length === before) {
          rows.push({
            kind: "empty",
            key: `child-empty-${node.id}`,
            depth,
            parent: index,
            dropTarget: childTarget,
          });
        }
      }
      folderRow.scopeEnd = rows.length - 1;
    }
  };

  for (const section of sections) {
    const sectionDropTarget =
      enableDragDrop && section.droppableId ? section.droppableId : undefined;
    let parent: number | null = null;
    let headerRow: Extract<FlatRow, { kind: "section-header" }> | null = null;
    if (!section.hideSectionHeader) {
      parent = rows.length;
      headerRow = {
        kind: "section-header",
        key: `section-${section.key}`,
        section,
        scopeEnd: rows.length,
      };
      rows.push(headerRow);
    }

    const sectionVisible =
      section.hideSectionHeader || sectionExpanded[section.key] !== false;
    if (sectionVisible) {
      if (section.nodes.length > 0) {
        visit(
          section.nodes,
          section.hideSectionHeader ? 0 : 1,
          section.key,
          parent,
          sectionDropTarget,
        );
      } else {
        rows.push({
          kind: "section-empty",
          key: `section-empty-${section.key}`,
          section,
          parent,
          dropTarget: sectionDropTarget,
        });
      }
    }
    if (headerRow) headerRow.scopeEnd = rows.length - 1;
  }

  // Trailing spacer so the last row doesn't feel flush to the bottom of the
  // scroll container and hint there's more content below.
  rows.push({ kind: "spacer", key: "__spacer" });
  return rows;
}

/** Whether a row is a header with rows below it in its scope (can stick). */
export function isScopeHeader(row: FlatRow): row is HeaderRow {
  return (
    row.kind === "section-header" || (row.kind === "folder" && row.isExpanded)
  );
}

/** Index of the enclosing header, for any row kind. */
export function parentOf(row: FlatRow): number | null {
  return "parent" in row ? row.parent : null;
}

/** Ids of every folder enclosing `index` (outermost first). */
export function ancestorFolderIds(rows: FlatRow[], index: number): string[] {
  const ids: string[] = [];
  let p = parentOf(rows[index]);
  while (p !== null) {
    const row = rows[p];
    if (row.kind === "folder") ids.unshift(row.node.id);
    p = parentOf(row);
  }
  return ids;
}

export interface RenderedItem {
  index: number;
  offset: number;
  size: number;
}

export interface StickyScope {
  index: number;
  /** Top of the scope (the header's slot), in list coordinates. */
  top: number;
  height: number;
}

/**
 * Where to draw each sticky header's scope: the block from the header's slot
 * to the bottom of its last row, inside which the header is `position:
 * sticky`. Rows that are virtualized away are treated as "far": a header
 * above the rendered range starts its scope at 0, a scope ending below it
 * runs to the list's end. Only headers whose scope overlaps the rendered
 * range are returned.
 */
export function computeStickyScopes(
  rows: FlatRow[],
  rendered: RenderedItem[],
  totalHeight: number,
): StickyScope[] {
  if (rendered.length === 0) return [];
  const byIndex = new Map(rendered.map(item => [item.index, item]));
  const first = rendered[0].index;
  const last = rendered[rendered.length - 1].index;
  const scopes: StickyScope[] = [];

  const consider = (index: number) => {
    const row = rows[index];
    if (!row || !isScopeHeader(row)) return;
    if (index > last || row.scopeEnd < first) return;
    const header = byIndex.get(index);
    const end = byIndex.get(row.scopeEnd);
    const top = header ? header.offset : 0;
    const bottom = end ? end.offset + end.size : totalHeight;
    scopes.push({ index, top, height: Math.max(0, bottom - top) });
  };

  // Headers above the rendered range that still enclose it: the ancestors
  // of the first rendered row.
  const seen = new Set<number>();
  let p = parentOf(rows[first]);
  const enclosing: number[] = [];
  while (p !== null) {
    enclosing.unshift(p);
    p = parentOf(rows[p]);
  }
  for (const index of enclosing) {
    seen.add(index);
    consider(index);
  }
  for (let index = first; index <= last; index++) {
    if (!seen.has(index)) consider(index);
  }
  return scopes;
}
