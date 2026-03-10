import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
  type ReactNode,
} from "react";
import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
  Menu,
  MenuItem,
  Tooltip,
  Chip,
  Divider,
} from "@mui/material";
import {
  SquareTerminal as ConsoleIcon,
  FolderClosed as FolderIcon,
  FolderOpen as FolderOpenIcon,
  ChevronRight as ChevronRightIcon,
  ChevronDown as ChevronDownIcon,
  Eye as EyeIcon,
  Globe as GlobeIcon,
  Pencil as EditIcon,
  Trash2 as DeleteIcon,
  Copy as DuplicateIcon,
  Info as InfoIcon,
  FolderPlus as CreateFolderIcon,
  FolderInput as MoveIcon,
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
} from "../store/consoleTreeStore";
import { useAuth } from "../contexts/auth-context";

// ── Types ──

export interface ConsoleTreeProps {
  mode: "sidebar" | "picker";

  onFileOpen?: (node: ConsoleEntry) => void;

  /** Picker mode: called when a file (console) is clicked */
  onFileClick?: (node: ConsoleEntry) => void;

  /** Picker mode: called when the selected location changes */
  onLocationChange?: (
    folderId: string | null,
    section: "my" | "workspace",
  ) => void;

  /** Picker mode: externally controlled selected folder */
  selectedLocationId?: string | null;

  /** Auto-expand to this folder on mount and select it */
  initialFolderId?: string | null;

  /** Which section the initialFolderId belongs to */
  initialSection?: "my" | "workspace";

  showFiles?: boolean;
  enableDragDrop?: boolean;

  enableDuplicate?: boolean;
  enableInfo?: boolean;
  enableDelete?: boolean;
  enableRename?: boolean;
  enableMove?: boolean;

  /** Sidebar-only callbacks */
  onMoveRequest?: (item: ConsoleEntry) => void;
  onInfoRequest?: (item: ConsoleEntry) => void;
  onFolderInfoRequest?: (item: ConsoleEntry) => void;
  onDeleteRequest?: (item: ConsoleEntry) => void;
  onSoftDelete?: (item: ConsoleEntry) => void;
  onDuplicate?: (item: ConsoleEntry) => void;
  onUndo?: () => void;

  /** Optional external search filter */
  searchQuery?: string;
}

export interface ConsoleTreeRef {
  createFolder: (
    parentId: string | null,
    access?: "private" | "workspace",
  ) => void;
}

// ── Component ──

