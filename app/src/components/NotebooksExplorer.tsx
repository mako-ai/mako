import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ChangeEvent,
} from "react";
import { IconButton, ListItemIcon, MenuItem, Tooltip } from "@mui/material";
import {
  Download,
  Notebook as NotebookIcon,
  Plus,
  RefreshCw as RefreshIcon,
  Star as StarIcon,
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
import {
  NOTEBOOK_FOLDER_KIND,
  selectPersonalFolders,
  usePersonalFoldersStore,
} from "../store/personalFoldersStore";
import StarToggle from "./starred/StarToggle";
import {
  buildStarredSection,
  entityIdFromStarredRow,
  flattenLeafRows,
  realEntityId,
  starredKeys,
} from "./starred/starred-section";
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

  // Starred notebooks. Unlike apps, a star here is a SHORTCUT: notebooks
  // already have real shared folders their team created, so a starred
  // notebook keeps its place in the tree below and is also pinned on top.
  const personalFolders = usePersonalFoldersStore(
    selectPersonalFolders(workspaceId, NOTEBOOK_FOLDER_KIND),
  );
  const fetchFolders = usePersonalFoldersStore(s => s.fetchFolders);
  const toggleStar = usePersonalFoldersStore(s => s.toggleStar);
  const starred = useMemo(
    () => starredKeys(personalFolders),
    [personalFolders],
  );

  useEffect(() => {
    if (workspaceId) void fetchFolders(workspaceId, NOTEBOOK_FOLDER_KIND);
  }, [workspaceId, fetchFolders]);

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

  const allNotebooks = useMemo(
    () => flattenLeafRows([...myNotebooks, ...workspaceNotebooks]),
    [myNotebooks, workspaceNotebooks],
  );

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
    // A pinned row points at the same notebook as its real row below.
    focusNotebookTab(realEntityId(node.id), node.name);
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

  const handleToggleStar = useCallback(
    (notebookId: string) => {
      if (!workspaceId) return;
      void toggleStar(
        workspaceId,
        notebookId,
        !starred.has(notebookId),
        NOTEBOOK_FOLDER_KIND,
      );
    },
    [workspaceId, toggleStar, starred],
  );

  const sectionsDef = useMemo(() => {
    const byId = new Map(allNotebooks.map(n => [n.id, n]));
    return [
      ...buildStarredSection(personalFolders, key => {
        const node = byId.get(key);
        return node ? { name: node.name, path: node.path } : undefined;
      }),
      ...tree.sections({ my: "My Notebooks" }),
    ];
  }, [personalFolders, allNotebooks, tree]);

  /**
   * A pinned row is a view of a notebook, not a row the tree owns: moving,
   * renaming or deleting one would act on an id no store knows. The context
   * menu below never offers those on a pinned row, and these guards make the
   * drag path safe too.
   */
  const treeHandlers = useMemo(() => {
    const { onMoveItem, onMoveFolder, onRenameItem, onDeleteItem, ...rest } =
      tree.treeHandlers;
    const isPinned = (id: string) => entityIdFromStarredRow(id) !== null;
    return {
      ...rest,
      onMoveItem: (id: string, folderId: string | null, access?: string) => {
        if (!isPinned(id)) onMoveItem(id, folderId, access);
      },
      onMoveFolder: (id: string, parentId: string | null, access?: string) => {
        if (!isPinned(id)) onMoveFolder(id, parentId, access);
      },
      onRenameItem: (id: string, name: string, isDirectory: boolean) => {
        if (!isPinned(id)) onRenameItem(id, name, isDirectory);
      },
      onDeleteItem: (node: ResourceTreeNode) => {
        if (!isPinned(node.id)) onDeleteItem(node);
      },
    };
  }, [tree.treeHandlers]);

  const getContextMenuItems = useCallback(
    (node: ResourceTreeNode, helpers: { closeMenu: () => void }) => {
      const pinnedId = entityIdFromStarredRow(node.id);
      // Only the pinned rows get a bespoke menu; everything else keeps the
      // tree's own rename/duplicate/delete entries.
      if (!pinnedId) return null;
      return [
        <MenuItem
          key="unstar"
          onClick={() => {
            helpers.closeMenu();
            handleToggleStar(pinnedId);
          }}
        >
          <ListItemIcon>
            <StarIcon size={16} fill="currentColor" />
          </ListItemIcon>
          Unstar
        </MenuItem>,
      ];
    },
    [handleToggleStar],
  );

  const getRightAdornment = useCallback(
    (node: ResourceTreeNode) => {
      if (node.isDirectory) return null;
      const notebookId = realEntityId(node.id);
      return (
        <StarToggle
          starred={starred.has(notebookId)}
          onToggle={() => handleToggleStar(notebookId)}
        />
      );
    },
    [starred, handleToggleStar],
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
              const node = allNotebooks.find(n => n.id === activeNotebookTabId);
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
            getRightAdornment={getRightAdornment}
            getContextMenuItems={getContextMenuItems}
            enableDragDrop
            enableRename
            enableDuplicate
            enableDelete
            enableNewFolder
            onItemClick={handleItemClick}
            {...treeHandlers}
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
