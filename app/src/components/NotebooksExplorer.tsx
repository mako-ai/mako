import { useCallback, useRef, type ChangeEvent } from "react";
import { IconButton, Tooltip } from "@mui/material";
import {
  Download,
  Notebook as NotebookIcon,
  Plus,
  RefreshCw as RefreshIcon,
  Upload,
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
import { useResourceTreeExplorer } from "../hooks/useResourceTreeExplorer";
import { focusNotebookTab } from "../notebook-runtime/shell";
import {
  blocksFromIpynb,
  nameFromIpynb,
  notebookToIpynb,
  type Ipynb,
} from "../notebook-runtime/ipynb";
import { ConfirmDialog } from "./ConfirmDialog";

export default function NotebooksExplorer() {
  const { currentWorkspace } = useWorkspace();
  const workspaceId = currentWorkspace?.id;

  const tree = useResourceTreeExplorer(useNotebookTreeStore, workspaceId);
  const {
    myItems: myNotebooks,
    workspaceItems: workspaceNotebooks,
    loading,
    fetchTree,
  } = tree;

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

  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const sectionsDef = tree.sections({ my: "My Notebooks" });

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
          onClick={() => void tree.refresh()}
          disabled={loading}
        >
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </>
  );

  return (
    <>
      <ExplorerShell
        title="Notebooks"
        searchPlaceholder="Search notebooks..."
        loading={tree.isInitialLoading}
        error={tree.error}
        onErrorClose={tree.clearError}
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
            {...tree.treeHandlers}
            onDuplicateItem={handleDuplicate}
            isFolderExpanded={isNotebookFolderExpanded}
            onToggleFolder={toggleNotebookFolder}
            onExpandFolder={expandNotebookFolder}
            getFolderExpansionKey={node => node.id}
          />
        )}
      </ExplorerShell>

      <ConfirmDialog
        open={!!tree.deleteTarget}
        title={`Delete ${tree.deleteTarget?.isDirectory ? "Folder" : "Notebook"}?`}
        body={
          tree.deleteTarget?.isDirectory
            ? `"${tree.deleteTarget.name}" and its subfolders will be deleted. Notebooks inside will move to the root level.`
            : `"${tree.deleteTarget?.name}" will be permanently deleted. This cannot be undone.`
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => void tree.confirmDelete()}
        onCancel={tree.cancelDelete}
      />

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
