import {
  useState,
  forwardRef,
  useImperativeHandle,
  useEffect,
  useMemo,
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
import ConsoleFolderNavigatorDialog, {
  ConsoleScope,
} from "./ConsoleFolderNavigatorDialog";

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
  const createFolderEntry = useConsoleTreeStore(state => state.createFolder);
  const renameEntry = useConsoleTreeStore(state => state.renameEntry);
  const deleteEntry = useConsoleTreeStore(state => state.deleteEntry);
  const shareEntry = useConsoleTreeStore(state => state.shareEntry);
  const moveConsole = useConsoleTreeStore(state => state.moveConsole);
  const moveFolder = useConsoleTreeStore(state => state.moveFolder);
  const fetchConsoleContent = useConsoleStore(
    state => state.fetchConsoleContent,
  );
  const openTab = useConsoleStore(state => state.openTab);
  const setActiveTab = useConsoleStore(state => state.setActiveTab);

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
  const [selectedTreeItem, setSelectedTreeItem] = useState<ConsoleEntry | null>(
    null,
  );
  const [inlineRenameId, setInlineRenameId] = useState<string | null>(null);
  const [inlineRenameValue, setInlineRenameValue] = useState("");
  const [draggingItem, setDraggingItem] = useState<ConsoleEntry | null>(null);
  const [dropTargetFolderId, setDropTargetFolderId] = useState<string | null>(
    null,
  );
  const [dropTargetRootScope, setDropTargetRootScope] =
    useState<ConsoleScope | null>(null);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);

  function _errorFor(wid: string) {
    const map = useConsoleTreeStore.getState().error;
    return map[wid] || null;
  }

  const fetchConsoleEntries = async () => {
    if (!currentWorkspace) return;
    await refreshTree(currentWorkspace.id);
  };

  const folderPathById = useMemo(() => {
    const map = new Map<string, string>();
    const walk = (nodes: ConsoleEntry[]) => {
      for (const node of nodes) {
        if (node.isDirectory && node.id) {
          map.set(node.id, node.path);
          if (node.children?.length) {
            walk(node.children);
          }
        }
      }
    };
    walk(myConsoles);
    walk(sharedWithWorkspace);
    return map;
  }, [myConsoles, sharedWithWorkspace]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F2" || !selectedTreeItem) return;
      if (!isOwner(selectedTreeItem)) return;
      if (!selectedTreeItem.id) return;

      event.preventDefault();
      setInlineRenameId(selectedTreeItem.id);
      setInlineRenameValue(selectedTreeItem.name);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedTreeItem]);

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

    try {
      const result = await createFolderEntry(
        currentWorkspace.id,
        newFolderName.trim(),
        selectedParentFolder,
        false,
      );

      if (result.success) {
        handleFolderDialogClose();
        fetchConsoleEntries();
      } else {
        console.error("Failed to create folder:", result.error);
      }
    } catch (e: any) {
      console.error("Failed to create folder:", e);
    }
  };

  const handleContextMenu = (event: React.MouseEvent, item: ConsoleEntry) => {
    event.preventDefault();
    setContextMenu({
      mouseX: event.clientX + 2,
      mouseY: event.clientY - 6,
      item,
    });
  };

  const handleContextMenuClose = () => {
    setContextMenu(null);
  };

  const handleRename = (item: ConsoleEntry) => {
    if (!item.id) return;
    setSelectedTreeItem(item);
    setInlineRenameId(item.id);
    setInlineRenameValue(item.name);
    handleContextMenuClose();
  };

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

  const handleShareConfirm = async () => {
    if (!currentWorkspace || !selectedItem?.id) return;

    try {
      const result = await shareEntry(
        currentWorkspace.id,
        selectedItem,
        shareAccess,
        shareUserEntries,
      );
      if (result.success) {
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
    // For now, we store the email as userId placeholder — the backend will resolve
    // In a production app, you'd search workspace members by email first
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
    if (!item.owner_id) return true;
    return item.owner_id === user?.id;
  };

  const canWriteItem = (item: ConsoleEntry): boolean => {
    if (isOwner(item)) return true;
    if (item.access === "workspace") {
      const sharedAccess = item.shared_with?.find(e => e.userId === user?.id);
      return sharedAccess?.access === "write";
    }
    if (item.access === "shared") {
      const sharedAccess = item.shared_with?.find(e => e.userId === user?.id);
      return sharedAccess?.access === "write";
    }
    return false;
  };

  const handleInlineRenameConfirm = async () => {
    if (!currentWorkspace || !inlineRenameId || !inlineRenameValue.trim()) {
      return;
    }

    try {
      const targetItem =
        findEntryById(myConsoles, inlineRenameId) ||
        findEntryById(sharedWithWorkspace, inlineRenameId) ||
        findEntryById(sharedWithMe, inlineRenameId);
      if (!targetItem) return;

      const result = await renameEntry(
        currentWorkspace.id,
        targetItem,
        inlineRenameValue.trim(),
      );
      if (result.success) {
        setInlineRenameId(null);
        setInlineRenameValue("");
        fetchConsoleEntries();
      } else {
        console.error("Failed to rename item:", result.error);
      }
    } catch (e: any) {
      console.error("Failed to rename item:", e);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!currentWorkspace || !selectedItem) {
      return;
    }

    try {
      const result = await deleteEntry(currentWorkspace.id, selectedItem);
      if (result.success) {
        setDeleteDialogOpen(false);
        setSelectedItem(null);
        fetchConsoleEntries();
      } else {
        console.error("Failed to delete item:", result.error);
      }
    } catch (e: any) {
      console.error("Failed to delete item:", e);
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

  const findEntryById = (
    nodes: ConsoleEntry[],
    id: string,
  ): ConsoleEntry | null => {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.children?.length) {
        const child = findEntryById(node.children, id);
        if (child) return child;
      }
    }
    return null;
  };

  const handleDuplicate = async (item: ConsoleEntry) => {
    if (!currentWorkspace || !item.id || item.isDirectory) return;
    const data = await fetchConsoleContent(currentWorkspace.id, item.id);
    if (!data) return;

    const newId = openTab({
      title: `${item.name} copy`,
      content: data.content || "",
      connectionId: data.connectionId,
      databaseId: data.databaseId,
      databaseName: data.databaseName,
      kind: "console",
      isDirty: true,
      isSaved: false,
    });
    setActiveTab(newId);
    handleContextMenuClose();
  };

  const handleDragStart = (node: ConsoleEntry) => {
    setDraggingItem(node);
    setDropTargetFolderId(null);
    setDropTargetRootScope(null);
  };

  const resetDropState = () => {
    setDraggingItem(null);
    setDropTargetFolderId(null);
    setDropTargetRootScope(null);
  };

  const handleDropOnFolder = async (targetFolderId: string) => {
    if (!currentWorkspace || !draggingItem || !draggingItem.id) return;

    if (draggingItem.isDirectory) {
      if (draggingItem.id === targetFolderId) return;
      const draggingPath = folderPathById.get(draggingItem.id);
      const targetPath = folderPathById.get(targetFolderId);
      if (
        draggingPath &&
        targetPath &&
        targetPath.startsWith(`${draggingPath}/`)
      ) {
        return;
      }

      const result = await moveFolder(
        currentWorkspace.id,
        draggingItem.id,
        targetFolderId,
      );
      if (!result.success) {
        console.error(result.error || "Failed to move folder");
      }
    } else {
      const result = await moveConsole(
        currentWorkspace.id,
        draggingItem.id,
        targetFolderId,
      );
      if (!result.success) {
        console.error(result.error || "Failed to move console");
      }
    }
    resetDropState();
    fetchConsoleEntries();
  };

  const handleDropOnRoot = async (scope: ConsoleScope) => {
    if (!currentWorkspace || !draggingItem?.id) return;

    if (draggingItem.isDirectory) {
      const result = await moveFolder(
        currentWorkspace.id,
        draggingItem.id,
        null,
        scope,
      );
      if (!result.success) {
        console.error(result.error || "Failed to move folder");
      }
    } else {
      const result = await moveConsole(
        currentWorkspace.id,
        draggingItem.id,
        null,
        scope,
      );
      if (!result.success) {
        console.error(result.error || "Failed to move console");
      }
    }

    resetDropState();
    fetchConsoleEntries();
  };

  const handleMoveDialogConfirm = async (selection: {
    scope: ConsoleScope;
    folderId: string | null;
    folderPath: string;
  }) => {
    if (!currentWorkspace || !selectedItem?.id) return;

    let ok = false;
    if (selectedItem.isDirectory) {
      const result = await moveFolder(
        currentWorkspace.id,
        selectedItem.id,
        selection.folderId,
        selection.scope,
      );
      ok = result.success;
    } else {
      const result = await moveConsole(
        currentWorkspace.id,
        selectedItem.id,
        selection.folderId,
        selection.scope,
      );
      ok = result.success;
    }

    if (!ok) {
      console.error("Failed to move item");
    }
    setMoveDialogOpen(false);
    setSelectedItem(null);
    fetchConsoleEntries();
  };

  const handleNavigatorCreateFolder = async (
    folderName: string,
    parentId: string | null,
    scope: ConsoleScope,
  ) => {
    if (!currentWorkspace) return false;
    const result = await createFolderEntry(
      currentWorkspace.id,
      folderName,
      parentId,
      scope === "my",
    );
    if (!result.success) {
      console.error(result.error || "Failed to create folder");
      return false;
    }
    await fetchConsoleEntries();
    return true;
  };

  const renderTree = (nodes: ConsoleEntry[], depth = 0) => {
    return nodes.map(node => {
      if (node.isDirectory) {
        const isExpanded = expandedFolders.has(node.path);
        const nodeKey = node.id || node.path;
        return (
          <div key={`dir-${nodeKey}`}>
            <ListItemButton
              onClick={() => handleFolderToggle(node.path)}
              onContextMenu={e => handleContextMenu(e, node)}
              onDoubleClick={e => {
                e.stopPropagation();
                if (isOwner(node) && node.id) {
                  setInlineRenameId(node.id);
                  setInlineRenameValue(node.name);
                }
              }}
              onDragOver={e => {
                if (!draggingItem) return;
                e.preventDefault();
                if (node.id) {
                  setDropTargetFolderId(node.id);
                  setDropTargetRootScope(null);
                }
              }}
              onDrop={e => {
                e.preventDefault();
                if (node.id) {
                  void handleDropOnFolder(node.id);
                }
              }}
              draggable={isOwner(node)}
              onDragStart={() => handleDragStart(node)}
              onDragEnd={resetDropState}
              sx={{
                py: 0.25,
                pl: 0.5 + depth * 1.5,
                backgroundColor:
                  dropTargetFolderId === node.id ? "action.hover" : undefined,
              }}
              selected={selectedTreeItem?.id === node.id}
              onMouseDown={() => setSelectedTreeItem(node)}
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
              <ListItemText
                primary={
                  inlineRenameId === node.id ? (
                    <TextField
                      size="small"
                      value={inlineRenameValue}
                      onChange={e => setInlineRenameValue(e.target.value)}
                      onClick={e => e.stopPropagation()}
                      onKeyDown={e => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleInlineRenameConfirm();
                        }
                        if (e.key === "Escape") {
                          setInlineRenameId(null);
                          setInlineRenameValue("");
                        }
                      }}
                      onBlur={() => {
                        if (inlineRenameValue.trim()) {
                          void handleInlineRenameConfirm();
                        } else {
                          setInlineRenameId(null);
                        }
                      }}
                      autoFocus
                    />
                  ) : (
                    node.name
                  )
                }
                primaryTypographyProps={{
                  variant: "body2",
                  style: {
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  },
                }}
              />
            </ListItemButton>
            {isExpanded && (
              <List component="div" disablePadding dense>
                {node.children && renderTree(node.children, depth + 1)}
              </List>
            )}
          </div>
        );
      }
      const nodeKey = node.id || node.path;
      const isActive = !!(node.id && activeTabId === node.id);
      return (
        <ListItemButton
          key={`file-${nodeKey}`}
          onClick={() => handleFileClick(node)}
          onContextMenu={e => handleContextMenu(e, node)}
          onDoubleClick={e => {
            e.stopPropagation();
            if (isOwner(node) && node.id) {
              setInlineRenameId(node.id);
              setInlineRenameValue(node.name);
            }
          }}
          draggable={isOwner(node)}
          onDragStart={() => handleDragStart(node)}
          onDragEnd={resetDropState}
          onMouseDown={() => setSelectedTreeItem(node)}
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
          <ListItemText
            primary={
              inlineRenameId === node.id ? (
                <TextField
                  size="small"
                  value={inlineRenameValue}
                  onChange={e => setInlineRenameValue(e.target.value)}
                  onClick={e => e.stopPropagation()}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleInlineRenameConfirm();
                    }
                    if (e.key === "Escape") {
                      setInlineRenameId(null);
                      setInlineRenameValue("");
                    }
                  }}
                  onBlur={() => {
                    if (inlineRenameValue.trim()) {
                      void handleInlineRenameConfirm();
                    } else {
                      setInlineRenameId(null);
                    }
                  }}
                  autoFocus
                />
              ) : (
                node.name
              )
            }
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
          {getAccessIcon(node)}
        </ListItemButton>
      );
    });
  };

  const renderSectionHeader = (
    label: string,
    icon: React.ReactNode,
    isExpanded: boolean,
    onToggle: () => void,
    count: number,
  ) => (
    <ListItemButton onClick={onToggle} sx={{ py: 0.25, pl: 0.5 }}>
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

  const contextItem = contextMenu?.item || null;
  const showOwnerActions = !!contextItem && isOwner(contextItem);
  const showDuplicateAction =
    !!contextItem &&
    !contextItem.isDirectory &&
    !isOwner(contextItem) &&
    !canWriteItem(contextItem);

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
          <List component="nav" dense>
            {/* My Consoles */}
            {renderSectionHeader(
              "My Consoles",
              <ConsoleIcon strokeWidth={1.5} size={18} />,
              myConsolesExpanded,
              () => setMyConsolesExpanded(!myConsolesExpanded),
              countConsoles(myConsoles),
            )}
            {myConsolesExpanded && (
              <Box
                onDragOver={e => {
                  if (!draggingItem) return;
                  e.preventDefault();
                  setDropTargetFolderId(null);
                  setDropTargetRootScope("my");
                }}
                onDrop={e => {
                  e.preventDefault();
                  void handleDropOnRoot("my");
                }}
                sx={{
                  backgroundColor:
                    dropTargetRootScope === "my" ? "action.hover" : undefined,
                }}
              >
                {myConsoles.length > 0
                  ? renderTree(myConsoles, 1)
                  : renderEmptyPlaceholder("No consoles yet")}
              </Box>
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
                  ? renderTree(sharedWithMe, 1)
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
            )}
            {sharedWithWorkspaceExpanded && (
              <Box
                onDragOver={e => {
                  if (!draggingItem) return;
                  e.preventDefault();
                  setDropTargetFolderId(null);
                  setDropTargetRootScope("workspace");
                }}
                onDrop={e => {
                  e.preventDefault();
                  void handleDropOnRoot("workspace");
                }}
                sx={{
                  backgroundColor:
                    dropTargetRootScope === "workspace"
                      ? "action.hover"
                      : undefined,
                }}
              >
                {sharedWithWorkspace.length > 0
                  ? renderTree(sharedWithWorkspace, 1)
                  : renderEmptyPlaceholder("No workspace consoles yet")}
              </Box>
            )}
          </List>
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
        {contextItem && showOwnerActions && (
          <MenuItem onClick={() => handleRename(contextItem)}>
            <EditIcon sx={{ mr: 1 }} fontSize="small" />
            Rename
          </MenuItem>
        )}
        {contextItem && showOwnerActions && (
          <MenuItem onClick={() => handleDelete(contextItem)}>
            <DeleteIcon sx={{ mr: 1 }} fontSize="small" />
            Delete
          </MenuItem>
        )}
        {contextItem && showOwnerActions && (
          <MenuItem onClick={() => handleMoveTo(contextItem)}>
            <FolderOpenIcon
              strokeWidth={1.5}
              size={16}
              style={{ marginRight: 8 }}
            />
            Move to...
          </MenuItem>
        )}
        {contextItem && showOwnerActions && (
          <MenuItem onClick={() => handleShare(contextItem)}>
            <ShareIcon sx={{ mr: 1 }} fontSize="small" />
            Share
          </MenuItem>
        )}
        {contextItem?.isDirectory && showOwnerActions && (
          <MenuItem
            onClick={() => {
              if (contextItem.id) {
                handleCreateFolderInParent(contextItem.id);
              }
              handleContextMenuClose();
            }}
          >
            <CreateFolderIcon sx={{ mr: 1 }} fontSize="small" />
            New Subfolder
          </MenuItem>
        )}
        {contextItem && showDuplicateAction && (
          <MenuItem onClick={() => handleDuplicate(contextItem)}>
            <ConsoleIcon
              strokeWidth={1.5}
              size={16}
              style={{ marginRight: 8 }}
            />
            Duplicate
          </MenuItem>
        )}
        {contextItem && !showOwnerActions && !showDuplicateAction && (
          <MenuItem disabled>No actions available</MenuItem>
        )}
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

          {/* Per-user sharing UI for "shared" and "workspace" modes */}
          {(shareAccess === "shared" || shareAccess === "workspace") && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="body2" sx={{ mb: 1, fontWeight: 500 }}>
                {shareAccess === "shared"
                  ? "People with access"
                  : "Grant write access to specific people"}
              </Typography>

              {/* Existing shared users */}
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

              {/* Add user */}
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

      <ConsoleFolderNavigatorDialog
        open={moveDialogOpen}
        title={`Move ${selectedItem?.isDirectory ? "Folder" : "Console"}`}
        confirmLabel="Move"
        myConsoles={myConsoles}
        sharedWithWorkspace={sharedWithWorkspace}
        onClose={() => {
          setMoveDialogOpen(false);
          setSelectedItem(null);
        }}
        onConfirm={selection => void handleMoveDialogConfirm(selection)}
        onCreateFolder={handleNavigatorCreateFolder}
      />
    </Box>
  );
}

export default forwardRef(ConsoleExplorer);
