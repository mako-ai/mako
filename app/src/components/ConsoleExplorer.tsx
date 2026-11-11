import {
  useState,
  forwardRef,
  useImperativeHandle,
  useRef,
  useCallback,
  useEffect,
} from "react";
import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  IconButton,
  Skeleton,
  Menu,
  MenuItem,
  Snackbar,
  Button,
  Tooltip,
} from "@mui/material";
import {
  SquareTerminal as ConsoleIcon,
  RotateCw as RefreshIcon,
  Plus as AddIcon,
  FolderPlus as CreateFolderIcon,
} from "lucide-react";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useConsoleTreeStore,
  type ConsoleEntry,
  type ConsoleSearchResult,
} from "../store/consoleTreeStore";
import { useConsoleStore } from "../store/consoleStore";
import { useConsoleContentStore } from "../store/consoleContentStore";
import { filterTree } from "../store/lib/tree-helpers";
import { closeTabsOf } from "../lib/console-tab-location";
import {
  consoleRestoredNotice,
  deniedActionNotice,
  folderDeleteConfirmText,
  folderRestoredNotice,
  trashedNotice,
  type TrashedFolder,
} from "../lib/console-trash";
import { useResourceTreeExplorer } from "../hooks/useResourceTreeExplorer";
import FileExplorerDialog from "./FileExplorerDialog";
import ConsoleInfoModal from "./ConsoleInfoModal";
import FolderInfoModal from "./FolderInfoModal";
import ConsoleTree from "./ConsoleTree";
import ExplorerShell from "./ExplorerShell";
import { ConfirmDialog } from "./ConfirmDialog";

/** How long "Moved to trash — Undo" stays (also after the pointer leaves it). */
const UNDO_TOAST_MS = 10_000;

interface ConsoleExplorerProps {
  onConsoleSelect: (
    path: string,
    content: string,
    connectionId?: string,
    consoleId?: string,
    isPlaceholder?: boolean,
    databaseId?: string,
    databaseName?: string,
  ) => void;
}

export interface ConsoleExplorerRef {
  refresh: () => void;
}

