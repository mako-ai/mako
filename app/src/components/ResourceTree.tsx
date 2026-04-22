import React, {
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Box,
  Divider,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText as MuiListItemText,
  Menu,
  MenuItem,
  Typography,
} from "@mui/material";
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  Info,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { filterTree } from "../store/lib/tree-helpers";
import {
  DraggableFolderScope,
  DraggableTreeItem,
  DroppableFolderContent,
  SectionScope,
} from "./resource-tree/dnd";

// Pixel height of a single tree row. Used to stack sticky folder/section
// headers so each ancestor pins one row below its parent as the user scrolls.
// Keep this in sync with the `minHeight` / vertical padding set in
// `buildRowSx` and on section headers.
const ROW_HEIGHT = 24;

// Width of the leading chevron / icon column. Used for both the folder
// chevron and (when `hideFolderIcon` is on) the file icon so they line up
// vertically across sibling rows.
const ICON_COL_WIDTH = 20;
import {
  findNodeInSections,
  getFolderDropTargetId,
  resolveTreeDropTarget,
} from "./resource-tree/utils";

export interface ResourceTreeNode {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  children?: ResourceTreeNode[];
  access?: "private" | "workspace";
  owner_id?: string;
  readOnly?: boolean;
}

export interface ResourceTreeSection {
  key: string;
  label: string;
  icon?: ReactNode;
  nodes: ResourceTreeNode[];
  droppableId?: string;
  defaultAccess?: "private" | "workspace";
}

export interface CreatedFolderResult {
  id: string;
  name: string;
}

export interface ResourceTreeRef {
  createFolder: (parentId: string | null, access?: string) => Promise<void>;
}

export interface ResourceTreeProps {
  sections: ResourceTreeSection[];
  mode?: "sidebar" | "picker";
  activeItemId?: string | null;
  searchQuery?: string;

  getItemIcon?: (node: ResourceTreeNode) => ReactNode;
  showFiles?: boolean;
  /**
   * When true, folder rows render only a chevron + name (no folder icon), and
   * file rows drop the hidden chevron placeholder so their icon sits in the
   * chevron column. Produces a Cursor-style compact tree.
   */
  hideFolderIcon?: boolean;

  enableDragDrop?: boolean;
  enableRename?: boolean;
  enableDuplicate?: boolean;
  enableDelete?: boolean;
  enableMove?: boolean;
  enableInfo?: boolean;
  enableNewFolder?: boolean;

  onItemClick?: (node: ResourceTreeNode) => void;
  onPickerFileClick?: (node: ResourceTreeNode) => void;
  onLocationChange?: (folderId: string | null, sectionKey: string) => void;
  selectedLocationId?: string | null;
  selectedSectionKey?: string;
  initialFolderId?: string | null;
  initialSectionKey?: string;

  onMoveItem?: (
    itemId: string,
    targetFolderId: string | null,
    access?: string,
  ) => void;
  onMoveFolder?: (
    folderId: string,
    parentId: string | null,
    access?: string,
  ) => void;
  onRenameItem?: (id: string, name: string, isDirectory: boolean) => void;
  onDeleteItem?: (node: ResourceTreeNode) => void;
  onDuplicateItem?: (node: ResourceTreeNode) => void;
  onCreateFolder?: (
    parentId: string | null,
    access?: string,
  ) => Promise<CreatedFolderResult | null>;
  onInfoRequest?: (node: ResourceTreeNode) => void;
  onFolderInfoRequest?: (node: ResourceTreeNode) => void;
  onMoveRequest?: (node: ResourceTreeNode) => void;
  onResortItem?: (id: string) => void;
  onUndo?: () => void;

  isFolderExpanded: (expansionKey: string) => boolean;
  onToggleFolder: (expansionKey: string) => void;
  onExpandFolder: (expansionKey: string) => void;
  getFolderExpansionKey?: (node: ResourceTreeNode) => string;

  canManageItem?: (node: ResourceTreeNode) => boolean;
}

const collisionDetectionStrategy: CollisionDetection = args => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

