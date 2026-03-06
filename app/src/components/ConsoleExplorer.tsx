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
  TextField,
  Button,
  Tooltip,
  Alert,
  Chip,
  FormControl,
  InputLabel,
  Select as MuiSelect,
  SelectChangeEvent,
} from "@mui/material";
import {
  CreateNewFolder as CreateFolderIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Share as ShareIcon,
  PersonAdd as PersonAddIcon,
  Close as CloseIcon,
  DriveFileMove as MoveIcon,
  ContentCopy as DuplicateIcon,
} from "@mui/icons-material";
import {
  SquareTerminal as ConsoleIcon,
  FolderClosed as FolderIcon,
  FolderOpen as FolderOpenIcon,
  RotateCw as RefreshIcon,
  Plus as AddIcon,
  ChevronRight as ChevronRightIcon,
  ChevronDown as ChevronDownIcon,
  Lock as LockIcon,
  Users as UsersIcon,
  Eye as EyeIcon,
  Globe as GlobeIcon,
  Pencil as PencilIcon,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  DragOverlay,
  useSensor,
  useSensors,
  PointerSensor,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useExplorerStore } from "../store/explorerStore";
import { useConsoleStore } from "../store/consoleStore";
import { useWorkspace } from "../contexts/workspace-context";
import {
  useConsoleTreeStore,
  type ConsoleEntry,
  type ConsoleAccessLevel,
  type SharedWithEntry,
} from "../store/consoleTreeStore";
import { useConsoleContentStore } from "../store/consoleContentStore";
import { useAuth } from "../contexts/auth-context";
import MoveToDialog from "./MoveToDialog";

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
  const sharedWithMeMap = useConsoleTreeStore(state => state.sharedWithMe);
  const sharedWithWorkspaceMap = useConsoleTreeStore(
    state => state.sharedWithWorkspace,
  );
  const loadingMap = useConsoleTreeStore(state => state.loading);
  const refreshTree = useConsoleTreeStore(state => state.refresh);
  const moveConsole = useConsoleTreeStore(state => state.moveConsole);
  const moveFolder = useConsoleTreeStore(state => state.moveFolder);
  const renameItem = useConsoleTreeStore(state => state.renameItem);
  const deleteItem = useConsoleTreeStore(state => state.deleteItem);
  const createFolderAction = useConsoleTreeStore(state => state.createFolder);

  const myConsoles = currentWorkspace
    ? myConsolesMap[currentWorkspace.id] || []
    : [];
  const sharedWithMe = currentWorkspace
    ? sharedWithMeMap[currentWorkspace.id] || []
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
  const [sharedWithMeExpanded, setSharedWithMeExpanded] = useState(true);
  const [sharedWithWorkspaceExpanded, setSharedWithWorkspaceExpanded] =
    useState(true);

  // Dialogs
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedParentFolder, setSelectedParentFolder] = useState<
    string | null
  >(null);
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    item: ConsoleEntry;
    readOnly?: boolean;
  } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareAccess, setShareAccess] = useState<ConsoleAccessLevel>("private");
  const [shareUserEntries, setShareUserEntries] = useState<SharedWithEntry[]>(
    [],
  );
  const [shareUserEmail, setShareUserEmail] = useState("");
  const [shareUserPermission, setShareUserPermission] = useState<
    "read" | "write"
  >("read");
  const [selectedItem, setSelectedItem] = useState<ConsoleEntry | null>(null);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);

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

  const handleCreateFolder = () => {
    setFolderDialogOpen(true);
    setSelectedParentFolder(null);
    handleMenuClose();
  };

  const handleCreateFolderInParent = (parentFolderId: string) => {
    setFolderDialogOpen(true);
    setSelectedParentFolder(parentFolderId);
  };

  const handleFolderDialogClose = () => {
    setFolderDialogOpen(false);
    setNewFolderName("");
    setSelectedParentFolder(null);
  };

  const handleFolderCreate = async () => {
    if (!currentWorkspace || !newFolderName.trim()) {
      return;
    }

    await createFolderAction(
      currentWorkspace.id,
      newFolderName.trim(),
      selectedParentFolder,
    );
    handleFolderDialogClose();
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

    const item =
      findItem(myConsoles) ||
      findItem(sharedWithMe) ||
      findItem(sharedWithWorkspace);

    if (item && renameValue.trim() !== item.name) {
      await renameItem(
        currentWorkspace.id,
        renamingItemId,
        renameValue.trim(),
        item.isDirectory,
      );
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

  // Keyboard handler for F2 rename
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F2" && activeTabId) {
        const findInTree = (nodes: ConsoleEntry[]): ConsoleEntry | null => {
          for (const node of nodes) {
            if (node.id === activeTabId) return node;
            if (node.isDirectory && node.children) {
              const found = findInTree(node.children);
              if (found) return found;
            }
          }
          return null;
        };
        const item = findInTree(myConsoles);
        if (item && isOwner(item)) {
          e.preventDefault();
          startInlineRename(item);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTabId, myConsoles]);

  const handleDelete = (item: ConsoleEntry) => {
    setSelectedItem(item);
    setDeleteDialogOpen(true);
    handleContextMenuClose();
  };

  const handleShare = (item: ConsoleEntry) => {
    setSelectedItem(item);
    setShareAccess(item.access || "private");
    setShareUserEntries(item.shared_with || []);
    setShareDialogOpen(true);
    handleContextMenuClose();
  };

  const handleMoveTo = (item: ConsoleEntry) => {
    setSelectedItem(item);
    setMoveDialogOpen(true);
    handleContextMenuClose();
  };

  const handleMoveConfirm = async (targetFolderId: string | null) => {
    if (!currentWorkspace || !selectedItem?.id) return;

    if (selectedItem.isDirectory) {
      await moveFolder(currentWorkspace.id, selectedItem.id, targetFolderId);
    } else {
      await moveConsole(currentWorkspace.id, selectedItem.id, targetFolderId);
    }

    setMoveDialogOpen(false);
    setSelectedItem(null);
  };

  const handleShareConfirm = async () => {
    if (!currentWorkspace || !selectedItem?.id) return;

    const isFolder = selectedItem.isDirectory;
    const endpoint = isFolder
      ? `/api/workspaces/${currentWorkspace.id}/consoles/folders/${selectedItem.id}/share`
      : `/api/workspaces/${currentWorkspace.id}/consoles/${selectedItem.id}/share`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access: shareAccess,
          shared_with:
            shareAccess === "shared" || shareAccess === "workspace"
              ? shareUserEntries
              : undefined,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (data.success) {
        setShareDialogOpen(false);
        setSelectedItem(null);
        setShareUserEntries([]);
        fetchConsoleEntries();
      }
    } catch (e: any) {
      console.error("Failed to update sharing:", e);
    }
  };

  const handleAddShareUser = () => {
    if (!shareUserEmail.trim()) return;
    const exists = shareUserEntries.some(e => e.userId === shareUserEmail);
    if (!exists) {
      setShareUserEntries([
        ...shareUserEntries,
        { userId: shareUserEmail.trim(), access: shareUserPermission },
      ]);
    }
    setShareUserEmail("");
  };

  const handleRemoveShareUser = (userId: string) => {
    setShareUserEntries(shareUserEntries.filter(e => e.userId !== userId));
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

  // DnD handlers
  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const findInAll = (nodes: ConsoleEntry[]): ConsoleEntry | null => {
      for (const node of nodes) {
        if (node.id === active.id) return node;
        if (node.isDirectory && node.children) {
          const found = findInAll(node.children);
          if (found) return found;
        }
      }
      return null;
    };
    const item = findInAll(myConsoles);
    if (item) setDraggedItem(item);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over } = event;
    if (over) {
      setDropTargetId(over.id as string);
    } else {
      setDropTargetId(null);
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setDraggedItem(null);
    setDropTargetId(null);

    if (!over || !currentWorkspace || active.id === over.id) return;

    const dragId = active.id as string;
    const dropId = over.id as string;

    const findInTree = (nodes: ConsoleEntry[]): ConsoleEntry | null => {
      for (const node of nodes) {
        if (node.id === dragId) return node;
        if (node.isDirectory && node.children) {
          const found = findInTree(node.children);
          if (found) return found;
        }
      }
      return null;
    };

    const findDropTarget = (nodes: ConsoleEntry[]): ConsoleEntry | null => {
      for (const node of nodes) {
        if (node.id === dropId) return node;
        if (node.isDirectory && node.children) {
          const found = findDropTarget(node.children);
          if (found) return found;
        }
      }
      return null;
    };

    const draggedNode = findInTree(myConsoles);
    const dropTarget = findDropTarget(myConsoles);

    if (!draggedNode || !dropTarget?.isDirectory) return;
    if (!isOwner(draggedNode)) return;

    if (draggedNode.isDirectory) {
      await moveFolder(currentWorkspace.id, dragId, dropId);
    } else {
      await moveConsole(currentWorkspace.id, dragId, dropId);
    }
  };

  const getAccessIcon = (node: ConsoleEntry) => {
    if (isOwner(node)) return null;
    const nodeAccess = node.access || "private";

    if (nodeAccess === "workspace") {
      const sharedAccess = node.shared_with?.find(
        e => e.userId === user?.id,
      )?.access;
      if (sharedAccess === "write") {
        return (
          <Tooltip title="Editable">
            <PencilIcon
              size={14}
              strokeWidth={1.5}
              style={{ opacity: 0.5, flexShrink: 0 }}
            />
          </Tooltip>
        );
      }
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

    if (nodeAccess === "shared") {
      const sharedAccess = node.shared_with?.find(
        e => e.userId === user?.id,
      )?.access;
      if (sharedAccess === "write") {
        return (
          <Tooltip title="Shared (editable)">
            <PencilIcon
              size={14}
              strokeWidth={1.5}
              style={{ opacity: 0.5, flexShrink: 0 }}
            />
          </Tooltip>
        );
      }
      return (
        <Tooltip title="Shared (read-only)">
          <LockIcon
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
        border: "1px solid",
        borderColor: "inherit",
        borderRadius: 3,
        padding: "1px 4px",
        fontSize: "0.9rem",
        width: "100%",
        outline: "none",
        background: "transparent",
        color: "inherit",
        fontFamily: "inherit",
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
              disabled={readOnlyContext || !isOwner(node)}
            >
              <ListItemButton
                onClick={() => handleFolderToggle(node.path)}
                onContextMenu={e => handleContextMenu(e, node, readOnlyContext)}
                onDoubleClick={e => {
                  if (!readOnlyContext && isOwner(node)) {
                    e.stopPropagation();
                    startInlineRename(node);
                  }
                }}
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
          disabled={readOnlyContext || !isOwner(node)}
        >
          <ListItemButton
            onClick={() => handleFileClick(node)}
            onContextMenu={e => handleContextMenu(e, node, readOnlyContext)}
            onDoubleClick={e => {
              if (isOwner(node)) {
                e.stopPropagation();
                startInlineRename(node);
              }
            }}
            selected={isActive}
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
  } | null>(null);

  const handleSectionContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setSectionContextMenu({
      mouseX: event.clientX + 2,
      mouseY: event.clientY - 6,
    });
  };

  const renderSectionHeader = (
    label: string,
    icon: React.ReactNode,
    isExpanded: boolean,
    onToggle: () => void,
    count: number,
    onCtxMenu?: (e: React.MouseEvent) => void,
  ) => (
    <ListItemButton
      onClick={onToggle}
      onContextMenu={onCtxMenu}
      sx={{ py: 0.25, pl: 0.5 }}
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
                countConsoles(myConsoles),
                handleSectionContextMenu,
              )}
              {myConsolesExpanded && (
                <>
                  {myConsoles.length > 0
                    ? renderTree(myConsoles, 1)
                    : renderEmptyPlaceholder("No consoles yet")}
                </>
              )}

              {/* Shared with me */}
              {renderSectionHeader(
                "Shared with me",
                <UsersIcon strokeWidth={1.5} size={18} />,
                sharedWithMeExpanded,
                () => setSharedWithMeExpanded(!sharedWithMeExpanded),
                countConsoles(sharedWithMe),
              )}
              {sharedWithMeExpanded && (
                <>
                  {sharedWithMe.length > 0
                    ? renderTree(sharedWithMe, 1, true)
                    : renderEmptyPlaceholder("No shared consoles yet")}
                </>
              )}

              {/* Shared with workspace */}
              {renderSectionHeader(
                "Workspace",
                <GlobeIcon strokeWidth={1.5} size={18} />,
                sharedWithWorkspaceExpanded,
                () =>
                  setSharedWithWorkspaceExpanded(!sharedWithWorkspaceExpanded),
                countConsoles(sharedWithWorkspace),
                handleSectionContextMenu,
              )}
              {sharedWithWorkspaceExpanded && (
                <>
                  {sharedWithWorkspace.length > 0
                    ? renderTree(sharedWithWorkspace, 1, true)
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
        {/* Owner actions (items in My Consoles section, readOnly=false) */}
        {contextMenu && !contextMenu.readOnly && (
          <MenuItem
            onClick={() => contextMenu && startInlineRename(contextMenu.item)}
          >
            <EditIcon sx={{ mr: 1 }} fontSize="small" />
            Rename
          </MenuItem>
        )}
        {contextMenu && !contextMenu.readOnly && (
          <MenuItem
            onClick={() => contextMenu && handleDelete(contextMenu.item)}
          >
            <DeleteIcon sx={{ mr: 1 }} fontSize="small" />
            Delete
          </MenuItem>
        )}
        {contextMenu && !contextMenu.readOnly && (
          <MenuItem
            onClick={() => contextMenu && handleShare(contextMenu.item)}
          >
            <ShareIcon sx={{ mr: 1 }} fontSize="small" />
            Share
          </MenuItem>
        )}
        {contextMenu && !contextMenu.readOnly && (
          <MenuItem
            onClick={() => contextMenu && handleMoveTo(contextMenu.item)}
          >
            <MoveIcon sx={{ mr: 1 }} fontSize="small" />
            Move to...
          </MenuItem>
        )}
        {contextMenu?.item.isDirectory && !contextMenu.readOnly && (
          <MenuItem
            onClick={() => {
              if (contextMenu.item.id) {
                handleCreateFolderInParent(contextMenu.item.id);
              }
              handleContextMenuClose();
            }}
          >
            <CreateFolderIcon sx={{ mr: 1 }} fontSize="small" />
            New Subfolder
          </MenuItem>
        )}
        {/* Read-only context (shared sections): Open for consoles */}
        {contextMenu &&
          contextMenu.readOnly &&
          !contextMenu.item.isDirectory && (
            <MenuItem
              onClick={() => {
                if (contextMenu.item.id) {
                  handleFileClick(contextMenu.item);
                }
                handleContextMenuClose();
              }}
            >
              <DuplicateIcon sx={{ mr: 1 }} fontSize="small" />
              Open
            </MenuItem>
          )}
      </Menu>

      {/* Section Header Context Menu (My Consoles / Workspace right-click) */}
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
            setSectionContextMenu(null);
            handleCreateFolder();
          }}
        >
          <CreateFolderIcon sx={{ mr: 1 }} fontSize="small" />
          New Folder
        </MenuItem>
      </Menu>

      {/* Create Folder Dialog */}
      <Dialog
        open={folderDialogOpen}
        onClose={handleFolderDialogClose}
        maxWidth="sm"
        fullWidth
        TransitionProps={{
          onEntered: () => {
            setTimeout(() => {
              const input = document.querySelector(
                'input[name="folderName"]',
              ) as HTMLInputElement;
              if (input) {
                input.focus();
                input.select();
              }
            }, 100);
          },
        }}
      >
        <DialogTitle>
          {selectedParentFolder ? "Create New Subfolder" : "Create New Folder"}
        </DialogTitle>
        <DialogContent>
          <TextField
            name="folderName"
            autoFocus
            margin="dense"
            label="Folder Name"
            fullWidth
            variant="outlined"
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && newFolderName.trim()) {
                handleFolderCreate();
              }
            }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck="false"
            helperText="Organize your consoles by creating folders. Right-click folders to create subfolders."
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleFolderDialogClose}>Cancel</Button>
          <Button
            onClick={handleFolderCreate}
            disabled={!newFolderName.trim()}
            variant="contained"
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

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

      {/* Share Dialog */}
      <Dialog
        open={shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Share &ldquo;{selectedItem?.name}&rdquo;</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2, color: "text.secondary" }}>
            Choose who can access this{" "}
            {selectedItem?.isDirectory ? "folder" : "console"} and what they can
            do.
            {selectedItem?.isDirectory &&
              " Sharing a folder shares its entire contents."}
          </Typography>
          <FormControl fullWidth sx={{ mt: 1 }}>
            <InputLabel id="share-access-label">Visibility</InputLabel>
            <MuiSelect
              labelId="share-access-label"
              value={shareAccess}
              label="Visibility"
              onChange={(e: SelectChangeEvent) =>
                setShareAccess(e.target.value as ConsoleAccessLevel)
              }
            >
              <MenuItem value="private">
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <LockIcon size={16} />
                  Private — Only you
                </Box>
              </MenuItem>
              <MenuItem value="shared">
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <UsersIcon size={16} />
                  Shared — Specific people
                </Box>
              </MenuItem>
              <MenuItem value="workspace">
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  <GlobeIcon size={16} />
                  Workspace — Everyone (read-only by default)
                </Box>
              </MenuItem>
            </MuiSelect>
          </FormControl>

          {(shareAccess === "shared" || shareAccess === "workspace") && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="body2" sx={{ mb: 1, fontWeight: 500 }}>
                {shareAccess === "shared"
                  ? "People with access"
                  : "Grant write access to specific people"}
              </Typography>

              {shareUserEntries.map(entry => (
                <Box
                  key={entry.userId}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    mb: 0.5,
                    py: 0.5,
                    px: 1,
                    borderRadius: 1,
                    backgroundColor: "action.hover",
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      flex: 1,
                      fontFamily: "monospace",
                      fontSize: "0.85rem",
                    }}
                  >
                    {entry.userId}
                  </Typography>
                  <Chip
                    label={entry.access}
                    size="small"
                    color={entry.access === "write" ? "primary" : "default"}
                    sx={{ height: 20, fontSize: "0.7rem" }}
                  />
                  <IconButton
                    size="small"
                    onClick={() => handleRemoveShareUser(entry.userId)}
                    sx={{ p: 0.25 }}
                  >
                    <CloseIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Box>
              ))}

              <Box
                sx={{ display: "flex", gap: 1, mt: 1, alignItems: "flex-end" }}
              >
                <TextField
                  size="small"
                  label="User ID or email"
                  value={shareUserEmail}
                  onChange={e => setShareUserEmail(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") handleAddShareUser();
                  }}
                  sx={{ flex: 1 }}
                />
                <FormControl size="small" sx={{ minWidth: 100 }}>
                  <MuiSelect
                    value={shareUserPermission}
                    onChange={(e: SelectChangeEvent) =>
                      setShareUserPermission(e.target.value as "read" | "write")
                    }
                  >
                    <MenuItem value="read">Read</MenuItem>
                    <MenuItem value="write">Write</MenuItem>
                  </MuiSelect>
                </FormControl>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleAddShareUser}
                  disabled={!shareUserEmail.trim()}
                  startIcon={<PersonAddIcon />}
                >
                  Add
                </Button>
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShareDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleShareConfirm} variant="contained">
            Save
          </Button>
        </DialogActions>
      </Dialog>

      {/* Move To Dialog */}
      <MoveToDialog
        open={moveDialogOpen}
        onClose={() => {
          setMoveDialogOpen(false);
          setSelectedItem(null);
        }}
        onMove={handleMoveConfirm}
        itemName={selectedItem?.name || ""}
        isDirectory={selectedItem?.isDirectory || false}
      />
    </Box>
  );
}

/** Wrapper that makes a tree item draggable */
function DraggableTreeItem({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    disabled,
  });

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}

export default forwardRef(ConsoleExplorer);
