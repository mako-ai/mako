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
