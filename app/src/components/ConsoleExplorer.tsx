import {
  useState,
  forwardRef,
  useImperativeHandle,
  useRef,
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
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Tooltip,
  Alert,
  Chip,
  TextField,
  InputAdornment,
  CircularProgress,
} from "@mui/material";
import {
  CreateNewFolder as CreateFolderIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  DriveFileMove as MoveIcon,
  ContentCopy as DuplicateIcon,
  Info as InfoIcon,
} from "@mui/icons-material";
import {
  SquareTerminal as ConsoleIcon,
  FolderClosed as FolderIcon,
  FolderOpen as FolderOpenIcon,
  RotateCw as RefreshIcon,
  Plus as AddIcon,
  ChevronRight as ChevronRightIcon,
  ChevronDown as ChevronDownIcon,
  Eye as EyeIcon,
  Globe as GlobeIcon,
  Search as SearchIcon,
  X as ClearIcon,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  DragOverlay,
  useSensor,
  useSensors,
  PointerSensor,
  useDraggable,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useExplorerStore } from "../store/explorerStore";
import { useConsoleStore } from "../store/consoleStore";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useConsoleTreeStore,
  type ConsoleEntry,
  type ConsoleSearchResult,
} from "../store/consoleTreeStore";
import { useConsoleContentStore } from "../store/consoleContentStore";
import { useAuth } from "../contexts/auth-context";
import FileExplorerDialog from "./FileExplorerDialog";
import ConsoleInfoModal from "./ConsoleInfoModal";
import FolderInfoModal from "./FolderInfoModal";

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
  const { user } = useAuth();
  const myConsolesMap = useConsoleTreeStore(state => state.myConsoles);
  const sharedWithWorkspaceMap = useConsoleTreeStore(
    state => state.sharedWithWorkspace,
  );
  const loadingMap = useConsoleTreeStore(state => state.loading);
  const refreshTree = useConsoleTreeStore(state => state.refresh);
  const moveConsole = useConsoleTreeStore(state => state.moveConsole);
  const moveFolder = useConsoleTreeStore(state => state.moveFolder);
  const renameItem = useConsoleTreeStore(state => state.renameItem);
  const deleteItem = useConsoleTreeStore(state => state.deleteItem);
  const searchConsoles = useConsoleTreeStore(state => state.searchConsoles);
  const clearSearch = useConsoleTreeStore(state => state.clearSearch);
  const searchResults = useConsoleTreeStore(state => state.searchResults);
  const searchLoading = useConsoleTreeStore(state => state.searchLoading);
  const searchQuery = useConsoleTreeStore(state => state.searchQuery);

  const myConsoles = currentWorkspace
    ? myConsolesMap[currentWorkspace.id] || []
    : [];
  const sharedWithWorkspace = currentWorkspace
    ? sharedWithWorkspaceMap[currentWorkspace.id] || []
    : [];
  const loading = currentWorkspace ? !!loadingMap[currentWorkspace.id] : false;
  const activeTabId = useConsoleStore(state => state.activeTabId);
  const expandedFolders = useExplorerStore(
    state => state.console.expandedFolders,
  );
  const toggleFolder = useExplorerStore(state => state.toggleFolder);
  const error = currentWorkspace ? _errorFor(currentWorkspace.id) : null;

  // Section expanded states
  const [myConsolesExpanded, setMyConsolesExpanded] = useState(true);
  const [sharedWithWorkspaceExpanded, setSharedWithWorkspaceExpanded] =
    useState(true);

  // Dialogs
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [explorerDialogOpen, setExplorerDialogOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    item: ConsoleEntry;
    readOnly?: boolean;
  } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ConsoleEntry | null>(null);
  const [infoModalOpen, setInfoModalOpen] = useState(false);
  const [infoConsoleId, setInfoConsoleId] = useState<string>("");
  const [folderInfoOpen, setFolderInfoOpen] = useState(false);
  const [folderInfoItem, setFolderInfoItem] = useState<ConsoleEntry | null>(
    null,
  );

  // Keyboard selection state (distinct from activeTabId; tracks which tree item has keyboard focus)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Undo stack: stores last destructive action so Cmd+Z can reverse it
  const [undoStack, setUndoStack] = useState<
    Array<{ type: "delete"; id: string; isDirectory: boolean }>
  >([]);

  // Search state
  const [localSearchQuery, setLocalSearchQuery] = useState("");
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filterTree = (nodes: ConsoleEntry[], query: string): ConsoleEntry[] => {
    const lower = query.toLowerCase();
    const result: ConsoleEntry[] = [];
    for (const node of nodes) {
      if (node.isDirectory && node.children) {
        const filteredChildren = filterTree(node.children, query);
        if (filteredChildren.length > 0) {
          result.push({ ...node, children: filteredChildren });
        }
      } else if (node.name.toLowerCase().includes(lower)) {
        result.push(node);
      }
    }
    return result;
  };

  const filteredMyConsoles =
    localSearchQuery.length >= 2
      ? filterTree(myConsoles, localSearchQuery)
      : myConsoles;
  const filteredWorkspaceConsoles =
    localSearchQuery.length >= 2
      ? filterTree(sharedWithWorkspace, localSearchQuery)
      : sharedWithWorkspace;
  const hasClientMatches =
    localSearchQuery.length >= 2 &&
    (filteredMyConsoles.length > 0 || filteredWorkspaceConsoles.length > 0);

  const handleSearchChange = (value: string) => {
    setLocalSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (value.length < 2) {
      clearSearch();
      return;
    }

    searchTimerRef.current = setTimeout(() => {
      if (currentWorkspace) {
        searchConsoles(currentWorkspace.id, value);
      }
    }, 400);
  };

  const handleSearchClear = () => {
    setLocalSearchQuery("");
    clearSearch();
  };

  const handleSearchResultClick = (result: ConsoleSearchResult) => {
    onConsoleSelect(
      result.title,
      "",
      undefined,
      result.id,
      false,
      undefined,
      result.databaseName,
    );
  };

  // Inline rename state
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // DnD state
  const [draggedItem, setDraggedItem] = useState<ConsoleEntry | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

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

  const handleFolderToggle = (folderPath: string) => {
    toggleFolder(folderPath);
  };

  const handleFileClick = async (node: ConsoleEntry) => {
    if (!currentWorkspace) {
      console.error("No workspace selected");
      return;
    }

    if (!node.id) {
      console.error("Console has no ID, cannot open");
      return;
    }

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

        const { computeConsoleStateHash } = await import("../utils/stateHash");
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
  };

  const handleMenuOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
    setMenuAnchor(event.currentTarget);
  };

  const handleMenuClose = () => {
    setMenuAnchor(null);
  };

  const createFolderInline = async (
    parentId: string | null,
    access?: "private" | "workspace",
  ) => {
    if (!currentWorkspace) return;
    const createFolder = useConsoleTreeStore.getState().createFolder;
    // access is resolved by the store (inherits from parent if not specified)
    const result = await createFolder(
      currentWorkspace.id,
      "New Folder",
      parentId,
      access,
    );
    if (result) {
      setRenamingItemId(result.id);
      setRenameValue(result.name);
    }
  };

  const handleCreateFolder = () => {
    handleMenuClose();
    createFolderInline(null, "private");
  };

  const handleCreateWorkspaceFolder = () => {
    handleMenuClose();
    createFolderInline(null, "workspace");
  };

  const handleCreateFolderInParent = (parentId: string) => {
    createFolderInline(parentId);
  };

  const handleContextMenu = (
    event: React.MouseEvent,
    item: ConsoleEntry,
    readOnly = false,
  ) => {
    event.preventDefault();
    setContextMenu({
      mouseX: event.clientX + 2,
      mouseY: event.clientY - 6,
      item,
      readOnly,
    });
  };

  const handleContextMenuClose = () => {
    setContextMenu(null);
  };

  // Inline rename handlers
  const startInlineRename = (item: ConsoleEntry) => {
    if (!item.id) return;
    setRenamingItemId(item.id);
    setRenameValue(item.name);
    handleContextMenuClose();
  };

  const commitInlineRename = async () => {
    if (!currentWorkspace || !renamingItemId || !renameValue.trim()) {
      cancelInlineRename();
      return;
    }

    const findItem = (nodes: ConsoleEntry[]): ConsoleEntry | null => {
      for (const node of nodes) {
        if (node.id === renamingItemId) return node;
        if (node.isDirectory && node.children) {
          const found = findItem(node.children);
          if (found) return found;
        }
      }
      return null;
    };

    const item = findItem(myConsoles) || findItem(sharedWithWorkspace);
    const trimmedName = renameValue.trim();

    if (item && trimmedName !== item.name) {
      await renameItem(
        currentWorkspace.id,
        renamingItemId,
        trimmedName,
        item.isDirectory,
      );
    } else if (item) {
      useConsoleTreeStore
        .getState()
        .resortItem(currentWorkspace.id, renamingItemId);
    }

    setRenamingItemId(null);
    setRenameValue("");
  };

  const cancelInlineRename = () => {
    setRenamingItemId(null);
    setRenameValue("");
  };

  useEffect(() => {
    if (renamingItemId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingItemId]);

  // Build a flat list of visible node IDs for arrow-key navigation
  const flatNodeIds = (() => {
    const ids: string[] = [];
    const collect = (nodes: ConsoleEntry[], sectionExpanded: boolean) => {
      if (!sectionExpanded) return;
      for (const node of nodes) {
        if (node.id) ids.push(node.id);
        if (
          node.isDirectory &&
          expandedFolders.has(node.path) &&
          node.children
        ) {
          collect(node.children, true);
        }
      }
    };
    collect(myConsoles, myConsolesExpanded);
    collect(sharedWithWorkspace, sharedWithWorkspaceExpanded);
    return ids;
  })();

  const findNodeById = (targetId: string): ConsoleEntry | null => {
    const search = (nodes: ConsoleEntry[]): ConsoleEntry | null => {
      for (const node of nodes) {
        if (node.id === targetId) return node;
        if (node.isDirectory && node.children) {
          const found = search(node.children);
          if (found) return found;
        }
      }
      return null;
    };
    return search(myConsoles) || search(sharedWithWorkspace);
  };

  // Comprehensive keyboard handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const focusId = selectedNodeId || activeTabId;
      const focusItem = focusId ? findNodeById(focusId) : null;
      const meta = e.metaKey || e.ctrlKey;

      // F2 → rename
      if (e.key === "F2" && focusItem) {
        e.preventDefault();
        startInlineRename(focusItem);
        return;
      }

      // Delete / Backspace → delete
      if ((e.key === "Delete" || e.key === "Backspace") && focusItem && !meta) {
        e.preventDefault();
        handleDelete(focusItem);
        return;
      }

      // Cmd+D → duplicate
      if (meta && e.key === "d" && focusItem && !focusItem.isDirectory) {
        e.preventDefault();
        handleDuplicate(focusItem);
        return;
      }

      // Cmd+I → get info
      if (meta && e.key === "i" && focusItem && !focusItem.isDirectory) {
        e.preventDefault();
        handleGetInfo(focusItem);
        return;
      }

      // Cmd+Z → undo last delete
      if (meta && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Arrow Down → select next item
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const idx = focusId ? flatNodeIds.indexOf(focusId) : -1;
        const nextId = flatNodeIds[idx + 1];
        if (nextId) setSelectedNodeId(nextId);
        return;
      }

      // Arrow Up → select previous item
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const idx = focusId ? flatNodeIds.indexOf(focusId) : flatNodeIds.length;
        const prevId = flatNodeIds[idx - 1];
        if (prevId) setSelectedNodeId(prevId);
        return;
      }

      // Arrow Right → expand folder
      if (e.key === "ArrowRight" && focusItem?.isDirectory) {
        e.preventDefault();
        if (!expandedFolders.has(focusItem.path)) {
          toggleFolder(focusItem.path);
        }
        return;
      }

      // Arrow Left → collapse folder
      if (e.key === "ArrowLeft" && focusItem?.isDirectory) {
        e.preventDefault();
        if (expandedFolders.has(focusItem.path)) {
          toggleFolder(focusItem.path);
        }
        return;
      }

      // Enter → open console / toggle folder
      if (e.key === "Enter" && focusItem) {
        e.preventDefault();
        if (focusItem.isDirectory) {
          toggleFolder(focusItem.path);
        } else {
          handleFileClick(focusItem);
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedNodeId,
    activeTabId,
    myConsoles,
    sharedWithWorkspace,
    flatNodeIds,
    expandedFolders,
    undoStack,
  ]);

  const handleDelete = (item: ConsoleEntry) => {
    if (item.isDirectory) {
      setSelectedItem(item);
      setDeleteDialogOpen(true);
      handleContextMenuClose();
    } else {
      handleSoftDelete(item);
    }
  };

  const handleMoveTo = (item: ConsoleEntry) => {
    setSelectedItem(item);
    setExplorerDialogOpen(true);
    handleContextMenuClose();
  };

  const handleMoveConfirm = async (targetFolderId: string | null) => {
    if (!currentWorkspace || !selectedItem?.id) return;

    if (selectedItem.isDirectory) {
      await moveFolder(currentWorkspace.id, selectedItem.id, targetFolderId);
    } else {
      await moveConsole(currentWorkspace.id, selectedItem.id, targetFolderId);
    }

    setExplorerDialogOpen(false);
    setSelectedItem(null);
  };

  const handleDuplicate = async (item: ConsoleEntry) => {
    if (!currentWorkspace || !item.id || item.isDirectory) return;
    handleContextMenuClose();
    const duplicateConsole = useConsoleTreeStore.getState().duplicateConsole;
    const result = await duplicateConsole(currentWorkspace.id, item.id);
    if (result) {
      setRenamingItemId(result.id);
      setRenameValue(result.name);
    }
  };

  const handleGetInfo = (item: ConsoleEntry) => {
    if (!item.id || item.isDirectory) return;
    setInfoConsoleId(item.id);
    setInfoModalOpen(true);
    handleContextMenuClose();
  };

  const handleFolderInfo = (item: ConsoleEntry) => {
    if (!item.isDirectory) return;
    setFolderInfoItem(item);
    setFolderInfoOpen(true);
    handleContextMenuClose();
  };

  const handleSoftDelete = async (item: ConsoleEntry) => {
    if (!currentWorkspace || !item.id) return;
    handleContextMenuClose();
    const success = await deleteItem(
      currentWorkspace.id,
      item.id,
      item.isDirectory,
    );
    if (success) {
      setUndoStack(prev => [
        ...prev,
        { type: "delete", id: item.id!, isDirectory: item.isDirectory },
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

  const isOwner = (item: ConsoleEntry): boolean => {
    return item.owner_id === user?.id;
  };

  const handleDeleteConfirm = async () => {
    if (!currentWorkspace || !selectedItem?.id) {
      return;
    }
    await deleteItem(
      currentWorkspace.id,
      selectedItem.id,
      selectedItem.isDirectory,
    );
    setDeleteDialogOpen(false);
    setSelectedItem(null);
  };

  // Search across all three section trees
  const findInAnyTree = (
    targetId: string,
  ): { node: ConsoleEntry; section: "my" | "workspace" } | null => {
    const search = (nodes: ConsoleEntry[]): ConsoleEntry | null => {
      for (const node of nodes) {
        if (node.id === targetId) return node;
        if (node.isDirectory && node.children) {
          const found = search(node.children);
          if (found) return found;
        }
      }
      return null;
    };
    const inMy = search(myConsoles);
    if (inMy) return { node: inMy, section: "my" };
    const inWorkspace = search(sharedWithWorkspace);
    if (inWorkspace) return { node: inWorkspace, section: "workspace" };
    return null;
  };

  // DnD handlers
  const handleDragStart = (event: DragStartEvent) => {
    const result = findInAnyTree(event.active.id as string);
    if (result) setDraggedItem(result.node);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;
    setDropTargetId(over ? (over.id as string) : null);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setDraggedItem(null);
    setDropTargetId(null);

    if (!over || !currentWorkspace || active.id === over.id) return;

    const dragId = active.id as string;
    const dropId = over.id as string;
    const dragResult = findInAnyTree(dragId);
    if (!dragResult) return;

    // Drop on a section header: move to root of that section
    if (dropId === "__section_my" || dropId === "__section_workspace") {
      const newAccess =
        dropId === "__section_workspace" ? "workspace" : "private";
      if (dragResult.node.isDirectory) {
        await moveFolder(currentWorkspace.id, dragId, null, newAccess);
      } else {
        await moveConsole(currentWorkspace.id, dragId, null, newAccess);
      }
      return;
    }

    // Drop on a folder
    const dropResult = findInAnyTree(dropId);
    if (!dropResult?.node.isDirectory) return;

    if (dragResult.node.isDirectory) {
      await moveFolder(currentWorkspace.id, dragId, dropId);
    } else {
      await moveConsole(currentWorkspace.id, dragId, dropId);
    }
  };

  const getAccessIcon = (node: ConsoleEntry) => {
    if (isOwner(node)) return null;
    const nodeAccess = node.access || "private";

    if (nodeAccess === "workspace") {
      return (
        <Tooltip title="Read-only">
          <EyeIcon
            size={14}
            strokeWidth={1.5}
            style={{ opacity: 0.5, flexShrink: 0 }}
          />
        </Tooltip>
      );
    }

    return null;
  };

  const renderInlineRenameInput = () => (
    <input
      ref={renameInputRef}
      value={renameValue}
      onChange={e => setRenameValue(e.target.value)}
      onBlur={commitInlineRename}
      onKeyDown={e => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitInlineRename();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          cancelInlineRename();
        }
        e.stopPropagation();
      }}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      style={{
        border: "none",
        borderRadius: 3,
        padding: 0,
        margin: 0,
        fontSize: "0.875rem",
        lineHeight: "1.43",
        width: "100%",
        outline: "1px solid currentColor",
        outlineOffset: "1px",
        background: "transparent",
        color: "inherit",
        fontFamily: "inherit",
        boxSizing: "border-box",
      }}
    />
  );

  const renderTree = (
    nodes: ConsoleEntry[],
    depth = 0,
    readOnlyContext = false,
  ) => {
    return nodes.map(node => {
      if (node.isDirectory) {
        const isExpanded = expandedFolders.has(node.path);
        const nodeKey = node.id || node.path;
        const isDragOver = dropTargetId === node.id;
        const isRenaming = renamingItemId === node.id;

        return (
          <div key={`dir-${nodeKey}`}>
            <DraggableTreeItem
              id={node.id || node.path}
              disabled={readOnlyContext}
              isFolder
            >
              <ListItemButton
                onClick={() => {
                  setSelectedNodeId(node.id || null);
                  handleFolderToggle(node.path);
                }}
                onContextMenu={e => handleContextMenu(e, node, readOnlyContext)}
                onDoubleClick={e => {
                  if (!readOnlyContext) {
                    e.stopPropagation();
                    startInlineRename(node);
                  }
                }}
                selected={selectedNodeId === node.id}
                sx={{
                  py: 0.25,
                  pl: 0.5 + depth * 1.5,
                  bgcolor: isDragOver ? "action.hover" : undefined,
                  outline: isDragOver ? "2px dashed" : undefined,
                  outlineColor: isDragOver ? "primary.main" : undefined,
                  borderRadius: isDragOver ? 1 : undefined,
                }}
              >
                <ListItemIcon sx={{ minWidth: 22, mr: 0 }}>
                  {isExpanded ? (
                    <ChevronDownIcon strokeWidth={1.5} size={20} />
                  ) : (
                    <ChevronRightIcon strokeWidth={1.5} size={20} />
                  )}
                </ListItemIcon>
                <ListItemIcon sx={{ minWidth: 24 }}>
                  {isExpanded ? (
                    <FolderOpenIcon strokeWidth={1.5} size={18} />
                  ) : (
                    <FolderIcon strokeWidth={1.5} size={18} />
                  )}
                </ListItemIcon>
                {isRenaming ? (
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    {renderInlineRenameInput()}
                  </Box>
                ) : (
                  <ListItemText
                    primary={node.name}
                    primaryTypographyProps={{
                      variant: "body2",
                      style: {
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      },
                    }}
                  />
                )}
              </ListItemButton>
            </DraggableTreeItem>
            {isExpanded && (
              <List component="div" disablePadding dense>
                {node.children &&
                  renderTree(node.children, depth + 1, readOnlyContext)}
              </List>
            )}
          </div>
        );
      }

      const nodeKey = node.id || node.path;
      const isActive = !!(node.id && activeTabId === node.id);
      const isRenaming = renamingItemId === node.id;

      return (
        <DraggableTreeItem
          key={`file-${nodeKey}`}
          id={node.id || node.path}
          disabled={readOnlyContext}
        >
          <ListItemButton
            onClick={() => {
              setSelectedNodeId(node.id || null);
              handleFileClick(node);
            }}
            onContextMenu={e => handleContextMenu(e, node, readOnlyContext)}
            onDoubleClick={e => {
              if (!readOnlyContext) {
                e.stopPropagation();
                startInlineRename(node);
              }
            }}
            selected={isActive || selectedNodeId === node.id}
            sx={{
              py: 0.25,
              pl: 0.5 + depth * 1.5,
            }}
          >
            <ListItemIcon sx={{ minWidth: 22, visibility: "hidden", mr: 0 }} />
            <ListItemIcon sx={{ minWidth: 24 }}>
              <ConsoleIcon size={18} strokeWidth={1.5} />
            </ListItemIcon>
            {isRenaming ? (
              <Box sx={{ flex: 1, minWidth: 0 }}>
                {renderInlineRenameInput()}
              </Box>
            ) : (
              <ListItemText
                primary={node.name}
                primaryTypographyProps={{
                  variant: "body2",
                  fontSize: "0.9rem",
                  style: {
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  },
                }}
              />
            )}
            {getAccessIcon(node)}
          </ListItemButton>
        </DraggableTreeItem>
      );
    });
  };

  // Section header context menu
  const [sectionContextMenu, setSectionContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    section: "my" | "workspace";
  } | null>(null);

  const handleSectionContextMenu = (
    event: React.MouseEvent,
    section: "my" | "workspace",
  ) => {
    event.preventDefault();
    setSectionContextMenu({
      mouseX: event.clientX + 2,
      mouseY: event.clientY - 6,
      section,
    });
  };

  const renderSectionHeader = (
    label: string,
    icon: React.ReactNode,
    isExpanded: boolean,
    onToggle: () => void,
    count: number,
    onCtxMenu?: (e: React.MouseEvent) => void,
    droppableId?: string,
  ) => {
    const isDragOver = droppableId && dropTargetId === droppableId;
    const header = (
      <ListItemButton
        onClick={onToggle}
        onContextMenu={onCtxMenu}
        sx={{
          py: 0.25,
          pl: 0.5,
          bgcolor: isDragOver ? "action.hover" : undefined,
          outline: isDragOver ? "2px dashed" : undefined,
          outlineColor: isDragOver ? "primary.main" : undefined,
          borderRadius: isDragOver ? 1 : undefined,
        }}
      >
        <ListItemIcon sx={{ minWidth: 22, mr: 0 }}>
          {isExpanded ? (
            <ChevronDownIcon strokeWidth={1.5} size={20} />
          ) : (
            <ChevronRightIcon strokeWidth={1.5} size={20} />
          )}
        </ListItemIcon>
        <ListItemIcon sx={{ minWidth: 24 }}>{icon}</ListItemIcon>
        <ListItemText
          primary={label}
          primaryTypographyProps={{
            variant: "body2",
            fontWeight: 600,
            sx: {
              textTransform: "uppercase",
              fontSize: "0.75rem",
              letterSpacing: "0.05em",
            },
          }}
        />
        {count > 0 && (
          <Chip
            label={count}
            size="small"
            sx={{ height: 18, fontSize: "0.7rem" }}
          />
        )}
      </ListItemButton>
    );
    if (droppableId) {
      return (
        <DroppableSectionHeader id={droppableId}>
          {header}
        </DroppableSectionHeader>
      );
    }
    return header;
  };

  const countConsoles = (nodes: ConsoleEntry[]): number => {
    let count = 0;
    for (const node of nodes) {
      if (node.isDirectory && node.children) {
        count += countConsoles(node.children);
      } else if (!node.isDirectory) {
        count += 1;
      }
    }
    return count;
  };

  const renderSkeletonItems = () => {
    return Array.from({ length: 3 }).map((_, index) => (
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
    ));
  };

  const renderEmptyPlaceholder = (message: string) => (
    <Typography
      sx={{
        pl: 3,
        py: 0.5,
        color: "text.disabled",
        fontSize: "0.8rem",
        fontStyle: "italic",
      }}
      variant="body2"
    >
      {message}
    </Typography>
  );

  return (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Box sx={{ px: 1, py: 0.5, borderBottom: 1, borderColor: "divider" }}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Box
            sx={{
              flexGrow: 1,
              overflow: "hidden",
              maxWidth: "calc(100% - 80px)",
            }}
          >
            <Typography
              variant="h6"
              sx={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                textTransform: "uppercase",
              }}
            >
              Consoles
            </Typography>
          </Box>
          <Box sx={{ display: "flex", gap: 0 }}>
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
          </Box>
        </Box>
      </Box>
      <Box sx={{ px: 1, pb: 0.5 }}>
        <TextField
          size="small"
          fullWidth
          placeholder="Search consoles..."
          value={localSearchQuery}
          onChange={e => handleSearchChange(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon size={16} />
                </InputAdornment>
              ),
              endAdornment: localSearchQuery ? (
                <InputAdornment position="end">
                  {searchLoading ? (
                    <CircularProgress size={16} />
                  ) : (
                    <IconButton size="small" onClick={handleSearchClear}>
                      <ClearIcon size={14} />
                    </IconButton>
                  )}
                </InputAdornment>
              ) : null,
            },
          }}
          sx={{ "& .MuiInputBase-root": { height: 32, fontSize: "0.85rem" } }}
        />
      </Box>
      {searchQuery && searchResults.length > 0 && (
        <Box sx={{ px: 1, pb: 1 }}>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ px: 0.5, pb: 0.5, display: "block" }}
          >
            {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
          </Typography>
          <List dense disablePadding>
            {searchResults.map(result => (
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
                {result.isSaved && (
                  <Chip
                    label="saved"
                    size="small"
                    variant="outlined"
                    sx={{ height: 18, fontSize: "0.65rem", ml: 0.5 }}
                  />
                )}
              </ListItemButton>
            ))}
          </List>
        </Box>
      )}
      {searchQuery &&
        !searchLoading &&
        searchResults.length === 0 &&
        !hasClientMatches && (
          <Box sx={{ px: 2, py: 1 }}>
            <Typography variant="caption" color="text.secondary">
              No consoles found
            </Typography>
          </Box>
        )}
      {error && (
        <Box sx={{ p: 2 }}>
          <Typography color="error" variant="body2">
            {error}
          </Typography>
        </Box>
      )}
      <Box
        sx={{
          flexGrow: 1,
          overflowY: "auto",
          "&::-webkit-scrollbar": {
            width: "0.4em",
          },
          "&::-webkit-scrollbar-track": {
            boxShadow: "inset 0 0 6px rgba(0,0,0,0.00)",
            webkitBoxShadow: "inset 0 0 6px rgba(0,0,0,0.00)",
          },
          "&::-webkit-scrollbar-thumb": {
            backgroundColor: "rgba(0,0,0,.1)",
            outline: "1px solid slategrey",
          },
        }}
      >
        {loading ? (
          <List component="nav" dense>
            {renderSkeletonItems()}
          </List>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            <List component="nav" dense>
              {/* My Consoles */}
              {renderSectionHeader(
                "My Consoles",
                <ConsoleIcon strokeWidth={1.5} size={18} />,
                myConsolesExpanded,
                () => setMyConsolesExpanded(!myConsolesExpanded),
                countConsoles(filteredMyConsoles),
                e => handleSectionContextMenu(e, "my"),
                "__section_my",
              )}
              {myConsolesExpanded && (
                <>
                  {filteredMyConsoles.length > 0
                    ? renderTree(filteredMyConsoles, 1)
                    : renderEmptyPlaceholder("No consoles yet")}
                </>
              )}

              {/* Workspace */}
              {renderSectionHeader(
                "Workspace",
                <GlobeIcon strokeWidth={1.5} size={18} />,
                sharedWithWorkspaceExpanded,
                () =>
                  setSharedWithWorkspaceExpanded(!sharedWithWorkspaceExpanded),
                countConsoles(filteredWorkspaceConsoles),
                e => handleSectionContextMenu(e, "workspace"),
                "__section_workspace",
              )}
              {sharedWithWorkspaceExpanded && (
                <>
                  {filteredWorkspaceConsoles.length > 0
                    ? renderTree(filteredWorkspaceConsoles, 1)
                    : renderEmptyPlaceholder("No workspace consoles yet")}
                </>
              )}
            </List>

            {/* Drag overlay */}
            <DragOverlay>
              {draggedItem ? (
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    px: 1.5,
                    py: 0.5,
                    bgcolor: "background.paper",
                    border: 1,
                    borderColor: "divider",
                    borderRadius: 1,
                    boxShadow: 3,
                    opacity: 0.9,
                  }}
                >
                  {draggedItem.isDirectory ? (
                    <FolderIcon size={16} strokeWidth={1.5} />
                  ) : (
                    <ConsoleIcon size={16} strokeWidth={1.5} />
                  )}
                  <Typography variant="body2" noWrap>
                    {draggedItem.name}
                  </Typography>
                </Box>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </Box>

      {/* Add Menu */}
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
          <CreateFolderIcon sx={{ mr: 1 }} fontSize="small" />
          New Folder
        </MenuItem>
      </Menu>

      {/* Context Menu */}
      <Menu
        open={contextMenu !== null}
        onClose={handleContextMenuClose}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenu !== null
            ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
            : undefined
        }
      >
        {/* Owner actions: Rename, Delete, Share, Move to */}
        {contextMenu && isOwner(contextMenu.item) && (
          <MenuItem
            onClick={() => contextMenu && startInlineRename(contextMenu.item)}
          >
            <EditIcon sx={{ mr: 1 }} fontSize="small" />
            Rename
          </MenuItem>
        )}
        {contextMenu && isOwner(contextMenu.item) && (
          <MenuItem
            onClick={() => contextMenu && handleDelete(contextMenu.item)}
          >
            <DeleteIcon sx={{ mr: 1 }} fontSize="small" />
            Delete
          </MenuItem>
        )}
        {contextMenu && isOwner(contextMenu.item) && (
          <MenuItem
            onClick={() => contextMenu && handleMoveTo(contextMenu.item)}
          >
            <MoveIcon sx={{ mr: 1 }} fontSize="small" />
            Move to...
          </MenuItem>
        )}
        {/* New Subfolder — any writable folder */}
        {contextMenu?.item.isDirectory && !contextMenu.readOnly && (
          <MenuItem
            onClick={() => {
              if (contextMenu.item.id) {
                handleCreateFolderInParent(contextMenu.item.id);
                if (!expandedFolders.has(contextMenu.item.path)) {
                  toggleFolder(contextMenu.item.path);
                }
              }
              handleContextMenuClose();
            }}
          >
            <CreateFolderIcon sx={{ mr: 1 }} fontSize="small" />
            New Subfolder
          </MenuItem>
        )}
        {/* Duplicate — consoles only */}
        {contextMenu && !contextMenu.item.isDirectory && (
          <MenuItem
            onClick={() => contextMenu && handleDuplicate(contextMenu.item)}
          >
            <DuplicateIcon sx={{ mr: 1 }} fontSize="small" />
            Duplicate
          </MenuItem>
        )}
        {/* Get Info — consoles only */}
        {contextMenu && !contextMenu.item.isDirectory && (
          <MenuItem
            onClick={() => contextMenu && handleGetInfo(contextMenu.item)}
          >
            <InfoIcon sx={{ mr: 1 }} fontSize="small" />
            Get Info
          </MenuItem>
        )}
        {/* Information — folders only */}
        {contextMenu && contextMenu.item.isDirectory && (
          <MenuItem
            onClick={() => contextMenu && handleFolderInfo(contextMenu.item)}
          >
            <InfoIcon sx={{ mr: 1 }} fontSize="small" />
            Information
          </MenuItem>
        )}
      </Menu>

      {/* Section Header Context Menu */}
      <Menu
        open={sectionContextMenu !== null}
        onClose={() => setSectionContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={
          sectionContextMenu !== null
            ? {
                top: sectionContextMenu.mouseY,
                left: sectionContextMenu.mouseX,
              }
            : undefined
        }
      >
        <MenuItem
          onClick={() => {
            const section = sectionContextMenu?.section;
            setSectionContextMenu(null);
            if (section === "workspace") {
              handleCreateWorkspaceFolder();
            } else {
              handleCreateFolder();
            }
          }}
        >
          <CreateFolderIcon sx={{ mr: 1 }} fontSize="small" />
          New Folder
        </MenuItem>
      </Menu>

      {/* Delete Confirmation Dialog */}
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

      {/* Console Info Modal */}
      <ConsoleInfoModal
        open={infoModalOpen}
        onClose={() => setInfoModalOpen(false)}
        consoleId={infoConsoleId}
        workspaceId={currentWorkspace?.id}
      />

      {/* Folder Info Modal */}
      <FolderInfoModal
        open={folderInfoOpen}
        onClose={() => setFolderInfoOpen(false)}
        folder={folderInfoItem}
      />

      {/* File Explorer Dialog for Move */}
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
      />
    </Box>
  );
}

/** Wrapper that makes a section header a drop target */
function DroppableSectionHeader({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id });
  return <div ref={setNodeRef}>{children}</div>;
}

/** Wrapper that makes a tree item draggable and a drop target (for folders) */
function DraggableTreeItem({
  id,
  disabled,
  isFolder,
  children,
}: {
  id: string;
  disabled?: boolean;
  isFolder?: boolean;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id, disabled });

  const { setNodeRef: setDropRef } = useDroppable({
    id,
    disabled: !isFolder,
  });

  const setRef = (el: HTMLElement | null) => {
    setDragRef(el);
    if (isFolder) setDropRef(el);
  };

  return (
    <div
      ref={setRef}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

export default forwardRef(ConsoleExplorer);
