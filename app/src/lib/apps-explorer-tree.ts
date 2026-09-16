/**
 * The Apps explorer's trees, built from what the list endpoint says: the
 * folders of a tree root and the apps beneath it, nested by their repo
 * paths. Pure, so it is unit-tested; the explorer only decorates.
 *
 * Node ids: an app is its id (unchanged, so tabs and reveals keep working);
 * a real folder is `__folder__<repo path>`; an app's files keep the
 * `<appId>::dir::<path>` / `<appId>::file::<path>` scheme.
 */
import type { ResourceTreeNode } from "../components/ResourceTree";

export const FOLDER_NODE_PREFIX = "__folder__";
export const APP_FOLDER_ENTITY = "app-folder";

export const folderNodeId = (path: string) => `${FOLDER_NODE_PREFIX}${path}`;

/** The repo path behind a folder node, or `null` for any other row. */
export function folderPathFromNodeId(nodeId: string): string | null {
  return nodeId.startsWith(FOLDER_NODE_PREFIX)
    ? nodeId.slice(FOLDER_NODE_PREFIX.length)
    : null;
}

export interface TreeApp {
  id: string;
  title: string;
  path: string;
  access?: "private" | "workspace";
  owner_id?: string;
}

/** The parent folder path of a repo path (`apps/Sales/x` → `apps/Sales`). */
export function parentPathOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export const basenameOf = (path: string) => path.split("/").pop() ?? path;

/**
 * Build one tree. `root` is `apps` or `users/<id>/apps`; only folders and
 * apps under it are placed. A folder implied by an app's path but absent
 * from `folders` is still created (the list may lag a push by one sync).
 */
export function buildAppTree(input: {
  root: string;
  folders: readonly string[];
  apps: readonly TreeApp[];
  /** File children for an app row: `undefined` = not loaded yet (lazy). */
  appChildren?: (appId: string) => ResourceTreeNode[] | undefined;
}): ResourceTreeNode[] {
  const { root, folders, apps } = input;
  const under = (p: string) => p === root || p.startsWith(`${root}/`);
  const folderSet = new Set<string>();
  const addFolderChain = (path: string) => {
    let current = path;
    while (current && current !== root && under(current)) {
      folderSet.add(current);
      current = parentPathOf(current);
    }
  };
  for (const f of folders) if (under(f) && f !== root) addFolderChain(f);
  for (const app of apps) {
    if (under(app.path)) addFolderChain(parentPathOf(app.path));
  }

  const folderNodes = new Map<string, ResourceTreeNode>();
  for (const path of [...folderSet].sort()) {
    folderNodes.set(path, {
      id: folderNodeId(path),
      name: basenameOf(path),
      path,
      isDirectory: true,
      entityType: APP_FOLDER_ENTITY,
      children: [],
    });
  }
  const childrenOf = (path: string): ResourceTreeNode[] =>
    path === root ? rootChildren : (folderNodes.get(path)?.children ?? []);
  const rootChildren: ResourceTreeNode[] = [];
  for (const [path, node] of folderNodes) {
    childrenOf(parentPathOf(path)).push(node);
  }
  for (const app of apps) {
    if (!under(app.path)) continue;
    childrenOf(parentPathOf(app.path)).push({
      id: app.id,
      name: app.title,
      path: app.path,
      isDirectory: true,
      children: input.appChildren?.(app.id),
      ...(app.access ? { access: app.access } : {}),
      ...(app.owner_id ? { owner_id: app.owner_id } : {}),
    });
  }
  const sort = (nodes: ResourceTreeNode[]) => {
    nodes.sort((a, b) => {
      const af = a.entityType === APP_FOLDER_ENTITY;
      const bf = b.entityType === APP_FOLDER_ENTITY;
      if (af !== bf) return af ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    for (const n of nodes) {
      if (n.entityType === APP_FOLDER_ENTITY && n.children) sort(n.children);
    }
  };
  sort(rootChildren);
  return rootChildren;
}
