export interface ResourceTreeLikeNode {
  id: string;
  path: string;
  isDirectory: boolean;
  children?: ResourceTreeLikeNode[];
}

export interface ResourceTreeLikeSection<
  TNode extends ResourceTreeLikeNode = ResourceTreeLikeNode,
> {
  key: string;
  nodes: TNode[];
  droppableId?: string;
  defaultAccess?: string;
  /**
   * Items listed here are not this person's to place (consoles' "Shared
   * with me": another member's, in a folder of theirs): no "Move to…",
   * no drag out.
   */
  noMoveOut?: boolean;
}

export interface ResourceTreeNodeLocation<
  TNode extends ResourceTreeLikeNode = ResourceTreeLikeNode,
> {
  node: TNode;
  sectionKey: string;
}

export type ResourceTreeDropResolution =
  | {
      kind: "section";
      targetFolderId: null;
      sectionKey: string;
      access?: string;
    }
  | {
      kind: "folder";
      targetFolderId: string;
      sectionKey: string;
    }
  | null;

export const getFolderDropTargetId = (folderId: string) =>
  `__folder_content_${folderId}`;

/**
 * Whether a sidebar tree row should render with the "active entity" highlight
 * (i.e. its tab is the focused one).
 *
 * REGRESSION GUARD: this is the single source of truth for the sidebar
 * active-row highlight and MUST be applied to BOTH folder and file rows in
 * `ResourceTree`. Several entities open from a *directory* row — an app, a
 * Postgres table/view (its caret browses the schema while its name opens the
 * data tab) — so if folder rows skip this check, an open app/table leaves its
 * sidebar row un-highlighted. A previous regression did exactly that for apps.
 * See `ResourceTree.tsx` and `ResourceTree.highlight.test.ts`.
 */
export function isSidebarRowActive(options: {
  mode: "sidebar" | "picker";
  activeItemId: string | null | undefined;
  nodeId: string;
}): boolean {
  return (
    options.mode === "sidebar" &&
    !!options.activeItemId &&
    options.activeItemId === options.nodeId
  );
}

export function findNodeById<TNode extends ResourceTreeLikeNode>(
  nodes: TNode[],
  id: string,
): TNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.isDirectory && node.children) {
      const found = findNodeById(node.children as TNode[], id);
      if (found) return found;
    }
  }
  return null;
}

export function findNodeInSections<TNode extends ResourceTreeLikeNode>(
  sections: ResourceTreeLikeSection<TNode>[],
  id: string,
): ResourceTreeNodeLocation<TNode> | null {
  for (const section of sections) {
    const node = findNodeById(section.nodes, id);
    if (node) {
      return { node, sectionKey: section.key };
    }
  }
  return null;
}

/**
 * Whether the node `id` may be moved from where it is listed: anywhere but
 * a `noMoveOut` section (an admin's "Move Here" from "Shared with me" took
 * the owner's console out of the owner's folder, unasked).
 */
export function canMoveFromSection<TNode extends ResourceTreeLikeNode>(
  sections: ResourceTreeLikeSection<TNode>[],
  id: string,
): boolean {
  const location = findNodeInSections(sections, id);
  if (!location) return false;
  const section = sections.find(s => s.key === location.sectionKey);
  return !section?.noMoveOut;
}

export function findAncestorPaths<TNode extends ResourceTreeLikeNode>(
  nodes: TNode[],
  targetId: string,
  ancestors: string[] = [],
  getExpansionKey: (node: TNode) => string = node => node.id,
): string[] {
  for (const node of nodes) {
    if (node.id === targetId) return ancestors;
    if (node.isDirectory && node.children) {
      const found = findAncestorPaths(
        node.children as TNode[],
        targetId,
        [...ancestors, getExpansionKey(node)],
        getExpansionKey,
      );
      if (
        found.length > 0 ||
        node.children.some(child => child.id === targetId)
      ) {
        return found;
      }
    }
  }
  return [];
}

export function flattenVisibleNodeIds<TNode extends ResourceTreeLikeNode>(
  sections: ResourceTreeLikeSection<TNode>[],
  options: {
    showFiles: boolean;
    isFolderExpanded: (expansionKey: string) => boolean;
    sectionExpanded: Record<string, boolean>;
    getExpansionKey?: (node: TNode) => string;
  },
): string[] {
  const ids: string[] = [];
  const getExpansionKey = options.getExpansionKey ?? ((node: TNode) => node.id);

  const collect = (nodes: TNode[], sectionVisible: boolean) => {
    if (!sectionVisible) return;
    for (const node of nodes) {
      if (!options.showFiles && !node.isDirectory) continue;
      ids.push(node.id);
      if (
        node.isDirectory &&
        node.children &&
        options.isFolderExpanded(getExpansionKey(node))
      ) {
        collect(node.children as TNode[], true);
      }
    }
  };

  for (const section of sections) {
    collect(section.nodes, options.sectionExpanded[section.key] !== false);
  }

  return ids;
}

export function resolveTreeDropTarget<TNode extends ResourceTreeLikeNode>(
  sections: ResourceTreeLikeSection<TNode>[],
  overId: string,
): ResourceTreeDropResolution {
  for (const section of sections) {
    if (overId === section.droppableId) {
      return {
        kind: "section",
        targetFolderId: null,
        sectionKey: section.key,
        access: section.defaultAccess,
      };
    }
  }

  if (overId.startsWith("__folder_content_")) {
    const folderId = overId.replace("__folder_content_", "");
    const location = findNodeInSections(sections, folderId);
    if (!location) return null;
    return {
      kind: "folder",
      targetFolderId: folderId,
      sectionKey: location.sectionKey,
    };
  }

  const location = findNodeInSections(sections, overId);
  if (location?.node.isDirectory) {
    return {
      kind: "folder",
      targetFolderId: overId,
      sectionKey: location.sectionKey,
    };
  }

  return null;
}

/**
 * dnd-kit's drag attributes for a row. A row that cannot be DRAGGED (a
 * console shared with this person, someone else's folder) still opens,
 * renames and has a menu: dnd-kit's `aria-disabled="true"` told assistive
 * tech the whole row was disabled, and its "draggable" role description
 * and drag instructions described a gesture the row does not have.
 */
export function dragAttributes<A extends object>(
  attributes: A,
  disabled: boolean | undefined,
): Partial<A> {
  if (!disabled) return attributes;
  const rest = { ...attributes } as Record<string, unknown>;
  delete rest["aria-disabled"];
  delete rest["aria-roledescription"];
  delete rest["aria-describedby"];
  return rest as Partial<A>;
}
