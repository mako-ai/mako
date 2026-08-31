/**
 * The explorer half of a foldered resource — what every explorer used to
 * re-implement above its <ResourceTree>: select the two sections for the
 * current workspace, fetch on workspace change, the loading/error flags,
 * the "delete this node?" state, and the move / rename / create-folder /
 * delete / resort handlers that just forward to the store. Notebooks and
 * dashboards had these blocks line-for-line; consoles and apps had their
 * own variants. With createResourceTreeStore owning the store side, an
 * explorer is now its kind-specific bits (create, click, icons, extra
 * dialogs) on top of this hook.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { StoreApi, UseBoundStore } from "zustand";
import { Globe as GlobeIcon, User as UserIcon } from "lucide-react";
import type {
  ResourceTreeEntry,
  ResourceTreeState,
  TreeAccessLevel,
} from "../store/lib/createResourceTreeStore";
import type {
  ResourceTreeNode,
  ResourceTreeSection,
} from "../components/ResourceTree";

const EMPTY: ResourceTreeNode[] = [];

type TreeStore<T extends ResourceTreeEntry> = UseBoundStore<
  StoreApi<ResourceTreeState<T>>
>;

export function useResourceTreeExplorer<T extends ResourceTreeEntry>(
  store: TreeStore<T>,
  workspaceId: string | undefined,
  options: {
    /**
     * Whether a node that renders as a directory is a real folder for the
     * store (dashboards render as folders holding their data sources, but
     * are items). Default: the node's own `isDirectory`.
     */
    isFolder?: (id: string, isDirectory: boolean) => boolean;
  } = {},
) {
  const isFolderOption = options.isFolder;
  const isFolder = useMemo(
    () => isFolderOption ?? ((_id: string, d: boolean) => d),
    [isFolderOption],
  );

  const myItems = store(s =>
    workspaceId
      ? ((s.myItems[workspaceId] as ResourceTreeNode[]) ?? EMPTY)
      : EMPTY,
  );
  const workspaceItems = store(s =>
    workspaceId
      ? ((s.workspaceItems[workspaceId] as ResourceTreeNode[]) ?? EMPTY)
      : EMPTY,
  );
  const loading = store(s => (workspaceId ? !!s.loading[workspaceId] : false));
  const error = store(s => (workspaceId ? s.error[workspaceId] || null : null));
  const fetchTree = store(s => s.fetchTree);
  const moveItem = store(s => s.moveItem);
  const moveFolder = store(s => s.moveFolder);
  const createFolder = store(s => s.createFolder);
  const renameItem = store(s => s.renameItem);
  const deleteItem = store(s => s.deleteItem);
  const resortItem = store(s => s.resortItem);

  useEffect(() => {
    if (workspaceId) void fetchTree(workspaceId);
  }, [workspaceId, fetchTree]);

  const refresh = useCallback(async () => {
    if (workspaceId) await fetchTree(workspaceId);
  }, [workspaceId, fetchTree]);

  const clearError = useCallback(() => {
    if (!workspaceId) return;
    store.setState(state => ({
      error: { ...state.error, [workspaceId]: null },
    }));
  }, [store, workspaceId]);

  const [deleteTarget, setDeleteTarget] = useState<ResourceTreeNode | null>(
    null,
  );
  const requestDelete = useCallback(
    (node: ResourceTreeNode) => setDeleteTarget(node),
    [],
  );
  const cancelDelete = useCallback(() => setDeleteTarget(null), []);
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget || !workspaceId) return;
    await deleteItem(
      workspaceId,
      deleteTarget.id,
      isFolder(deleteTarget.id, deleteTarget.isDirectory),
    );
    setDeleteTarget(null);
  }, [deleteTarget, workspaceId, deleteItem, isFolder]);

  const access = (a?: string) => (a as TreeAccessLevel) || undefined;

  const onMoveItem = useCallback(
    (itemId: string, targetFolderId: string | null, a?: string) => {
      if (!workspaceId) return;
      void moveItem(workspaceId, itemId, targetFolderId, access(a));
    },
    [workspaceId, moveItem],
  );
  const onMoveFolder = useCallback(
    (folderId: string, parentId: string | null, a?: string) => {
      if (!workspaceId) return;
      // A node that only LOOKS like a folder moves as an item.
      if (!isFolder(folderId, true)) {
        void moveItem(workspaceId, folderId, parentId, access(a));
        return;
      }
      void moveFolder(workspaceId, folderId, parentId, access(a));
    },
    [workspaceId, isFolder, moveItem, moveFolder],
  );
  const onRenameItem = useCallback(
    (id: string, name: string, isDirectory: boolean) => {
      if (!workspaceId) return;
      void renameItem(workspaceId, id, name, isFolder(id, isDirectory));
    },
    [workspaceId, renameItem, isFolder],
  );
  const onCreateFolder = useCallback(
    async (
      parentId: string | null,
      a?: string,
    ): Promise<{ id: string; name: string } | null> => {
      if (!workspaceId) return null;
      const id = await createFolder(
        workspaceId,
        "New Folder",
        parentId,
        access(a),
      );
      return id ? { id, name: "New Folder" } : null;
    },
    [workspaceId, createFolder],
  );
  const onResortItem = useCallback(
    (id: string) => {
      if (workspaceId) resortItem(workspaceId, id);
    },
    [workspaceId, resortItem],
  );

  const treeHandlers = useMemo(
    () => ({
      onMoveItem,
      onMoveFolder,
      onRenameItem,
      onDeleteItem: requestDelete,
      onCreateFolder,
      onResortItem,
    }),
    [
      onMoveItem,
      onMoveFolder,
      onRenameItem,
      requestDelete,
      onCreateFolder,
      onResortItem,
    ],
  );

  /** The two standard sections; `mapNodes` decorates each section's tree. */
  const sections = useCallback(
    (
      labels: { my: string; workspace?: string },
      mapNodes: (nodes: ResourceTreeNode[]) => ResourceTreeNode[] = n => n,
    ): ResourceTreeSection[] => [
      {
        key: "my",
        label: labels.my,
        icon: <UserIcon size={16} strokeWidth={1.5} />,
        nodes: mapNodes(myItems),
        droppableId: "__section_my",
        defaultAccess: "private" as const,
      },
      {
        key: "workspace",
        label: labels.workspace ?? "Workspace",
        icon: <GlobeIcon size={16} strokeWidth={1.5} />,
        nodes: mapNodes(workspaceItems),
        droppableId: "__section_workspace",
        defaultAccess: "workspace" as const,
      },
    ],
    [myItems, workspaceItems],
  );

  return {
    myItems,
    workspaceItems,
    loading,
    error,
    clearError,
    isInitialLoading:
      loading && myItems.length === 0 && workspaceItems.length === 0,
    fetchTree,
    refresh,
    deleteTarget,
    requestDelete,
    cancelDelete,
    confirmDelete,
    treeHandlers,
    sections,
  };
}