function ResourceTreeInner(
  {
    sections,
    mode = "sidebar",
    activeItemId,
    searchQuery = "",
    getItemIcon,
    showFiles = true,
    hideFolderIcon = false,
    enableDragDrop = true,
    enableRename = true,
    enableDuplicate = false,
    enableDelete = true,
    enableMove = false,
    enableInfo = false,
    enableNewFolder = true,
    onItemClick,
    onPickerFileClick,
    onLocationChange,
    selectedLocationId,
    selectedSectionKey,
    initialFolderId,
    initialSectionKey,
    onMoveItem,
    onMoveFolder,
    onRenameItem,
    onDeleteItem,
    onDuplicateItem,
    onCreateFolder,
    onInfoRequest,
    onFolderInfoRequest,
    onMoveRequest,
    onResortItem,
    onUndo,
    isFolderExpanded,
    onToggleFolder,
    onExpandFolder,
    getFolderExpansionKey,
    canManageItem,
  }: ResourceTreeProps,
  ref: React.Ref<ResourceTreeRef>,
) {
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [contextMenu, setContextMenu] = useState<{
    anchorPosition: { top: number; left: number };
    item: ResourceTreeNode;
    readOnly: boolean;
  } | null>(null);
  const [sectionContextMenu, setSectionContextMenu] = useState<{
    anchorPosition: { top: number; left: number };
    sectionKey: string;
  } | null>(null);

  const [sectionExpanded, setSectionExpanded] = useState<
    Record<string, boolean>
  >(() => Object.fromEntries(sections.map(section => [section.key, true])));

  const [draggedNode, setDraggedNode] = useState<ResourceTreeNode | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [pendingCreatedFolderId, setPendingCreatedFolderId] = useState<
    string | null
  >(null);
  const [didInitialExpand, setDidInitialExpand] = useState(false);

  const [internalSelectedLocation, setInternalSelectedLocation] = useState<
    string | null
  >(null);
  const [internalSelectedSectionKey, setInternalSelectedSectionKey] = useState(
    sections[0]?.key ?? "",
  );

  const currentSelectedLocation =
    selectedLocationId !== undefined
      ? selectedLocationId
      : internalSelectedLocation;
  const currentSelectedSectionKey =
    selectedSectionKey !== undefined
      ? selectedSectionKey
      : internalSelectedSectionKey;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  useEffect(() => {
    setSectionExpanded(prev => {
      const next = { ...prev };
      for (const section of sections) {
        if (!(section.key in next)) {
          next[section.key] = true;
        }
      }
      return next;
    });
    if (!internalSelectedSectionKey && sections[0]?.key) {
      setInternalSelectedSectionKey(sections[0].key);
    }
  }, [sections, internalSelectedSectionKey]);

  useEffect(() => {
    setDidInitialExpand(false);
  }, [initialFolderId, initialSectionKey, mode]);

  const findNodeLocation = useCallback(
    (id: string) => findNodeInSections(sections, id),
    [sections],
  );

  const getExpansionKey = useCallback(
    (node: ResourceTreeNode) => getFolderExpansionKey?.(node) ?? node.id,
    [getFolderExpansionKey],
  );

  const findAncestorExpansionKeys = useCallback(
    (
      nodes: ResourceTreeNode[],
      targetId: string,
      ancestors: string[] = [],
    ): string[] => {
      for (const node of nodes) {
        if (node.id === targetId) return ancestors;
        if (node.isDirectory && node.children) {
          const found = findAncestorExpansionKeys(node.children, targetId, [
            ...ancestors,
            getExpansionKey(node),
          ]);
          if (
            found.length > 0 ||
            node.children.some(child => child.id === targetId)
          ) {
            return found;
          }
        }
      }
      return [];
    },
    [getExpansionKey],
  );

  const isNodeExpanded = useCallback(
    (node: ResourceTreeNode) =>
      searchQuery.length >= 2 ? true : isFolderExpanded(getExpansionKey(node)),
    [getExpansionKey, isFolderExpanded, searchQuery],
  );

  const filteredSections = useMemo(
    () =>
      sections.map(section => ({
        ...section,
        nodes:
          searchQuery.length >= 2
            ? filterTree(section.nodes, searchQuery)
            : section.nodes,
      })),
    [sections, searchQuery],
  );

  const flatNodeIds = useMemo(() => {
    const ids: string[] = [];

    const collect = (nodes: ResourceTreeNode[], sectionVisible: boolean) => {
      if (!sectionVisible) return;
      for (const node of nodes) {
        if (!showFiles && !node.isDirectory) continue;
        ids.push(node.id);
        if (node.isDirectory && node.children && isNodeExpanded(node)) {
          collect(node.children, true);
        }
      }
    };

    for (const section of filteredSections) {
      collect(section.nodes, sectionExpanded[section.key] !== false);
    }

    return ids;
  }, [filteredSections, isNodeExpanded, sectionExpanded, showFiles]);

  const resolveCanManage = useCallback(
    (node: ResourceTreeNode) => {
      if (canManageItem) return canManageItem(node);
      return !node.readOnly;
    },
    [canManageItem],
  );

  const updateLocationSelection = useCallback(
    (folderId: string | null, sectionKey: string) => {
      if (selectedLocationId === undefined) {
        setInternalSelectedLocation(folderId);
      }
      if (selectedSectionKey === undefined) {
        setInternalSelectedSectionKey(sectionKey);
      }
      onLocationChange?.(folderId, sectionKey);
    },
    [onLocationChange, selectedLocationId, selectedSectionKey],
  );

  useEffect(() => {
    if (mode !== "picker" || didInitialExpand) return;

    const fallbackSectionKey = initialSectionKey || sections[0]?.key;
    if (!fallbackSectionKey) return;

    if (!initialFolderId) {
      updateLocationSelection(null, fallbackSectionKey);
      setDidInitialExpand(true);
      return;
    }

    const location = findNodeLocation(initialFolderId);
    if (!location) {
      updateLocationSelection(null, fallbackSectionKey);
      setFocusedNodeId(null);
      setDidInitialExpand(true);
      return;
    }
    const sectionKey =
      initialSectionKey || location.sectionKey || fallbackSectionKey;
    const sectionNodes =
      sections.find(section => section.key === sectionKey)?.nodes ?? [];

    for (const expansionKey of findAncestorExpansionKeys(
      sectionNodes,
      initialFolderId,
    )) {
      onExpandFolder(expansionKey);
    }

    setSectionExpanded(prev => ({ ...prev, [sectionKey]: true }));
    updateLocationSelection(initialFolderId, sectionKey);
    setFocusedNodeId(initialFolderId);
    setDidInitialExpand(true);
  }, [
    didInitialExpand,
    findAncestorExpansionKeys,
    findNodeLocation,
    initialFolderId,
    initialSectionKey,
    mode,
    onExpandFolder,
    sections,
    updateLocationSelection,
  ]);

  useEffect(() => {
    if (!pendingCreatedFolderId) return;
    const location = findNodeLocation(pendingCreatedFolderId);
    if (!location) return;

    const sectionNodes =
      sections.find(section => section.key === location.sectionKey)?.nodes ??
      [];
    for (const expansionKey of findAncestorExpansionKeys(
      sectionNodes,
      pendingCreatedFolderId,
    )) {
      onExpandFolder(expansionKey);
    }

    setSectionExpanded(prev => ({ ...prev, [location.sectionKey]: true }));
    setFocusedNodeId(pendingCreatedFolderId);
    setRenamingItemId(pendingCreatedFolderId);
    setRenameValue(location.node.name);
    if (mode === "picker" && location.node.isDirectory) {
      updateLocationSelection(location.node.id, location.sectionKey);
    }
    setPendingCreatedFolderId(null);
  }, [
    findAncestorExpansionKeys,
    findNodeLocation,
    mode,
    onExpandFolder,
    pendingCreatedFolderId,
    sections,
    updateLocationSelection,
  ]);

  useEffect(() => {
    if (!pendingCreatedFolderId) return;

    const timeoutId = window.setTimeout(() => {
      setPendingCreatedFolderId(current =>
        current === pendingCreatedFolderId ? null : current,
      );
    }, 2000);

    return () => window.clearTimeout(timeoutId);
  }, [pendingCreatedFolderId]);

  useEffect(() => {
    if (renamingItemId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingItemId]);

  const triggerCreateFolder = useCallback(
    async (parentId: string | null, access?: string) => {
      const created = await onCreateFolder?.(parentId, access);
      if (created) {
        setPendingCreatedFolderId(created.id);
      }
    },
    [onCreateFolder],
  );

  useImperativeHandle(
    ref,
    () => ({
      createFolder: triggerCreateFolder,
    }),
    [triggerCreateFolder],
  );

  const startInlineRename = useCallback(
    (item: ResourceTreeNode) => {
      if (!enableRename) return;
      setRenamingItemId(item.id);
      setRenameValue(item.name);
      setContextMenu(null);
    },
    [enableRename],
  );

  const cancelInlineRename = useCallback(() => {
    setRenamingItemId(null);
    setRenameValue("");
  }, []);

  const commitInlineRename = useCallback(
    (itemId: string) => {
      const nextName = renameValue.trim();
      const location = findNodeLocation(itemId);
      if (!location) {
        cancelInlineRename();
        return;
      }

      if (nextName && nextName !== location.node.name) {
        onRenameItem?.(itemId, nextName, location.node.isDirectory);
      } else {
        onResortItem?.(itemId);
      }

      cancelInlineRename();
    },
    [
      cancelInlineRename,
      findNodeLocation,
      onRenameItem,
      onResortItem,
      renameValue,
    ],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent, item: ResourceTreeNode) => {
      event.preventDefault();
      event.stopPropagation();
      const readOnly = !resolveCanManage(item);
      setContextMenu({
        anchorPosition: { top: event.clientY + 2, left: event.clientX + 2 },
        item,
        readOnly,
      });
      setFocusedNodeId(item.id);
    },
    [resolveCanManage],
  );

  const handleSectionContextMenu = useCallback(
    (event: React.MouseEvent, sectionKey: string) => {
      event.preventDefault();
      event.stopPropagation();
      setSectionContextMenu({
        anchorPosition: { top: event.clientY + 2, left: event.clientX + 2 },
        sectionKey,
      });
    },
    [],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const location = findNodeLocation(String(event.active.id));
      setDraggedNode(location?.node ?? null);
    },
    [findNodeLocation],
  );

  const handleDragOver = useCallback((event: DragOverEvent) => {
    setDropTargetId(event.over ? String(event.over.id) : null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggedNode(null);
      setDropTargetId(null);

      const { active, over } = event;
      if (!active || !over) return;

      const activeId = String(active.id);
      const overId = String(over.id);
      if (activeId === overId) return;

      const activeLocation = findNodeLocation(activeId);
      if (!activeLocation) return;

      const target = resolveTreeDropTarget(sections, overId);
      if (!target) return;

      if (target.kind === "section") {
        if (activeLocation.node.isDirectory) {
          onMoveFolder?.(activeId, null, target.access);
        } else {
          onMoveItem?.(activeId, null, target.access);
        }
        return;
      }

      if (target.targetFolderId === activeId) return;
      if (
        activeLocation.node.isDirectory &&
        findNodeInSections(
          [
            {
              key: activeLocation.sectionKey,
              nodes: activeLocation.node.children ?? [],
            },
          ],
          target.targetFolderId,
        )
      ) {
        return;
      }

      if (activeLocation.node.isDirectory) {
        onMoveFolder?.(activeId, target.targetFolderId);
      } else {
        onMoveItem?.(activeId, target.targetFolderId);
      }
    },
    [findNodeLocation, onMoveFolder, onMoveItem, sections],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      const focusId =
        focusedNodeId ||
        (mode === "sidebar" ? activeItemId : currentSelectedLocation) ||
        null;
      const focusLocation = focusId ? findNodeLocation(focusId) : null;
      const focusItem = focusLocation?.node ?? null;
      const canManageFocused = focusItem ? resolveCanManage(focusItem) : false;
      const meta = event.metaKey || event.ctrlKey;

      if (event.key === "F2" && focusItem && enableRename && canManageFocused) {
        event.preventDefault();
        startInlineRename(focusItem);
        return;
      }

      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        focusItem &&
        enableDelete &&
        canManageFocused &&
        !meta
      ) {
        event.preventDefault();
        onDeleteItem?.(focusItem);
        return;
      }

      if (
        meta &&
        event.key.toLowerCase() === "d" &&
        focusItem &&
        enableDuplicate &&
        !focusItem.isDirectory
      ) {
        event.preventDefault();
        onDuplicateItem?.(focusItem);
        return;
      }

      if (meta && event.key.toLowerCase() === "i" && focusItem && enableInfo) {
        event.preventDefault();
        if (focusItem.isDirectory) {
          onFolderInfoRequest?.(focusItem);
        } else {
          onInfoRequest?.(focusItem);
        }
        return;
      }

      if (
        meta &&
        event.key.toLowerCase() === "z" &&
        !event.shiftKey &&
        onUndo
      ) {
        event.preventDefault();
        onUndo();
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const currentIndex = focusId ? flatNodeIds.indexOf(focusId) : -1;
        const nextIndex =
          event.key === "ArrowDown"
            ? Math.min(currentIndex + 1, flatNodeIds.length - 1)
            : Math.max(currentIndex - 1, 0);
        if (flatNodeIds[nextIndex]) {
          setFocusedNodeId(flatNodeIds[nextIndex]);
        }
        return;
      }

      if (event.key === "ArrowRight" && focusItem?.isDirectory) {
        event.preventDefault();
        if (!isNodeExpanded(focusItem)) {
          onExpandFolder(getExpansionKey(focusItem));
        }
        return;
      }

      if (event.key === "ArrowLeft" && focusItem?.isDirectory) {
        event.preventDefault();
        if (isNodeExpanded(focusItem)) {
          onToggleFolder(getExpansionKey(focusItem));
        }
        return;
      }

      if (event.key === "Enter" && focusItem && focusLocation) {
        event.preventDefault();
        if (focusItem.isDirectory) {
          if (mode === "picker") {
            updateLocationSelection(focusItem.id, focusLocation.sectionKey);
          } else {
            onToggleFolder(getExpansionKey(focusItem));
          }
        } else if (mode === "picker") {
          onPickerFileClick?.(focusItem);
        } else {
          onItemClick?.(focusItem);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activeItemId,
    currentSelectedLocation,
    enableDelete,
    enableDuplicate,
    enableInfo,
    enableRename,
    findNodeLocation,
    flatNodeIds,
    focusedNodeId,
    getExpansionKey,
    isNodeExpanded,
    mode,
    onDeleteItem,
    onDuplicateItem,
    onFolderInfoRequest,
    onInfoRequest,
    onItemClick,
    onPickerFileClick,
    onToggleFolder,
    onExpandFolder,
    onUndo,
    resolveCanManage,
    startInlineRename,
    updateLocationSelection,
  ]);

  const renderInlineRenameInput = (nodeId: string) => (
    <input
      ref={renameInputRef}
      value={renameValue}
      onChange={event => setRenameValue(event.target.value)}
      onBlur={() => commitInlineRename(nodeId)}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commitInlineRename(nodeId);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancelInlineRename();
        }
      }}
      onClick={event => event.stopPropagation()}
      style={{
        width: "100%",
        border: "1px solid",
        borderColor: "var(--mui-palette-divider, #ccc)",
        borderRadius: 4,
        padding: "1px 4px",
        outline: "none",
        background: "transparent",
        color: "inherit",
        fontSize: "0.8125rem",
        fontFamily: "inherit",
      }}
    />
  );

  const buildRowSx = ({
    depth,
    isDropTarget,
    isSelected,
  }: {
    depth: number;
    isDropTarget?: boolean;
    isSelected?: boolean;
  }) => ({
    pl: 0.5 + depth * 1.5,
    minWidth: 0,
    py: 0,
    minHeight: ROW_HEIGHT,
    bgcolor: isDropTarget
      ? "action.hover"
      : isSelected
        ? "action.selected"
        : undefined,
    outline: isDropTarget ? "2px dashed" : undefined,
    outlineColor: isDropTarget ? "primary.main" : undefined,
    // Draw the drop-target outline inside the row's own box so it isn't
    // clipped by adjacent opaque rows or sticky ancestors (CSS outlines
    // don't reserve layout space, so they get painted over otherwise).
    outlineOffset: isDropTarget ? "-2px" : undefined,
    borderRadius: 0,
  });

  const renderTree = (
    nodes: ResourceTreeNode[],
    depth: number,
    sectionKey: string,
  ): ReactNode[] => {
    const items: ReactNode[] = [];

    for (const node of nodes) {
      if (!showFiles && !node.isDirectory) continue;

      const canManage = resolveCanManage(node);
      const isExpanded = node.isDirectory && isNodeExpanded(node);
      const isSelectedLocation =
        mode === "picker" && currentSelectedLocation === node.id;
      const isActive = mode === "sidebar" && activeItemId === node.id;
      const isRenaming = renamingItemId === node.id;
      const isDropTarget =
        dropTargetId === node.id ||
        dropTargetId === getFolderDropTargetId(node.id);

      if (node.isDirectory) {
        const folderRow = (
          <ListItemButton
            key={node.id}
            data-node-id={node.id}
            selected={isSelectedLocation}
            onClick={() => {
              setFocusedNodeId(node.id);
              if (mode === "picker") {
                updateLocationSelection(node.id, sectionKey);
              } else {
                onToggleFolder(getExpansionKey(node));
              }
            }}
            onContextMenu={event => handleContextMenu(event, node)}
            onDoubleClick={event => {
              if (enableRename && canManage) {
                event.stopPropagation();
                startInlineRename(node);
              }
            }}
            sx={{
              ...buildRowSx({
                depth,
                isDropTarget,
                isSelected: isSelectedLocation,
              }),
              position: "sticky",
              // Stack ancestor headers: depth=1 sits just below the section
              // header (which is sticky at top: 0), depth=2 one row below
              // that, and so on.
              top: depth * ROW_HEIGHT,
              // Deeper folders get a lower z-index so outer ancestors always
              // paint on top when sticky rows collide during scroll.
              zIndex: 20 - depth,
              // Non-transparent fill so content scrolling underneath doesn't
              // bleed through while stuck. Uses `background.default` to match
              // the ambient sidebar canvas (sidebar has no explicit bg, so it
              // inherits the default theme background) — this makes the row
              // visually invisible against the surrounding tree at rest.
              // Selected / drop-target states from buildRowSx still win.
              backgroundColor:
                isDropTarget || isSelectedLocation
                  ? undefined
                  : "background.default",
            }}
          >
            <ListItemIcon
              sx={{
                minWidth: ICON_COL_WIDTH,
                mr: 0,
                // MUI's ListItemIcon defaults to `action.active` which looks
                // dimmed; the chevron should match the folder name's color.
                color: "text.primary",
              }}
            >
              <Box
                component="span"
                onClick={event => {
                  event.stopPropagation();
                  onToggleFolder(getExpansionKey(node));
                }}
                sx={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                }}
              >
                {isExpanded ? (
                  <ChevronDown size={14} strokeWidth={1.5} />
                ) : (
                  <ChevronRight size={14} strokeWidth={1.5} />
                )}
              </Box>
            </ListItemIcon>
            {!hideFolderIcon && (
              <ListItemIcon sx={{ minWidth: ICON_COL_WIDTH }}>
                {isExpanded ? (
                  <FolderOpen size={16} strokeWidth={1.5} />
                ) : (
                  <Folder size={16} strokeWidth={1.5} />
                )}
              </ListItemIcon>
            )}
            <MuiListItemText
              primary={
                isRenaming ? renderInlineRenameInput(node.id) : node.name
              }
              primaryTypographyProps={{
                variant: "body2",
                sx: {
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  fontWeight: 500,
                },
              }}
            />
          </ListItemButton>
        );

        const childrenContent = isExpanded
          ? (() => {
              const childItems = renderTree(
                node.children ?? [],
                depth + 1,
                sectionKey,
              );
              const childList = (
                <List component="div" disablePadding dense>
                  {childItems.length === 0 ? (
                    <Typography
                      variant="caption"
                      color="text.disabled"
                      sx={{
                        pl: 0.5 + (depth + 1) * 1.5 + 2.75,
                        py: 0.5,
                        display: "block",
                      }}
                    >
                      Empty
                    </Typography>
                  ) : (
                    childItems
                  )}
                </List>
              );

              return enableDragDrop ? (
                <DroppableFolderContent folderId={node.id}>
                  {childList}
                </DroppableFolderContent>
              ) : (
                childList
              );
            })()
          : null;

        // Wrap (header + children) in a single block so the sticky header has
        // a containing block that spans the entire folder scope.
        const folderScope = enableDragDrop ? (
          <DraggableFolderScope
            key={`folder-scope-${node.id}`}
            id={node.id}
            disabled={!canManage}
            header={folderRow}
          >
            {childrenContent}
          </DraggableFolderScope>
        ) : (
          <Box key={`folder-scope-${node.id}`}>
            {folderRow}
            {childrenContent}
          </Box>
        );

        items.push(folderScope);

        continue;
      }

      const fileRow = (
        <ListItemButton
          key={node.id}
          data-node-id={node.id}
          selected={isActive}
          onClick={() => {
            setFocusedNodeId(node.id);
            if (mode === "picker") {
              onPickerFileClick?.(node);
            } else {
              onItemClick?.(node);
            }
          }}
          onContextMenu={event => handleContextMenu(event, node)}
          onDoubleClick={event => {
            if (enableRename && canManage) {
              event.stopPropagation();
              startInlineRename(node);
            }
          }}
          sx={buildRowSx({
            depth,
            isSelected: isActive,
          })}
        >
          {!hideFolderIcon && (
            <ListItemIcon
              sx={{ minWidth: ICON_COL_WIDTH, visibility: "hidden", mr: 0 }}
            />
          )}
          <ListItemIcon sx={{ minWidth: ICON_COL_WIDTH }}>
            {getItemIcon ? getItemIcon(node) : null}
          </ListItemIcon>
          <MuiListItemText
            primary={isRenaming ? renderInlineRenameInput(node.id) : node.name}
            primaryTypographyProps={{
              variant: "body2",
              sx: {
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              },
            }}
          />
        </ListItemButton>
      );

      items.push(
        enableDragDrop ? (
          <DraggableTreeItem
            key={`drag-file-${node.id}`}
            id={node.id}
            disabled={!canManage}
          >
            {fileRow}
          </DraggableTreeItem>
        ) : (
          fileRow
        ),
      );
    }

    return items;
  };

  const renderSectionHeader = (section: ResourceTreeSection) => {
    const headerSelected =
      mode === "picker" &&
      currentSelectedLocation === null &&
      currentSelectedSectionKey === section.key;
    const isDropTarget = section.droppableId === dropTargetId;

    const header = (
      <ListItemButton
        selected={headerSelected}
        onClick={() => {
          if (mode === "picker") {
            updateLocationSelection(null, section.key);
          } else {
            setSectionExpanded(prev => ({
              ...prev,
              [section.key]: !prev[section.key],
            }));
          }
        }}
        onContextMenu={event => handleSectionContextMenu(event, section.key)}
        sx={{
          py: 0,
          pl: 0.5,
          minWidth: 0,
          minHeight: ROW_HEIGHT,
          bgcolor: isDropTarget
            ? "action.hover"
            : headerSelected
              ? "action.selected"
              : undefined,
          outline: isDropTarget ? "2px dashed" : undefined,
          outlineColor: isDropTarget ? "primary.main" : undefined,
          outlineOffset: isDropTarget ? "-2px" : undefined,
          borderRadius: 0,
          "& .MuiListItemText-root": {
            minWidth: 0,
            flex: "1 1 auto",
          },
          // Pin the section label at the top of the scroll container as the
          // user scrolls through the section's tree. Folder headers inside
          // stack below this (see ROW_HEIGHT * depth in renderTree).
          position: "sticky",
          top: 0,
          zIndex: 30,
          backgroundColor:
            isDropTarget || headerSelected ? undefined : "background.default",
        }}
      >
        <ListItemIcon
          sx={{ minWidth: ICON_COL_WIDTH, mr: 0, color: "text.primary" }}
        >
          <Box
            component="span"
            onClick={event => {
              event.stopPropagation();
              setSectionExpanded(prev => ({
                ...prev,
                [section.key]: !prev[section.key],
              }));
            }}
            sx={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
            }}
          >
            {sectionExpanded[section.key] !== false ? (
              <ChevronDown size={14} strokeWidth={1.5} />
            ) : (
              <ChevronRight size={14} strokeWidth={1.5} />
            )}
          </Box>
        </ListItemIcon>
        {section.icon ? (
          <ListItemIcon sx={{ minWidth: ICON_COL_WIDTH }}>
            {section.icon}
          </ListItemIcon>
        ) : null}
        <MuiListItemText
          primary={section.label}
          primaryTypographyProps={{
            variant: "body2",
            sx: {
              fontWeight: 600,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            },
          }}
        />
      </ListItemButton>
    );

    return header;
  };

  const treeContent = (
    <List component="nav" dense disablePadding>
      {filteredSections.map(section => {
        const sectionBody =
          sectionExpanded[section.key] !== false ? (
            section.nodes.length > 0 ? (
              renderTree(section.nodes, 1, section.key)
            ) : (
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
                Nothing here yet
              </Typography>
            )
          ) : null;

        // Wrap the section header + its body in a single block so the sticky
        // section header has a containing block spanning the whole section.
        // When a droppableId is provided, the scope also acts as the section-
        // level drop target (replaces the old DroppableSectionHeader wrapper
        // around just the header).
        return (
          <SectionScope
            key={`section-${section.key}`}
            droppableId={
              enableDragDrop && section.droppableId
                ? section.droppableId
                : undefined
            }
          >
            {renderSectionHeader(section)}
            {sectionBody}
          </SectionScope>
        );
      })}
      {/* Trailing spacer so the last row doesn't feel flush to the bottom
          of the scroll container and hint there's more content below. */}
      <Box sx={{ height: 24 }} aria-hidden />
    </List>
  );

  const content = enableDragDrop ? (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetectionStrategy}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      {treeContent}
      <DragOverlay>
        {draggedNode ? (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              px: 1,
              py: 0.5,
              bgcolor: "background.paper",
              borderRadius: 1,
              boxShadow: 3,
              fontSize: "0.8125rem",
            }}
          >
            {draggedNode.isDirectory ? (
              <Folder size={14} />
            ) : (
              getItemIcon?.(draggedNode) || null
            )}
            <span className="app-truncate-inline">{draggedNode.name}</span>
          </Box>
        ) : null}
      </DragOverlay>
    </DndContext>
  ) : (
    treeContent
  );

  return (
    <>
      {content}

      <Menu
        open={!!contextMenu}
        onClose={() => setContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu?.anchorPosition}
      >
        {contextMenu &&
          (() => {
            const { item, readOnly } = contextMenu;
            const canManage = !readOnly;

            return [
              enableRename && canManage && (
                <MenuItem
                  key="rename"
                  onClick={() => {
                    startInlineRename(item);
                  }}
                >
                  <Pencil size={14} style={{ marginRight: 8 }} />
                  Rename
                </MenuItem>
              ),
              enableDuplicate && !item.isDirectory && (
                <MenuItem
                  key="duplicate"
                  onClick={() => {
                    setContextMenu(null);
                    onDuplicateItem?.(item);
                  }}
                >
                  <Copy size={14} style={{ marginRight: 8 }} />
                  Duplicate
                </MenuItem>
              ),
              enableNewFolder && item.isDirectory && canManage && (
                <MenuItem
                  key="subfolder"
                  onClick={async () => {
                    setContextMenu(null);
                    onExpandFolder(getExpansionKey(item));
                    await triggerCreateFolder(item.id, item.access);
                  }}
                >
                  <FolderPlus size={14} style={{ marginRight: 8 }} />
                  New Subfolder
                </MenuItem>
              ),
              enableMove && canManage && onMoveRequest && (
                <MenuItem
                  key="move"
                  onClick={() => {
                    setContextMenu(null);
                    onMoveRequest(item);
                  }}
                >
                  <ArrowRightLeft size={14} style={{ marginRight: 8 }} />
                  Move to...
                </MenuItem>
              ),
              enableInfo && !item.isDirectory && onInfoRequest && (
                <MenuItem
                  key="info-file"
                  onClick={() => {
                    setContextMenu(null);
                    onInfoRequest(item);
                  }}
                >
                  <Info size={14} style={{ marginRight: 8 }} />
                  Information
                </MenuItem>
              ),
              enableInfo && item.isDirectory && onFolderInfoRequest && (
                <MenuItem
                  key="info-folder"
                  onClick={() => {
                    setContextMenu(null);
                    onFolderInfoRequest(item);
                  }}
                >
                  <Info size={14} style={{ marginRight: 8 }} />
                  Information
                </MenuItem>
              ),
              enableDelete && canManage && onDeleteItem && (
                <React.Fragment key="delete-group">
                  <Divider />
                  <MenuItem
                    onClick={() => {
                      setContextMenu(null);
                      onDeleteItem(item);
                    }}
                    sx={{ color: "error.main" }}
                  >
                    <Trash2 size={14} style={{ marginRight: 8 }} />
                    Delete
                  </MenuItem>
                </React.Fragment>
              ),
            ].filter(Boolean);
          })()}
      </Menu>

      <Menu
        open={!!sectionContextMenu}
        onClose={() => setSectionContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={sectionContextMenu?.anchorPosition}
      >
        {sectionContextMenu && enableNewFolder && onCreateFolder && (
          <MenuItem
            onClick={async () => {
              const section = sections.find(
                entry => entry.key === sectionContextMenu.sectionKey,
              );
              setSectionContextMenu(null);
              await triggerCreateFolder(null, section?.defaultAccess);
            }}
          >
            <FolderPlus size={14} style={{ marginRight: 8 }} />
            New Folder
          </MenuItem>
        )}
      </Menu>
    </>
  );
}

const ResourceTree = forwardRef<ResourceTreeRef, ResourceTreeProps>(
  ResourceTreeInner,
);

ResourceTree.displayName = "ResourceTree";

export default ResourceTree;