function ConsoleExplorer(
  props: ConsoleExplorerProps,
  ref: React.Ref<ConsoleExplorerRef>,
) {
  const { onConsoleSelect } = props;
  const { currentWorkspace } = useWorkspace();

  // The console tree is preloaded by workspace-context (so it is ready for
  // optimistic addConsole calls before this explorer mounts) — no autoFetch.
  const tree = useResourceTreeExplorer(
    useConsoleTreeStore,
    currentWorkspace?.id,
    { autoFetch: false },
  );
  const {
    myItems: myConsoles,
    workspaceItems: sharedWithWorkspace,
    loading,
    error,
  } = tree;
  const moveConsole = useConsoleTreeStore(state => state.moveConsole);
  const moveFolder = useConsoleTreeStore(state => state.moveFolder);
  const deleteItem = useConsoleTreeStore(state => state.deleteItem);
  const searchConsoles = useConsoleTreeStore(state => state.searchConsoles);
  const clearSearch = useConsoleTreeStore(state => state.clearSearch);
  const searchResults = useConsoleTreeStore(state => state.searchResults);
  const searchLoading = useConsoleTreeStore(state => state.searchLoading);
  const updateTabFilePath = useConsoleStore(state => state.updateFilePath);
  const updateTabTitle = useConsoleStore(state => state.updateTitle);
  const updateTabAccess = useConsoleStore(state => state.updateAccess);

  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [explorerDialogOpen, setExplorerDialogOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ConsoleEntry | null>(null);
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [infoConsoleId, setInfoConsoleId] = useState<string>("");
  const [folderInfoOpen, setFolderInfoOpen] = useState(false);
  const [folderInfoItem, setFolderInfoItem] = useState<ConsoleEntry | null>(
    null,
  );

  // Why the last rename, move or delete was refused (the server's words),
  // and what the last action did when the tree alone does not say it (a
  // name saved with a stand-in, a restore).
  const workspaceId = currentWorkspace?.id;
  const actionError = useConsoleTreeStore(state =>
    workspaceId ? (state.actionError[workspaceId] ?? null) : null,
  );
  const clearActionError = useConsoleTreeStore(state => state.clearActionError);
  const actionNotice = useConsoleTreeStore(state =>
    workspaceId ? (state.actionNotice[workspaceId] ?? null) : null,
  );
  const clearActionNotice = useConsoleTreeStore(
    state => state.clearActionNotice,
  );
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!actionNotice || !workspaceId) return;
    setNotice(actionNotice);
    clearActionNotice(workspaceId);
  }, [actionNotice, workspaceId, clearActionNotice]);

  interface UndoEntry {
    id: string;
    name: string;
    /** A folder: what its delete moved to the trash, and where it was. */
    folder?: TrashedFolder;
    parentId?: string | null;
    section?: "my" | "workspace";
  }
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  // "Moved to trash" with its Undo, after every delete. The trash has no
  // view: this Undo (and Ctrl+Z in the tree) is the way back.
  const [trashToast, setTrashToast] = useState<UndoEntry | null>(null);

  const collectIds = (nodes: ConsoleEntry[]): Set<string> => {
    const ids = new Set<string>();
    for (const node of nodes) {
      ids.add(node.id);
      if (node.isDirectory && node.children) {
        for (const id of collectIds(node.children)) ids.add(id);
      }
    }
    return ids;
  };

  useImperativeHandle(ref, () => ({
    refresh: () => {
      void tree.refresh();
    },
  }));

  const handleSearchChange = useCallback(
    (value: string) => {
      if (value.length < 2) {
        clearSearch();
        return;
      }
      if (currentWorkspace) {
        searchConsoles(currentWorkspace.id, value);
      }
    },
    [clearSearch, currentWorkspace, searchConsoles],
  );

  const handleSearchResultClick = (result: ConsoleSearchResult) => {
    onConsoleSelect(
      result.title,
      "loading...",
      undefined,
      result.id,
      true,
      undefined,
      result.databaseName,
    );

    (async () => {
      if (!currentWorkspace) return;
      try {
        const consoleStore = await import("../store/consoleStore");
        const {
          fetchConsoleContent,
          updateContent,
          updateConnection,
          updateDatabase,
          updateSavedState,
        } = consoleStore.useConsoleStore.getState();
        const data = await fetchConsoleContent(currentWorkspace.id, result.id);
        if (data) {
          useConsoleContentStore.getState().set(result.id, {
            content: data.content,
            connectionId: data.connectionId,
            databaseId: data.databaseId,
            databaseName: data.databaseName,
          });
          updateContent(result.id, data.content);
          if (data.connectionId) updateConnection(result.id, data.connectionId);
          if (data.databaseId || data.databaseName) {
            updateDatabase(result.id, data.databaseId, data.databaseName);
          }
          const { computeConsoleStateHash } =
            await import("../utils/stateHash");
          const savedStateHash =
            data.savedStateHash ??
            (data.lastDraftOrigin === "agent"
              ? undefined
              : computeConsoleStateHash(
                  data.content,
                  data.connectionId,
                  data.databaseId,
                  data.databaseName,
                ));
          updateSavedState(result.id, true, savedStateHash);
        }
      } catch (e) {
        console.error("Failed to load search result console", e);
      }
    })();
  };

  const handleFileOpen = useCallback(
    async (node: ConsoleEntry) => {
      if (!currentWorkspace) return;
      if (!node.id) return;

      const consoleId = node.id;
      const cached = useConsoleContentStore.getState().get(consoleId);
      const initialContent = cached?.content ?? "loading...";
      const connectionId = cached?.connectionId || node.connectionId;
      const databaseId = cached?.databaseId || node.databaseId;
      const databaseName = cached?.databaseName || node.databaseName;
      onConsoleSelect(
        node.path,
        initialContent,
        connectionId,
        consoleId,
        !cached,
        databaseId,
        databaseName,
      );

      try {
        const consoleStore = await import("../store/consoleStore");
        const { fetchConsoleContent } = consoleStore.useConsoleStore.getState();
        const data = await fetchConsoleContent(currentWorkspace.id, consoleId);
        if (data) {
          useConsoleContentStore.getState().set(consoleId, {
            content: data.content,
            connectionId: data.connectionId || node.connectionId,
            databaseId: data.databaseId || node.databaseId,
            databaseName: data.databaseName || node.databaseName,
          });
          const {
            updateContent,
            updateFilePath,
            updateDatabase,
            updateConnection,
            updateSavedState,
          } = consoleStore.useConsoleStore.getState();
          updateContent(consoleId, data.content);

          if (data.connectionId) {
            updateConnection(consoleId, data.connectionId);
          }
          if (data.databaseId || data.databaseName) {
            updateDatabase(consoleId, data.databaseId, data.databaseName);
          }

          updateFilePath(consoleId, node.path);

          const { computeConsoleStateHash } =
            await import("../utils/stateHash");
          const savedStateHash =
            data.savedStateHash ??
            (data.lastDraftOrigin === "agent"
              ? undefined
              : computeConsoleStateHash(
                  data.content,
                  data.connectionId,
                  data.databaseId,
                  data.databaseName,
                ));
          updateSavedState(consoleId, true, savedStateHash);
        }
      } catch (e) {
        console.error("Background fetch failed", e);
      }
    },
    [currentWorkspace, onConsoleSelect],
  );

  const handleMenuOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
    setMenuAnchor(event.currentTarget);
  };

  const handleMenuClose = () => {
    setMenuAnchor(null);
  };

  const handleCreateFolder = () => {
    handleMenuClose();
    treeRef.current?.createFolder(null, "private");
  };

  const findParentFolderId = (
    nodes: ConsoleEntry[],
    targetId: string,
    parentId: string | null = null,
  ): string | null | undefined => {
    for (const node of nodes) {
      if (node.id === targetId) return parentId;
      if (node.isDirectory && node.children) {
        const found = findParentFolderId(
          node.children,
          targetId,
          node.id ?? null,
        );
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };

  const getParentFolderIdForItem = (item: ConsoleEntry): string | null => {
    if (!item.id) return null;
    const inMy = findParentFolderId(myConsoles, item.id);
    if (inMy !== undefined) return inMy;
    const inWorkspace = findParentFolderId(sharedWithWorkspace, item.id);
    if (inWorkspace !== undefined) return inWorkspace;
    return null;
  };

  const getSectionForItem = (item: ConsoleEntry): "my" | "workspace" => {
    if (!item.id) return "my";
    const inWorkspace = findParentFolderId(sharedWithWorkspace, item.id);
    return inWorkspace !== undefined ? "workspace" : "my";
  };

  const handleMoveTo = (item: ConsoleEntry) => {
    setSelectedItem(item);
    setExplorerDialogOpen(true);
  };

  const handleMoveConfirm = async (
    targetFolderId: string | null,
    newName?: string,
    section: "my" | "workspace" = "my",
  ) => {
    if (!currentWorkspace || !selectedItem?.id) return;

    if (selectedItem.isDirectory && newName && newName !== selectedItem.name) {
      const renameItem = useConsoleTreeStore.getState().renameItem;
      await renameItem(currentWorkspace.id, selectedItem.id, newName, true);
    }

    const access = section === "workspace" ? "workspace" : "private";
    if (selectedItem.isDirectory) {
      await moveFolder(
        currentWorkspace.id,
        selectedItem.id,
        targetFolderId,
        access,
      );
    } else {
      // Rename and move in ONE request: a console is a file in the repo,
      // and two requests made two commits for one gesture. An open tab
      // follows the server's answer — the name as saved, the folder, who
      // sees it — never a path computed here. A refusal is in the store's
      // `actionError`, shown below.
      const moved = await moveConsole(
        currentWorkspace.id,
        selectedItem.id,
        targetFolderId,
        access,
        newName && newName !== selectedItem.name ? newName : undefined,
      );
      if (moved) {
        updateTabFilePath(selectedItem.id, moved.path);
        updateTabTitle(selectedItem.id, moved.name);
        updateTabAccess(selectedItem.id, moved.access);
      }
    }

    setExplorerDialogOpen(false);
    setSelectedItem(null);
  };

  const handleDuplicate = async (item: ConsoleEntry) => {
    if (!currentWorkspace || !item.id || item.isDirectory) return;
    const duplicateConsole = useConsoleTreeStore.getState().duplicateConsole;
    await duplicateConsole(currentWorkspace.id, item.id);
  };

  const handleGetInfo = (item: ConsoleEntry) => {
    if (!item.id || item.isDirectory) return;
    setInfoConsoleId(item.id);
    setInfoModalOpen(true);
  };

  const handleFolderInfo = (item: ConsoleEntry) => {
    if (!item.isDirectory) return;
    setFolderInfoItem(item);
    setFolderInfoOpen(true);
  };

  const remember = (entry: UndoEntry) => {
    setUndoStack(prev => [...prev, entry]);
    setTrashToast(entry);
  };

  // A console goes to the trash without a dialog: the toast offers Undo.
  const handleSoftDelete = async (item: ConsoleEntry) => {
    if (!currentWorkspace || !item.id || item.isDirectory) return;
    const success = await deleteItem(currentWorkspace.id, item.id, false);
    if (!success) return;
    // Their own delete: the tab closes (the toast offers the way back)
    // rather than staying open to say the console "was deleted".
    closeTabsOf(useConsoleStore.getState(), { consoleId: item.id });
    remember({ id: item.id, name: item.name });
  };

  // The folder confirm's "Delete": its consoles go to the trash, and what
  // went there is kept for the Undo.
  const handleConfirmDelete = async () => {
    const target = tree.deleteTarget as ConsoleEntry | null;
    tree.cancelDelete();
    if (!currentWorkspace || !target?.id) return;
    if (!target.isDirectory) return handleSoftDelete(target);
    const parentId = getParentFolderIdForItem(target);
    const section = getSectionForItem(target);
    const folder = await useConsoleTreeStore
      .getState()
      .trashFolder(currentWorkspace.id, target.id);
    if (folder) {
      for (const trashed of folder.consoles) {
        closeTabsOf(useConsoleStore.getState(), { consoleId: trashed.id });
      }
      remember({ id: target.id, name: target.name, folder, parentId, section });
    }
  };

  const undoEntry = async (entry: UndoEntry) => {
    if (!currentWorkspace) return;
    setTrashToast(null);
    const store = useConsoleTreeStore.getState();
    if (!entry.folder) {
      const restored = await store.restoreConsole(
        currentWorkspace.id,
        entry.id,
      );
      // A refusal is in `actionError`; the entry stays for another try.
      if (!restored) return;
      // A tab still open on it (another pane) no longer says "deleted".
      if (
        useConsoleStore.getState().tabs[entry.id]?.remoteUpdate?.kind ===
        "deleted"
      ) {
        useConsoleStore.getState().setRemoteUpdate(entry.id, null);
      }
      setUndoStack(prev => prev.filter(e => e !== entry));
      setNotice(consoleRestoredNotice(entry.name, restored.name));
      return;
    }
    const outcome = await store.restoreFolder(
      currentWorkspace.id,
      entry.folder,
      entry.parentId ?? null,
    );
    setUndoStack(prev => prev.filter(e => e !== entry));
    setNotice(
      folderRestoredNotice(
        entry.name,
        outcome,
        entry.section === "workspace" ? "Workspace" : "My Consoles",
      ),
    );
  };

  const handleUndo = async () => {
    if (undoStack.length === 0) return;
    await undoEntry(undoStack[undoStack.length - 1]);
  };

  const treeRef = useRef<import("./ConsoleTree").ConsoleTreeRef | null>(null);

  const renderSkeletonItems = () => (
    <List component="nav" dense>
      {Array.from({ length: 3 }).map((_, index) => (
        <ListItemButton key={`skeleton-${index}`} sx={{ py: 0.25, pl: 0.5 }}>
          <ListItemIcon sx={{ minWidth: 22, visibility: "hidden", mr: 0 }} />
          <ListItemIcon sx={{ minWidth: 24 }}>
            <Skeleton variant="circular" width={18} height={18} />
          </ListItemIcon>
          <ListItemText
            primary={
              <Skeleton
                variant="text"
                width={`${60 + Math.random() * 40}%`}
                height={20}
              />
            }
          />
        </ListItemButton>
      ))}
    </List>
  );

  const actions = (
    <>
      <Tooltip title="Add new folder">
        <IconButton onClick={handleMenuOpen} size="small">
          <AddIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Refresh">
        <IconButton onClick={() => void tree.refresh()} size="small">
          <RefreshIcon size={20} strokeWidth={2} />
        </IconButton>
      </Tooltip>
    </>
  );

  return (
    <>
      <ExplorerShell
        title="Consoles"
        actions={actions}
        searchPlaceholder="Search consoles..."
        onSearchChange={handleSearchChange}
        error={error}
        loading={loading}
        skeleton={renderSkeletonItems()}
      >
        {({ searchQuery }) => {
          const filteredMyConsoles =
            searchQuery.length >= 2
              ? filterTree(myConsoles, searchQuery)
              : myConsoles;
          const filteredWorkspaceConsoles =
            searchQuery.length >= 2
              ? filterTree(sharedWithWorkspace, searchQuery)
              : sharedWithWorkspace;

          const treeIds =
            searchQuery.length >= 2
              ? new Set([
                  ...collectIds(filteredMyConsoles),
                  ...collectIds(filteredWorkspaceConsoles),
                ])
              : new Set<string>();
          const extraServerResults = searchResults.filter(
            r => !treeIds.has(r.id),
          );

          const noMatches =
            searchQuery.length >= 2 &&
            filteredMyConsoles.length === 0 &&
            filteredWorkspaceConsoles.length === 0 &&
            extraServerResults.length === 0 &&
            !searchLoading;

          return (
            <>
              <ConsoleTree
                ref={treeRef}
                mode="sidebar"
                onFileOpen={handleFileOpen}
                showFiles
                enableDragDrop
                enableDuplicate
                enableInfo
                enableDelete
                enableRename
                enableMove
                onMoveRequest={handleMoveTo}
                onInfoRequest={handleGetInfo}
                onFolderInfoRequest={handleFolderInfo}
                onDeleteRequest={tree.requestDelete}
                onSoftDelete={handleSoftDelete}
                onDuplicate={handleDuplicate}
                onUndo={handleUndo}
                onDeniedAction={(item, action) =>
                  setNotice(deniedActionNotice(item.isDirectory, action))
                }
                searchQuery={searchQuery}
              />

              {searchQuery.length >= 2 && extraServerResults.length > 0 && (
                <Box sx={{ px: 1, pb: 1 }}>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      px: 0.5,
                      pb: 0.5,
                      display: "block",
                    }}
                  >
                    Also matched by description
                  </Typography>
                  <List dense disablePadding>
                    {extraServerResults.map(result => (
                      <ListItemButton
                        key={result.id}
                        onClick={() => handleSearchResultClick(result)}
                        sx={{ borderRadius: 1, py: 0.25, minHeight: 36 }}
                      >
                        <ListItemIcon sx={{ minWidth: 28 }}>
                          <ConsoleIcon size={16} />
                        </ListItemIcon>
                        <ListItemText
                          primary={result.title}
                          secondary={result.description || result.language}
                          slotProps={{
                            primary: {
                              variant: "body2",
                              noWrap: true,
                              sx: { fontSize: "0.8rem" },
                            },

                            secondary: {
                              variant: "caption",
                              noWrap: true,
                              sx: { fontSize: "0.7rem" },
                            },
                          }}
                        />
                      </ListItemButton>
                    ))}
                  </List>
                </Box>
              )}

              {noMatches && (
                <Box sx={{ px: 2, py: 1 }}>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    No consoles found
                  </Typography>
                </Box>
              )}
            </>
          );
        }}
      </ExplorerShell>

      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={handleMenuClose}
        anchorOrigin={{
          vertical: "bottom",
          horizontal: "right",
        }}
        transformOrigin={{
          vertical: "top",
          horizontal: "right",
        }}
      >
        <MenuItem onClick={handleCreateFolder}>
          <CreateFolderIcon
            size={16}
            strokeWidth={1.5}
            style={{ marginRight: 8 }}
          />
          New Folder
        </MenuItem>
      </Menu>

      <ConfirmDialog
        open={!!tree.deleteTarget}
        title={`Delete ${tree.deleteTarget?.isDirectory ? "Folder" : "Console"}`}
        body={
          tree.deleteTarget?.isDirectory
            ? folderDeleteConfirmText(tree.deleteTarget.name)
            : `“${tree.deleteTarget?.name ?? ""}” will be moved to the trash. You can undo this right after.`
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleConfirmDelete()}
        onCancel={tree.cancelDelete}
      />

      <ConsoleInfoModal
        open={infoModalOpen}
        onClose={() => setInfoModalOpen(false)}
        consoleId={infoConsoleId}
        workspaceId={currentWorkspace?.id}
      />

      <FolderInfoModal
        open={folderInfoOpen}
        onClose={() => setFolderInfoOpen(false)}
        folder={folderInfoItem}
      />

      <FileExplorerDialog
        open={explorerDialogOpen}
        onClose={() => {
          setExplorerDialogOpen(false);
          setSelectedItem(null);
        }}
        mode="move"
        onMove={handleMoveConfirm}
        itemName={selectedItem?.name || ""}
        isDirectory={selectedItem?.isDirectory || false}
        initialFolderId={
          selectedItem ? getParentFolderIdForItem(selectedItem) : null
        }
        initialSection={selectedItem ? getSectionForItem(selectedItem) : "my"}
      />

      <Snackbar
        open={actionError !== null}
        autoHideDuration={6000}
        onClose={() => {
          if (workspaceId) clearActionError(workspaceId);
        }}
        message={actionError ?? ""}
      />
      <Snackbar
        open={trashToast !== null && actionError === null}
        // Long enough to read and reach: this Undo is the way back.
        autoHideDuration={UNDO_TOAST_MS}
        resumeHideDuration={UNDO_TOAST_MS}
        onClose={(_event, reason) => {
          if (reason !== "clickaway") setTrashToast(null);
        }}
        message={
          trashToast ? trashedNotice(trashToast.name, trashToast.folder) : ""
        }
        action={
          trashToast ? (
            <Button
              color="inherit"
              size="small"
              onClick={() => void undoEntry(trashToast)}
            >
              Undo
            </Button>
          ) : undefined
        }
      />
      <Snackbar
        open={notice !== null && actionError === null && trashToast === null}
        autoHideDuration={5000}
        onClose={() => setNotice(null)}
        message={notice ?? ""}
      />
    </>
  );
}

export default forwardRef(ConsoleExplorer);
