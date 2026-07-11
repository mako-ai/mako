import type { ResourceTreeNode } from "../components/ResourceTree";
import type { AppV2TreeEntry } from "../store/appV2Store";
import { APP_V2_DIR_SEP, APP_V2_FILE_SEP } from "../lib/explorer-reveal";

export function appV2ProjectIdFromRevealNodeId(nodeId: string): string | null {
  const separatorIndexes = [APP_V2_FILE_SEP, APP_V2_DIR_SEP]
    .map(separator => nodeId.indexOf(separator))
    .filter(index => index >= 0);
  if (separatorIndexes.length === 0) return null;
  return nodeId.slice(0, Math.min(...separatorIndexes)) || null;
}

export function appV2ProjectIdFromFileNodeId(nodeId: string): string | null {
  return nodeId.includes(APP_V2_FILE_SEP)
    ? appV2ProjectIdFromRevealNodeId(nodeId)
    : null;
}

export async function prepareAppV2Reveal(
  nodeId: string,
  actions: {
    ensureProject: (projectId: string) => Promise<unknown>;
    getOrCreateWorktree: (projectId: string) => Promise<unknown>;
    loadTree: (projectId: string) => Promise<unknown>;
  },
): Promise<string | null> {
  const projectId = appV2ProjectIdFromRevealNodeId(nodeId);
  if (!projectId) return null;
  await actions.ensureProject(projectId);
  const worktree = await actions.getOrCreateWorktree(projectId);
  if (!worktree) return null;
  await actions.loadTree(projectId);
  return projectId;
}

export function buildAppV2FileNodes(
  projectId: string,
  entries: readonly AppV2TreeEntry[],
): ResourceTreeNode[] {
  const root: ResourceTreeNode = {
    id: `${projectId}${APP_V2_DIR_SEP}`,
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  };

  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    let cursor = root;
    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join("/");
      const isFile = index === segments.length - 1;
      const id = isFile
        ? `${projectId}${APP_V2_FILE_SEP}${path}`
        : `${projectId}${APP_V2_DIR_SEP}${path}`;
      let child = cursor.children?.find(node => node.id === id);
      if (!child) {
        child = {
          id,
          name: segment,
          path,
          isDirectory: !isFile,
          entityType: isFile ? "app-v2-file" : "app-v2-directory",
          children: isFile ? undefined : [],
        };
        cursor.children?.push(child);
      }
      cursor = child;
    });
  }

  const sort = (nodes: ResourceTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children) sort(node.children);
    }
  };
  sort(root.children ?? []);
  return root.children ?? [];
}
