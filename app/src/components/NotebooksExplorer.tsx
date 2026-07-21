import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Tooltip,
} from "@mui/material";
import {
  Download,
  Globe as GlobeIcon,
  Notebook as NotebookIcon,
  Plus,
  RefreshCw as RefreshIcon,
  Upload,
  User as UserIcon,
} from "lucide-react";

import ExplorerShell from "./ExplorerShell";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";
import { useWorkspace } from "../contexts/workspace-context";
import { useConsoleStore } from "../store/consoleStore";
import { useExplorerStore } from "../store/explorerStore";
import {
  useExplorerRevealStore,
  selectRevealFor,
} from "../store/explorerRevealStore";
import { useNotebookStore } from "../store/notebookStore";
import { useNotebookTreeStore } from "../store/notebookTreeStore";
import { focusNotebookTab } from "../notebook-runtime/shell";
import {
  blocksFromIpynb,
  nameFromIpynb,
  notebookToIpynb,
  type Ipynb,
} from "../notebook-runtime/ipynb";

const EMPTY_TREE: ResourceTreeNode[] = [];

export default function NotebooksExplorer() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const myNotebooks = useNotebookTreeStore(
    s => (workspaceId && s.myNotebooks[workspaceId]) || EMPTY_TREE,
  );
  const workspaceNotebooks = useNotebookTreeStore(
    s => (workspaceId && s.workspaceNotebooks[workspaceId]) || EMPTY_TREE,
  );
  const loading = useNotebookTreeStore(s =>
    workspaceId ? !!s.loading[workspaceId] : false,
  );
  const error = useNotebookTreeStore(s =>
    workspaceId ? s.error[workspaceId] || null : null,
  );
  const fetchTree = useNotebookTreeStore(s => s.fetchTree);
  const moveItem = useNotebookTreeStore(s => s.moveItem);
  const moveFolder = useNotebookTreeStore(s => s.moveFolder);
  const createFolder = useNotebookTreeStore(s => s.createFolder);
  const renameItem = useNotebookTreeStore(s => s.renameItem);
  const deleteItem = useNotebookTreeStore(s => s.deleteItem);
  const resortItem = useNotebookTreeStore(s => s.resortItem);

  const createNotebook = useNotebookStore(s => s.createNotebook);
  const getNotebook = useNotebookStore(s => s.getNotebook);
  const importNotebook = useNotebookStore(s => s.importNotebook);

  const notebookExpandedFolders = useExplorerStore(
    s => s.notebook.expandedFolders,
  );
  const toggleNotebookFolder = useExplorerStore(s => s.toggleNotebookFolder);
  const expandNotebookFolder = useExplorerStore(s => s.expandNotebookFolder);

  const isNotebookFolderExpanded = useCallback(
    (key: string) => !!notebookExpandedFolders[key],
    [notebookExpandedFolders],
  );

  const reveal = useExplorerRevealStore(selectRevealFor("notebooks"));

  const { activeTabId, tabs } = useConsoleStore();

  const [deleteTarget, setDeleteTarget] = useState<ResourceTreeNode | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (workspaceId) {
      void fetchTree(workspaceId);
    }
  }, [workspaceId, fetchTree]);

  const handleRefresh = useCallback(async () => {
    if (workspaceId) await fetchTree(workspaceId);
  }, [workspaceId, fetchTree]);

  const handleCreate = useCallback(async () => {
    const doc = await createNotebook();
    if (doc) {
      focusNotebookTab(doc.id, doc.name);
      if (workspaceId) void fetchTree(workspaceId);
    }
  }, [createNotebook, fetchTree, workspaceId]);

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const json = JSON.parse(await file.text()) as Ipynb;
      const fallback =
        file.name.replace(/\.ipynb$/i, "") || "Imported notebook";
      const doc = await importNotebook(
        nameFromIpynb(json, fallback),
        blocksFromIpynb(json),
      );
      if (doc) {
        focusNotebookTab(doc.id, doc.name);
        if (workspaceId) void fetchTree(workspaceId);
      }
    } catch {
      // Malformed file — ignore.
    }
  };

  const handleItemClick = useCallback((node: ResourceTreeNode) => {
    if (node.isDirectory) return;
    focusNotebookTab(node.id, node.name);
  }, []);

  const handleDuplicate = useCallback(
    async (node: ResourceTreeNode) => {
      const doc = await getNotebook(node.id);
      if (!doc) return;
      const copy = await importNotebook(
        `${doc.name} (copy)`,
        doc.blocks.map(b => ({ ...b, id: crypto.randomUUID() })),
      );
      if (copy) {
        focusNotebookTab(copy.id, copy.name);
        if (workspaceId) void fetchTree(workspaceId);
      }
    },
    [getNotebook, importNotebook, fetchTree, workspaceId],
  );

  const handleExport = useCallback(
    async (node: ResourceTreeNode) => {
      const doc = await getNotebook(node.id);
      if (!doc) return;
      const json = JSON.stringify(
        notebookToIpynb(doc.name, doc.blocks),
        null,
        2,
      );
      const url = URL.createObjectURL(
        new Blob([json], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `${doc.name || "notebook"}.ipynb`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [getNotebook],
  );

  const handleMoveItem = useCallback(
    (itemId: string, targetFolderId: string | null, access?: string) => {
      if (!workspaceId) return;
      void moveItem(
        workspaceId,
        itemId,
        targetFolderId,
        (access as "private" | "workspace") || undefined,
      );
    },
    [workspaceId, moveItem],
  );

  const handleMoveFolder = useCallback(
    (folderId: string, parentId: string | null, access?: string) => {
      if (!workspaceId) return;
      void moveFolder(
        workspaceId,
        folderId,
        parentId,
        (access as "private" | "workspace") || undefined,
      );
    },
    [workspaceId, moveFolder],
  );

  const handleRenameItem = useCallback(
    (itemId: string, name: string, isDirectory: boolean) => {
      if (!workspaceId) return;
      void renameItem(workspaceId, itemId, name, isDirectory);
    },
    [workspaceId, renameItem],
  );

  const handleDeleteItem = useCallback((node: ResourceTreeNode) => {
    setDeleteTarget(node);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget || !workspaceId) return;
    await deleteItem(workspaceId, deleteTarget.id, deleteTarget.isDirectory);
    setDeleteTarget(null);
  }, [deleteTarget, workspaceId, deleteItem]);

  const handleCreateFolder = useCallback(
    async (
      parentId: string | null,
      access?: string,
    ): Promise<{ id: string; name: string } | null> => {
      if (!workspaceId) return null;
      const id = await createFolder(
        workspaceId,
        "New Folder",
        parentId,
        (access as "private" | "workspace") || undefined,
      );
      return id ? { id, name: "New Folder" } : null;
    },
    [workspaceId, createFolder],
  );

  const handleResortItem = useCallback(
    (itemId: string) => {
      if (!workspaceId) return;
      resortItem(workspaceId, itemId);
    },
    [workspaceId, resortItem],
  );

  const sectionsDef = useMemo(
    () => [
      {
        key: "my",
        label: "My Notebooks",
        icon: <UserIcon size={16} strokeWidth={1.5} />,
        nodes: myNotebooks as ResourceTreeNode[],
        droppableId: "__section_my",
        defaultAccess: "private" as const,
      },
      {
        key: "workspace",
        label: "Workspace",
        icon: <GlobeIcon size={16} strokeWidth={1.5} />,
        nodes: workspaceNotebooks as ResourceTreeNode[],
        droppableId: "__section_workspace",
        defaultAccess: "workspace" as const,
      },
    ],
    [myNotebooks, workspaceNotebooks],
  );

  const activeNotebookTabId = (() => {
    if (!activeTabId) return null;
    const tab = tabs[activeTabId];
    if (tab?.kind === "notebook" && tab.metadata?.notebookId) {
      return tab.metadata.notebookId as string;
    }
    return null;
  })();

  const getItemIcon = useCallback(
    () => <NotebookIcon size={14} style={{ opacity: 0.75 }} />,
    [],
  );

  const actions = (
    <>
      <Tooltip title="Import .ipynb">
        <IconButton size="small" onClick={() => fileInputRef.current?.click()}>
          <Upload size={17} />
        </IconButton>
      </Tooltip>
      <Tooltip title="New notebook">
        <IconButton size="small" onClick={() => void handleCreate()}>
          <Plus size={18} />
        </IconButton>
      </Tooltip>
      {activeNotebookTabId && (
        <Tooltip title="Export active notebook as .ipynb">
          <IconButton
            size="small"
            onClick={() => {
              const node = [...myNotebooks, ...workspaceNotebooks]
                .flatMap(function walk(n): ResourceTreeNode[] {
                  if (!n.isDirectory) return [n as ResourceTreeNode];
                  return (n.children ?? []).flatMap(walk);
                })
                .find(n => n.id === activeNotebookTabId);
              if (node) void handleExport(node);
            }}
          >
            <Download size={17} />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip title="Refresh">
        <IconButton
          size="small"
          onClick={() => void handleRefresh()}
          disabled={loading}
        >
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </>
  );

  const isInitialLoading =
    loading && myNotebooks.length === 0 && workspaceNotebooks.length === 0;

  return (
    <>
      <ExplorerShell
        title="Notebooks"
        searchPlaceholder="Search notebooks..."
        loading={isInitialLoading}
        error={error}
        onErrorClose={() => {
          if (workspaceId) {
            useNotebookTreeStore.setState(state => {
              state.error[workspaceId] = null;
            });
          }
        }}
        actions={actions}
      >
        {({ searchQuery }) => (
          <ResourceTree
            sections={sectionsDef}
            mode="sidebar"
            searchQuery={searchQuery}
            activeItemId={activeNotebookTabId}
            revealNodeId={reveal?.nodeId}
            revealNonce={reveal?.nonce}
            getItemIcon={getItemIcon}
            enableDragDrop
            enableRename
            enableDuplicate
            enableDelete
            enableNewFolder
            onItemClick={handleItemClick}
            onMoveItem={handleMoveItem}
            onMoveFolder={handleMoveFolder}
            onRenameItem={handleRenameItem}
            onDeleteItem={handleDeleteItem}
            onDuplicateItem={handleDuplicate}
            onCreateFolder={handleCreateFolder}
            onResortItem={handleResortItem}
            isFolderExpanded={isNotebookFolderExpanded}
            onToggleFolder={toggleNotebookFolder}
            onExpandFolder={expandNotebookFolder}
            getFolderExpansionKey={node => node.id}
          />
        )}
      </ExplorerShell>

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogTitle>
          Delete {deleteTarget?.isDirectory ? "Folder" : "Notebook"}?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {deleteTarget?.isDirectory
              ? `"${deleteTarget.name}" and its subfolders will be deleted. Notebooks inside will move to the root level.`
              : `"${deleteTarget?.name}" will be permanently deleted. This cannot be undone.`}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="error" onClick={() => void handleDeleteConfirm()}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <input
        ref={fileInputRef}
        type="file"
        accept=".ipynb,application/json"
        style={{ display: "none" }}
        onChange={e => void handleImportFile(e)}
      />
    </>
  );
}
