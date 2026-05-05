import {
  useState,
  forwardRef,
  useImperativeHandle,
  useRef,
  useEffect,
  useCallback,
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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Tooltip,
  Alert,
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
import FileExplorerDialog from "./FileExplorerDialog";
import ConsoleInfoModal from "./ConsoleInfoModal";
import FolderInfoModal from "./FolderInfoModal";
import ConsoleTree from "./ConsoleTree";
import ExplorerShell from "./ExplorerShell";

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

  const loadingMap = useConsoleTreeStore(state => state.loading);
  const refreshTree = useConsoleTreeStore(state => state.refresh);
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
  const myConsolesMap = useConsoleTreeStore(state => state.myConsoles);
  const sharedWithWorkspaceMap = useConsoleTreeStore(
    state => state.sharedWithWorkspace,
  );

  const myConsoles = currentWorkspace
    ? myConsolesMap[currentWorkspace.id] || []
    : [];
  const sharedWithWorkspace = currentWorkspace
    ? sharedWithWorkspaceMap[currentWorkspace.id] || []
    : [];
  const loading = currentWorkspace ? !!loadingMap[currentWorkspace.id] : false;
  const error = currentWorkspace ? _errorFor(currentWorkspace.id) : null;

  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [explorerDialogOpen, setExplorerDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ConsoleEntry | null>(null);
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [infoConsoleId, setInfoConsoleId] = useState<string>("");
  const [folderInfoOpen, setFolderInfoOpen] = useState(false);
  const [folderInfoItem, setFolderInfoItem] = useState<ConsoleEntry | null>(
    null,
  );

  const [undoStack, setUndoStack] = useState<
    Array<{ type: "delete"; id: string; isDirectory: boolean }>
  >([]);

  const collectIds = (nodes: ConsoleEntry[]): Set<string> => {
    const ids = new Set<string>();
    for (const node of nodes) {
      if (node.id) ids.add(node.id);
      if (node.isDirectory && node.children) {
        for (const id of collectIds(node.children)) ids.add(id);
      }
    }
    return ids;
  };

  function _errorFor(wid: string) {
    const map = useConsoleTreeStore.getState().error;
    return map[wid] || null;
  }

  const fetchConsoleEntries = async () => {
    if (!currentWorkspace) return;
    await refreshTree(currentWorkspace.id);
  };

  useImperativeHandle(ref, () => ({
    refresh: () => {
      fetchConsoleEntries();
    },
  }));

  useEffect(() => {
    // Tree store handles its own initial load
  }, [currentWorkspace]);

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
          const { computeConsoleStateHash } = await import(
            "../utils/stateHash"
          );
          const hash = computeConsoleStateHash(
            data.content,
            data.connectionId,
            data.databaseId,
            data.databaseName,
          );
          updateSavedState(result.id, true, hash);
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

          const { computeConsoleStateHash } = await import(
            "../utils/stateHash"
          );
          const savedStateHash = computeConsoleStateHash(
            data.content,
            data.connectionId,
            data.databaseId,
            data.databaseName,
          );
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

  const findFolderPathById = (
    nodes: ConsoleEntry[],
    folderId: string,
  ): string | null => {
    for (const node of nodes) {
      if (node.id === folderId && node.isDirectory) return node.path;
      if (node.isDirectory && node.children) {
        const found = findFolderPathById(node.children, folderId);
        if (found) return found;
      }
    }
    return null;
  };

  const getPathForMoveTarget = (
    targetFolderId: string | null,
    section: "my" | "workspace",
    itemName: string,
  ): string => {
    if (!targetFolderId) return itemName;
    const tree = section === "workspace" ? sharedWithWorkspace : myConsoles;
    const folderPath = findFolderPathById(tree, targetFolderId);
    return folderPath ? `${folderPath}/${itemName}` : itemName;
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

    if (newName && newName !== selectedItem.name) {
      const renameItem = useConsoleTreeStore.getState().renameItem;
      await renameItem(
        currentWorkspace.id,
        selectedItem.id,
        newName,
        selectedItem.isDirectory,
      );
    }

    if (selectedItem.isDirectory) {
      await moveFolder(
        currentWorkspace.id,
        selectedItem.id,
        targetFolderId,
        section === "workspace" ? "workspace" : "private",
      );
    } else {
      const success = await moveConsole(
        currentWorkspace.id,
        selectedItem.id,
        targetFolderId,
        section === "workspace" ? "workspace" : "private",
      );
      if (success) {
        const nextName = newName || selectedItem.name;
        const nextPath = getPathForMoveTarget(
          targetFolderId,
          section,
          nextName,
        );
        updateTabFilePath(selectedItem.id, nextPath);
        updateTabTitle(selectedItem.id, nextPath);
        updateTabAccess(
          selectedItem.id,
          section === "workspace" ? "workspace" : "private",
        );
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

  const handleDeleteRequest = (item: ConsoleEntry) => {
    setSelectedItem(item);
    setDeleteDialogOpen(true);
  };

  const handleSoftDelete = async (item: ConsoleEntry) => {
    if (!currentWorkspace || !item.id) return;
    const itemId = item.id;
    const success = await deleteItem(
      currentWorkspace.id,
      itemId,
      item.isDirectory,
    );
    if (success) {
      setUndoStack(prev => [
        ...prev,
        { type: "delete", id: itemId, isDirectory: item.isDirectory },
      ]);
    }
  };

  const handleUndo = async () => {
    if (!currentWorkspace || undoStack.length === 0) return;
    const last = undoStack[undoStack.length - 1];
    if (last.type === "delete" && !last.isDirectory) {
      const restoreConsole = useConsoleTreeStore.getState().restoreConsole;
      const success = await restoreConsole(currentWorkspace.id, last.id);
      if (success) {
        setUndoStack(prev => prev.slice(0, -1));
      }
    }
  };

  const handleDeleteConfirm = async () => {
    if (!currentWorkspace || !selectedItem?.id) return;
    await deleteItem(
      currentWorkspace.id,
      selectedItem.id,
      selectedItem.isDirectory,
    );
    setDeleteDialogOpen(false);
    setSelectedItem(null);
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
        <IconButton onClick={fetchConsoleEntries} size="small">
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
                onDeleteRequest={handleDeleteRequest}
                onSoftDelete={handleSoftDelete}
                onDuplicate={handleDuplicate}
                onUndo={handleUndo}
                searchQuery={searchQuery}
              />

              {searchQuery.length >= 2 && extraServerResults.length > 0 && (
                <Box sx={{ px: 1, pb: 1 }}>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ px: 0.5, pb: 0.5, display: "block" }}
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
                          primaryTypographyProps={{
                            variant: "body2",
                            noWrap: true,
                            fontSize: "0.8rem",
                          }}
                          secondaryTypographyProps={{
                            variant: "caption",
                            noWrap: true,
                            fontSize: "0.7rem",
                          }}
                        />
                      </ListItemButton>
                    ))}
                  </List>
                </Box>
              )}

              {noMatches && (
                <Box sx={{ px: 2, py: 1 }}>
                  <Typography variant="caption" color="text.secondary">
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

      <Dialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          Delete {selectedItem?.isDirectory ? "Folder" : "Console"}
        </DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            {selectedItem?.isDirectory
              ? "This will permanently delete the folder and all its contents (subfolders and consoles)."
              : "This will permanently delete the console."}
          </Alert>
          <Typography>
            Are you sure you want to delete &ldquo;{selectedItem?.name}&rdquo;?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
          <Button
            onClick={handleDeleteConfirm}
            color="error"
            variant="contained"
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>

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
    </>
  );
}

export default forwardRef(ConsoleExplorer);