function ConsoleTreeInner(
  {
    mode,
    onFileOpen,
    onFileClick,
    onLocationChange,
    selectedLocationId,
    initialFolderId,
    initialSection,
    showFiles = true,
    enableDragDrop = true,
    enableDuplicate = false,
    enableInfo = false,
    enableDelete = true,
    enableRename = true,
    enableMove = false,
    onMoveRequest,
    onInfoRequest,
    onFolderInfoRequest,
    onDeleteRequest,
    onSoftDelete,
    onDuplicate,
    onUndo,
    searchQuery = "",
  }: ConsoleTreeProps,
  ref: React.Ref<ConsoleTreeRef>,
) {
  const { currentWorkspace, members } = useWorkspace();
  const { user } = useAuth();

  const myConsolesMap = useConsoleTreeStore(state => state.myConsoles);
  const sharedWithWorkspaceMap = useConsoleTreeStore(
    state => state.sharedWithWorkspace,
  );
  const moveConsole = useConsoleTreeStore(state => state.moveConsole);
  const moveFolder = useConsoleTreeStore(state => state.moveFolder);
  const renameItem = useConsoleTreeStore(state => state.renameItem);
  const deleteItem = useConsoleTreeStore(state => state.deleteItem);

  const activeTabId = useConsoleStore(state => state.activeTabId);

  // Sidebar uses the shared persisted store; picker uses local state
  const storeExpandedFolders = useExplorerStore(
    state => state.console.expandedFolders,
  );
  const storeToggleFolder = useExplorerStore(state => state.toggleFolder);
  const storeExpandFolder = useExplorerStore(state => state.expandFolder);

  const [localExpandedFolders, setLocalExpandedFolders] = useState<Set<string>>(
    () => new Set(storeExpandedFolders),
  );

  const expandedFolders =
    mode === "sidebar" ? storeExpandedFolders : localExpandedFolders;

  const toggleFolder = useCallback(
    (path: string) => {
      if (mode === "sidebar") {
        storeToggleFolder(path);
      } else {
        setLocalExpandedFolders(prev => {
          const next = new Set(prev);
          if (next.has(path)) {
            next.delete(path);
          } else {
            next.add(path);
          }
          return next;
        });
      }
    },
    [mode, storeToggleFolder],
  );

  const expandFolder = useCallback(
    (path: string) => {
      if (mode === "sidebar") {
        storeExpandFolder(path);
      } else {
        setLocalExpandedFolders(prev => {
          if (prev.has(path)) return prev;
          const next = new Set(prev);
          next.add(path);
          return next;
        });
      }
    },
    [mode, storeExpandFolder],
  );

  const myConsoles = currentWorkspace
    ? myConsolesMap[currentWorkspace.id] || []
    : [];
  const sharedWithWorkspace = currentWorkspace
    ? sharedWithWorkspaceMap[currentWorkspace.id] || []
    : [];

  // Section expanded states
  const [myConsolesExpanded, setMyConsolesExpanded] = useState(true);
  const [sharedWithWorkspaceExpanded, setSharedWithWorkspaceExpanded] =
    useState(true);

  // Inline rename
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // DnD
  const [draggedItem, setDraggedItem] = useState<ConsoleEntry | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  // Context menus
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    item: ConsoleEntry;
    readOnly?: boolean;
  } | null>(null);
  const [sectionContextMenu, setSectionContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    section: "my" | "workspace";
  } | null>(null);

  // Keyboard selection
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Picker mode: internal selected location (when not externally controlled)
  const [internalSelectedLocation, setInternalSelectedLocation] = useState<
    string | null
  >(null);
  const [pickerSection, setPickerSection] = useState<"my" | "workspace">("my");

  const currentSelectedLocation =
    selectedLocationId !== undefined
      ? selectedLocationId
      : internalSelectedLocation;

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-expand to initialFolderId on mount
  const [didInitialExpand, setDidInitialExpand] = useState(false);

  useEffect(() => {
    if (didInitialExpand || !initialFolderId) return;

    const findAncestorPaths = (
      nodes: ConsoleEntry[],
      targetId: string,
      ancestors: string[],
    ): string[] | null => {
      for (const node of nodes) {
        if (node.id === targetId) return ancestors;
        if (node.isDirectory && node.children) {
          const result = findAncestorPaths(node.children, targetId, [
            ...ancestors,
            node.path,
          ]);
          if (result) return result;
        }
      }
      return null;
    };

    let paths = findAncestorPaths(myConsoles, initialFolderId, []);
    let section: "my" | "workspace" = initialSection ?? "my";
    if (!paths) {
      paths = findAncestorPaths(sharedWithWorkspace, initialFolderId, []);
      if (paths) section = "workspace";
    }

    if (paths) {
      for (const p of paths) {
        expandFolder(p);
      }
      // Also expand the target folder itself
      const targetNode = findNodeById(initialFolderId) ?? null;
      if (targetNode?.isDirectory) {
        expandFolder(targetNode.path);
      }
    }

    if (section === "my") {
      setMyConsolesExpanded(true);
    } else {
      setSharedWithWorkspaceExpanded(true);
    }

    setInternalSelectedLocation(initialFolderId);
    setPickerSection(section);
    onLocationChange?.(initialFolderId, section);
    setDidInitialExpand(true);

    requestAnimationFrame(() => {
      const el = scrollContainerRef.current?.querySelector(
        `[data-node-id="${initialFolderId}"]`,
      );
      el?.scrollIntoView({ block: "center" });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFolderId, myConsoles, sharedWithWorkspace, didInitialExpand]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  // ── Search filtering ──

  const filterTree = useCallback(
    (nodes: ConsoleEntry[], query: string): ConsoleEntry[] => {
      const lower = query.toLowerCase();
      const result: ConsoleEntry[] = [];
      for (const node of nodes) {
        if (node.isDirectory && node.children) {
          const filteredChildren = filterTree(node.children, query);
          if (filteredChildren.length > 0) {
            result.push({ ...node, children: filteredChildren });
          } else if (node.name.toLowerCase().includes(lower)) {
            result.push(node);
          }
        } else if (node.name.toLowerCase().includes(lower)) {
          result.push(node);
        }
      }
      return result;
    },
    [],
  );

  const filteredMyConsoles =
    searchQuery.length >= 2 ? filterTree(myConsoles, searchQuery) : myConsoles;
  const filteredWorkspaceConsoles =
    searchQuery.length >= 2
      ? filterTree(sharedWithWorkspace, searchQuery)
      : sharedWithWorkspace;

  // ── Helpers ──

  const isOwner = (item: ConsoleEntry): boolean => {
    return item.owner_id === user?.id;
  };

  const canManage = (item: ConsoleEntry): boolean => {
    if (isOwner(item)) return true;
    const myRole = members.find(m => m.userId === user?.id)?.role;
    return myRole === "owner" || myRole === "admin";
  };

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

  const findNodeById = useCallback(
    (targetId: string): ConsoleEntry | null => {
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
    },
    [myConsoles, sharedWithWorkspace],
  );

  // ── Inline rename ──

  const startInlineRename = (item: ConsoleEntry) => {
    if (!item.id || !enableRename) return;
    setRenamingItemId(item.id);
    setRenameValue(item.name);
    handleContextMenuClose();
  };

  const commitInlineRename = async () => {
    if (!currentWorkspace || !renamingItemId || !renameValue.trim()) {
      cancelInlineRename();
      return;
    }

    const item = findNodeById(renamingItemId);
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

  // ── Folder creation (exposed via callback) ──

  const createFolderInline = useCallback(
    async (parentId: string | null, access?: "private" | "workspace") => {
      if (!currentWorkspace) return;
      const createFolder = useConsoleTreeStore.getState().createFolder;
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
    },
    [currentWorkspace],
  );

  useImperativeHandle(
    ref,
    () => ({
      createFolder: createFolderInline,
    }),
    [createFolderInline],
  );

  // ── Context menu handlers ──

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

  const handleDelete = (item: ConsoleEntry) => {
    if (item.isDirectory) {
      onDeleteRequest?.(item);
    } else {
      onSoftDelete?.(item);
    }
    handleContextMenuClose();
  };

  const handleDeleteInPicker = async (item: ConsoleEntry) => {
    if (!currentWorkspace || !item.id) return;
    handleContextMenuClose();
    await deleteItem(currentWorkspace.id, item.id, item.isDirectory);
  };

  // ── DnD handlers ──

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

    if (dropId.startsWith("__folder_content_")) {
      const parentFolderId = dropId.replace("__folder_content_", "");
      if (dragResult.node.isDirectory) {
        await moveFolder(currentWorkspace.id, dragId, parentFolderId);
      } else {
        await moveConsole(currentWorkspace.id, dragId, parentFolderId);
      }
      return;
    }

    const dropResult = findInAnyTree(dropId);
    if (!dropResult?.node.isDirectory) return;

    if (dragResult.node.isDirectory) {
      await moveFolder(currentWorkspace.id, dragId, dropId);
    } else {
      await moveConsole(currentWorkspace.id, dragId, dropId);
    }
  };

  // ── Keyboard navigation ──

  const flatNodeIds = (() => {
    const ids: string[] = [];
    const collect = (nodes: ConsoleEntry[], sectionExpanded: boolean) => {
      if (!sectionExpanded) return;
      for (const node of nodes) {
        if (!showFiles && !node.isDirectory) continue;
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
    collect(filteredMyConsoles, myConsolesExpanded);
    collect(filteredWorkspaceConsoles, sharedWithWorkspaceExpanded);
    return ids;
  })();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const focusId =
        selectedNodeId || (mode === "sidebar" ? activeTabId : null);
      const focusItem = focusId ? findNodeById(focusId) : null;
      const meta = e.metaKey || e.ctrlKey;

      if (e.key === "F2" && focusItem && enableRename) {
        e.preventDefault();
        startInlineRename(focusItem);
        return;
      }

      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        focusItem &&
        !meta &&
        enableDelete
      ) {
        e.preventDefault();
        if (mode === "sidebar") {
          handleDelete(focusItem);
        } else {
          handleDeleteInPicker(focusItem);
        }
        return;
      }

      if (
        meta &&
        e.key === "d" &&
        focusItem &&
        !focusItem.isDirectory &&
        enableDuplicate
      ) {
        e.preventDefault();
        onDuplicate?.(focusItem);
        return;
      }

      if (
        meta &&
        e.key === "i" &&
        focusItem &&
        !focusItem.isDirectory &&
        enableInfo
      ) {
        e.preventDefault();
        onInfoRequest?.(focusItem);
        return;
      }

      if (meta && e.key === "z" && !e.shiftKey && onUndo) {
        e.preventDefault();
        onUndo();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const idx = focusId ? flatNodeIds.indexOf(focusId) : -1;
        const nextId = flatNodeIds[idx + 1];
        if (nextId) setSelectedNodeId(nextId);
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        const idx = focusId ? flatNodeIds.indexOf(focusId) : flatNodeIds.length;
        const prevId = flatNodeIds[idx - 1];
        if (prevId) setSelectedNodeId(prevId);
        return;
      }

      if (e.key === "ArrowRight" && focusItem?.isDirectory) {
        e.preventDefault();
        if (!expandedFolders.has(focusItem.path)) {
          toggleFolder(focusItem.path);
        }
        return;
      }

      if (e.key === "ArrowLeft" && focusItem?.isDirectory) {
        e.preventDefault();
        if (expandedFolders.has(focusItem.path)) {
          toggleFolder(focusItem.path);
        }
        return;
      }

      if (e.key === "Enter" && focusItem) {
        e.preventDefault();
        if (focusItem.isDirectory) {
          toggleFolder(focusItem.path);
          if (mode === "picker") {
            handlePickerSelect(focusItem);
          }
        } else if (mode === "sidebar") {
          onFileOpen?.(focusItem);
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
    mode,
  ]);

  // ── Picker selection ──

  const handlePickerSelect = (node: ConsoleEntry) => {
    if (!node.isDirectory) return;
    const result = findInAnyTree(node.id!);
    const section = result?.section ?? pickerSection;
    setInternalSelectedLocation(node.id ?? null);
    setPickerSection(section);
    onLocationChange?.(node.id ?? null, section);
  };

  const handlePickerSectionRootSelect = (section: "my" | "workspace") => {
    setInternalSelectedLocation(null);
    setPickerSection(section);
    onLocationChange?.(null, section);
  };

  // ── Access icon ──

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

  // ── Inline rename input ──

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

  // ── Tree rendering ──

  const renderTree = (
    nodes: ConsoleEntry[],
    depth = 0,
    readOnlyContext = false,
  ) => {
    return nodes.map(node => {
      if (!showFiles && !node.isDirectory) return null;

      if (node.isDirectory) {
        const isExpanded = expandedFolders.has(node.path);
        const nodeKey = node.id || node.path;
        const isDragOver =
          dropTargetId === node.id ||
          dropTargetId === `__folder_content_${node.id}`;
        const isRenaming = renamingItemId === node.id;
        const isPickerSelected =
          mode === "picker" && currentSelectedLocation === node.id;

        return (
          <div key={`dir-${nodeKey}`}>
            <DraggableTreeItem
              id={node.id || node.path}
              disabled={readOnlyContext || !enableDragDrop}
              isFolder
            >
              <ListItemButton
                data-node-id={node.id}
                onClick={() => {
                  setSelectedNodeId(node.id || null);
                  toggleFolder(node.path);
                  if (mode === "picker") {
                    handlePickerSelect(node);
                  }
                }}
                onContextMenu={e => handleContextMenu(e, node, readOnlyContext)}
                onDoubleClick={e => {
                  if (!readOnlyContext && enableRename) {
                    e.stopPropagation();
                    startInlineRename(node);
                  }
                }}
                selected={isPickerSelected || selectedNodeId === node.id}
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
              <DroppableFolderContent folderId={node.id || node.path}>
                <List component="div" disablePadding dense>
                  {node.children &&
                    renderTree(node.children, depth + 1, readOnlyContext)}
                </List>
              </DroppableFolderContent>
            )}
          </div>
        );
      }

      const nodeKey = node.id || node.path;
      const isActive =
        mode === "sidebar" && !!(node.id && activeTabId === node.id);
      const isRenaming = renamingItemId === node.id;

      return (
        <DraggableTreeItem
          key={`file-${nodeKey}`}
          id={node.id || node.path}
          disabled={readOnlyContext || !enableDragDrop}
        >
          <ListItemButton
            onClick={() => {
              setSelectedNodeId(node.id || null);
              if (mode === "sidebar") {
                onFileOpen?.(node);
              } else if (mode === "picker") {
                onFileClick?.(node);
              }
            }}
            onContextMenu={e => handleContextMenu(e, node, readOnlyContext)}
            onDoubleClick={e => {
              if (!readOnlyContext && enableRename) {
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

  // ── Section headers ──

  const countItems = (nodes: ConsoleEntry[]): number => {
    let count = 0;
    for (const node of nodes) {
      if (node.isDirectory && node.children) {
        count += countItems(node.children);
      } else if (!node.isDirectory) {
        count += 1;
      }
    }
    return count;
  };

  const renderSectionHeader = (
    label: string,
    icon: ReactNode,
    isExpanded: boolean,
    onToggle: () => void,
    count: number,
    onCtxMenu?: (e: React.MouseEvent) => void,
    droppableId?: string,
    section?: "my" | "workspace",
  ) => {
    const isDragOver = droppableId && dropTargetId === droppableId;
    const isPickerSelected =
      mode === "picker" &&
      currentSelectedLocation === null &&
      pickerSection === section;

    const header = (
      <ListItemButton
        onClick={() => {
          onToggle();
          if (mode === "picker" && section) {
            handlePickerSectionRootSelect(section);
          }
        }}
        onContextMenu={onCtxMenu}
        selected={isPickerSelected}
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

  // ── Main render ──

  const treeContent = (
    <List component="nav" dense>
      {renderSectionHeader(
        "My Consoles",
        <ConsoleIcon strokeWidth={1.5} size={18} />,
        myConsolesExpanded,
        () => setMyConsolesExpanded(!myConsolesExpanded),
        countItems(filteredMyConsoles),
        e => handleSectionContextMenu(e, "my"),
        enableDragDrop ? "__section_my" : undefined,
        "my",
      )}
      {myConsolesExpanded && (
        <>
          {filteredMyConsoles.length > 0
            ? renderTree(filteredMyConsoles, 1)
            : renderEmptyPlaceholder("No consoles yet")}
        </>
      )}

      {renderSectionHeader(
        "Workspace",
        <GlobeIcon strokeWidth={1.5} size={18} />,
        sharedWithWorkspaceExpanded,
        () => setSharedWithWorkspaceExpanded(!sharedWithWorkspaceExpanded),
        countItems(filteredWorkspaceConsoles),
        e => handleSectionContextMenu(e, "workspace"),
        enableDragDrop ? "__section_workspace" : undefined,
        "workspace",
      )}
      {sharedWithWorkspaceExpanded && (
        <>
          {filteredWorkspaceConsoles.length > 0
            ? renderTree(filteredWorkspaceConsoles, 1)
            : renderEmptyPlaceholder("No workspace consoles yet")}
        </>
      )}
    </List>
  );

  return (
    <Box
      sx={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}
    >
      <Box
        ref={scrollContainerRef}
        sx={{
          flexGrow: 1,
          overflowY: "auto",
          "&::-webkit-scrollbar": { width: "0.4em" },
          "&::-webkit-scrollbar-track": {
            boxShadow: "inset 0 0 6px rgba(0,0,0,0.00)",
          },
          "&::-webkit-scrollbar-thumb": {
            backgroundColor: "rgba(0,0,0,.1)",
            outline: "1px solid slategrey",
          },
        }}
      >
        {enableDragDrop ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            {treeContent}
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
        ) : (
          treeContent
        )}
      </Box>

      {/* Item context menu */}
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
        {contextMenu && enableRename && canManage(contextMenu.item) && (
          <MenuItem
            onClick={() => contextMenu && startInlineRename(contextMenu.item)}
          >
            <EditIcon size={16} strokeWidth={1.5} style={{ marginRight: 8 }} />
            Rename
          </MenuItem>
        )}
        {contextMenu && enableDuplicate && !contextMenu.item.isDirectory && (
          <MenuItem
            onClick={() => {
              if (contextMenu) {
                onDuplicate?.(contextMenu.item);
                handleContextMenuClose();
              }
            }}
          >
            <DuplicateIcon
              size={16}
              strokeWidth={1.5}
              style={{ marginRight: 8 }}
            />
            Duplicate
          </MenuItem>
        )}
        {contextMenu?.item.isDirectory && !contextMenu.readOnly && (
          <MenuItem
            onClick={() => {
              if (contextMenu.item.id) {
                createFolderInline(contextMenu.item.id);
                if (!expandedFolders.has(contextMenu.item.path)) {
                  toggleFolder(contextMenu.item.path);
                }
              }
              handleContextMenuClose();
            }}
          >
            <CreateFolderIcon
              size={16}
              strokeWidth={1.5}
              style={{ marginRight: 8 }}
            />
            New Subfolder
          </MenuItem>
        )}
        {contextMenu && enableMove && canManage(contextMenu.item) && (
          <MenuItem
            onClick={() => {
              if (contextMenu) {
                onMoveRequest?.(contextMenu.item);
                handleContextMenuClose();
              }
            }}
          >
            <MoveIcon size={16} strokeWidth={1.5} style={{ marginRight: 8 }} />
            Move to...
          </MenuItem>
        )}
        {contextMenu && enableInfo && !contextMenu.item.isDirectory && (
          <MenuItem
            onClick={() => {
              if (contextMenu) {
                onInfoRequest?.(contextMenu.item);
                handleContextMenuClose();
              }
            }}
          >
            <InfoIcon size={16} strokeWidth={1.5} style={{ marginRight: 8 }} />
            Information
          </MenuItem>
        )}
        {contextMenu && enableInfo && contextMenu.item.isDirectory && (
          <MenuItem
            onClick={() => {
              if (contextMenu) {
                onFolderInfoRequest?.(contextMenu.item);
                handleContextMenuClose();
              }
            }}
          >
            <InfoIcon size={16} strokeWidth={1.5} style={{ marginRight: 8 }} />
            Information
          </MenuItem>
        )}
        {contextMenu && enableDelete && canManage(contextMenu.item) && (
          <>
            <Divider />
            <MenuItem
              onClick={() => {
                if (contextMenu) {
                  if (mode === "sidebar") {
                    handleDelete(contextMenu.item);
                  } else {
                    handleDeleteInPicker(contextMenu.item);
                  }
                }
              }}
              sx={{ color: "error.main" }}
            >
              <DeleteIcon
                size={16}
                strokeWidth={1.5}
                style={{ marginRight: 8 }}
              />
              Delete
            </MenuItem>
          </>
        )}
      </Menu>

      {/* Section header context menu */}
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
              createFolderInline(null, "workspace");
            } else {
              createFolderInline(null, "private");
            }
          }}
        >
          <CreateFolderIcon
            size={16}
            strokeWidth={1.5}
            style={{ marginRight: 8 }}
          />
          New Folder
        </MenuItem>
      </Menu>
    </Box>
  );
}

const ConsoleTree = forwardRef<ConsoleTreeRef, ConsoleTreeProps>(
  ConsoleTreeInner,
);
export default ConsoleTree;

// ── DnD helper components ──

function DroppableSectionHeader({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id });
  return <div ref={setNodeRef}>{children}</div>;
}

function DroppableFolderContent({
  folderId,
  children,
}: {
  folderId: string;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({
    id: `__folder_content_${folderId}`,
  });
  return <div ref={setNodeRef}>{children}</div>;
}

function DraggableTreeItem({
  id,
  disabled,
  isFolder,
  children,
}: {
  id: string;
  disabled?: boolean;
  isFolder?: boolean;
  children: ReactNode;
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
