/**
 * Generic tree mutation helpers for immer-based stores.
 *
 * Every helper expects a node interface with at least:
 *   { id?: string; name: string; isDirectory: boolean; children?: T[] }
 *
 * Used by both consoleTreeStore and dashboardTreeStore.
 */

export interface ManagedTreeNode {
  id?: string;
  name: string;
  isDirectory: boolean;
  children?: ManagedTreeNode[];
}

export type TreeNode = ManagedTreeNode;

export function findTargetArray<T extends ManagedTreeNode>(
  nodes: T[],
  remainingSegments: string[],
): T[] | null {
  if (remainingSegments.length === 0) return nodes;
  const folderName = remainingSegments[0];
  const folder = nodes.find(
    node => node.isDirectory && node.name === folderName,
  );
  if (!folder) return null;
  if (!folder.children) folder.children = [];
  return findTargetArray(folder.children as T[], remainingSegments.slice(1));
}

export function removeById<T extends ManagedTreeNode>(
  nodes: T[],
  targetId: string,
): T | null {
  const index = nodes.findIndex(item => item.id === targetId);
  if (index !== -1) return nodes.splice(index, 1)[0];
  for (const node of nodes) {
    if (node.isDirectory && node.children) {
      const removed = removeById(node.children as T[], targetId);
      if (removed) return removed as T;
    }
  }
  return null;
}

export function insertAlphabetically<T extends ManagedTreeNode>(
  nodes: T[],
  entry: T,
): void {
  let insertIndex = nodes.length;
  for (let i = 0; i < nodes.length; i++) {
    const item = nodes[i];
    if (entry.isDirectory && !item.isDirectory) {
      insertIndex = i;
      break;
    }
    if (entry.isDirectory === item.isDirectory) {
      if (entry.name.toLowerCase() < item.name.toLowerCase()) {
        insertIndex = i;
        break;
      }
    }
  }
  nodes.splice(insertIndex, 0, entry);
}

export function insertAtTop<T extends ManagedTreeNode>(
  nodes: T[],
  entry: T,
): void {
  nodes.unshift(entry);
}

export function findById<T extends ManagedTreeNode>(
  nodes: T[],
  targetId: string,
): T | null {
  for (const node of nodes) {
    if (node.id === targetId) return node;
    if (node.isDirectory && node.children) {
      const found = findById(node.children as T[], targetId);
      if (found) return found as T;
    }
  }
  return null;
}

export function findParentArray<T extends ManagedTreeNode>(
  nodes: T[],
  targetId: string,
): T[] | null {
  if (nodes.some(n => n.id === targetId)) return nodes;
  for (const node of nodes) {
    if (node.isDirectory && node.children) {
      const found = findParentArray(node.children as T[], targetId);
      if (found) return found as T[];
    }
  }
  return null;
}

/**
 * Client-side filter: case-insensitive match on node name.
 * Folders pass if their name matches or any descendant matches.
 */
export interface FilterTreeOptions {
  includeMatchingFolders?: boolean;
}

export function filterTree<T extends ManagedTreeNode>(
  nodes: T[],
  query: string,
  options: FilterTreeOptions = {},
): T[] {
  const lower = query.toLowerCase();
  const includeMatchingFolders = options.includeMatchingFolders ?? true;
  const result: T[] = [];
  for (const node of nodes) {
    if (node.isDirectory && node.children) {
      const filteredChildren = filterTree(node.children as T[], query, options);
      if (
        filteredChildren.length > 0 ||
        (includeMatchingFolders && node.name.toLowerCase().includes(lower))
      ) {
        result.push({ ...node, children: filteredChildren } as T);
      }
    } else if (node.isDirectory && includeMatchingFolders) {
      if (node.name.toLowerCase().includes(lower)) {
        result.push({ ...node, children: [] } as T);
      }
    } else if (node.name.toLowerCase().includes(lower)) {
      result.push(node);
    }
  }
  return result;
}

/** Count all non-directory items in a tree (recursive) */
export function countItems<T extends ManagedTreeNode>(nodes: T[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.isDirectory && node.children) {
      count += countItems(node.children as T[]);
    } else if (!node.isDirectory) {
      count += 1;
    }
  }
  return count;
}
