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
import { useResourceTreeExplorer } from "../hooks/useResourceTreeExplorer";
import { focusNotebookTab } from "../notebook-runtime/shell";
import {
  blocksFromIpynb,
  nameFromIpynb,
  notebookToIpynb,
  type Ipynb,
} from "../notebook-runtime/ipynb";
import { ConfirmDialog } from "./ConfirmDialog";
import { useAuth } from "../contexts/auth-context";
import {
  selectFavourites,
  starredRefs,
  useFavouritesStore,
} from "../store/favouritesStore";
import StarToggle from "./starred/StarToggle";
import {
  buildStarredSection,
  entityIdFromStarredRow,
  flattenLeafRows,
  realEntityId,
} from "./starred/starred-section";
import { useStarredTree } from "./starred/use-starred-tree";
import AccessIcon from "./AccessIcon";
import { resolveAccessState } from "./access-state";

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

  const { user } = useAuth();
  const userId = user?.id;
  // Starred notebooks: a star is a SHORTCUT. Notebooks already have real
  // shared folders their team created, so a starred notebook keeps its place
  // in the tree below and is also pinned on top, in this person's own
  // favourites folders.
  const favourites = useFavouritesStore(selectFavourites(workspaceId));
  const fetchFavourites = useFavouritesStore(s => s.fetch);
  const toggleFavourite = useFavouritesStore(s => s.toggle);
  const starred = useMemo(
    () => starredRefs(favourites, "notebook"),
    [favourites],
  );
  useEffect(() => {
    if (workspaceId) void fetchFavourites(workspaceId);
  }, [workspaceId, fetchFavourites]);
  const handleToggleStar = useCallback(
    (notebookId: string) => {
      if (!workspaceId) return;
      void toggleFavourite(
        workspaceId,
        "notebook",
        notebookId,
        !starred.has(notebookId),
      );
    },
    [workspaceId, toggleFavourite, starred],
  );
  const allNotebooks = useMemo(
    () => flattenLeafRows([...myNotebooks, ...workspaceNotebooks]),
    [myNotebooks, workspaceNotebooks],
  );

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

  const sectionsDef = useMemo(() => {
    const byId = new Map(allNotebooks.map(n => [n.id, n]));
    return [
      ...buildStarredSection(
        favourites,
        "notebook",
        refId => {
          const node = byId.get(refId);
          return node
            ? {
                name: node.name,
                path: node.path,
                access: node.access,
                owner_id: node.owner_id,
              }
            : undefined;
        },
        { droppable: true },
      ),
      ...tree.sections({ my: "My Notebooks" }),
    ];
  }, [favourites, allNotebooks, tree]);

  // Rows under Starred are views: their moves, renames and deletes go to
  // the favourites store, never to the notebook store (use-starred-tree.tsx).
  const starrable = useCallback(
    (id: string) => allNotebooks.some(n => n.id === id),
    [allNotebooks],
  );
  const { treeHandlers, handleSectionDrop, getSectionContextMenuItems } =
    useStarredTree({
      kind: "notebook",
      workspaceId,
      favourites,
      base: tree.treeHandlers,
      isStarrable: starrable,
      onToggleStar: handleToggleStar,
    });

  const getContextMenuItems = useCallback(
    (node: ResourceTreeNode, helpers: { closeMenu: () => void }) => {
      const pinnedId = entityIdFromStarredRow(node.id);
      // Only pinned rows get a bespoke menu; every other row keeps the
      // tree's own rename/duplicate/delete entries (Starred folders too).
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
    (node: ResourceTreeNode) => {
      if (node.isDirectory) return null;
      // Only a PINNED row carries the access overlay: it has left the section
      // that would otherwise say who can see it.
      if (entityIdFromStarredRow(node.id)) {
        return (
          <AccessIcon
            Glyph={NotebookIcon}
            state={resolveAccessState(node, userId)}
            kindLabel="Notebook"
            size={14}
          />
        );
      }
      return <NotebookIcon size={14} style={{ opacity: 0.75 }} />;
    },
    [userId],
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
            {...treeHandlers}
            onSectionDrop={handleSectionDrop}
            getSectionContextMenuItems={getSectionContextMenuItems}
            getContextMenuItems={getContextMenuItems}
            getRightAdornment={getRightAdornment}
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
