import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box } from "@mui/material";
import { Folder } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  pointerWithin,
  type CollisionDetection,
} from "@dnd-kit/core";
import { filterTree } from "../store/lib/tree-helpers";
import { useDragSensors } from "../hooks/useDragSensors";
import { useIsMobile } from "../hooks/useIsMobile";
import {
  findAncestorPaths,
  findNodeInSections,
  flattenVisibleNodeIds,
} from "./resource-tree/utils";
import { useTreeDnd } from "./resource-tree/useTreeDnd";
import { flattenTreeRows, type FlatRow } from "./resource-tree/flatten";
import { TreeRowProvider, type TreeRowConfig } from "./resource-tree/TreeRows";
import {
  NodeContextMenu,
  SectionContextMenu,
  type NodeMenuState,
  type SectionMenuState,
} from "./resource-tree/TreeContextMenus";
import { useTreeKeyboard } from "./resource-tree/useTreeKeyboard";
import {
  VirtualTreeList,
  type VirtualTreeListHandle,
} from "./resource-tree/VirtualTreeList";
import type {
  ResourceTreeNode,
  ResourceTreeProps,
  ResourceTreeRef,
} from "./resource-tree/types";
import {
  onRenderDebug,
  useRenderCount,
  useWhyChanged,
} from "../utils/renderDebug";

export type {
  CreatedFolderResult,
  ResourceTreeNode,
  ResourceTreeProps,
  ResourceTreeRef,
  ResourceTreeSection,
} from "./resource-tree/types";

// Pixel height of a single tree row. Used to stack sticky folder/section
// headers so each ancestor pins one row below its parent as the user scrolls.
// Keep this in sync with the `minHeight` / vertical padding set on the rows
// (resource-tree/TreeRows.tsx).
const ROW_HEIGHT = 24;

// Width of the leading chevron / icon column. Used for both the folder
// chevron and (when `hideFolderIcon` is on) the file icon so they line up
// vertically across sibling rows.
const ICON_COL_WIDTH = 20;

const collisionDetectionStrategy: CollisionDetection = args => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

const RENAME_INPUT_STYLE: React.CSSProperties = {
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
};

function ResourceTreeInner(
  {
    sections,
    mode = "sidebar",
    activeItemId,
    searchQuery = "",
    revealNodeId,
    revealNonce,
    getItemIcon,
    getRightAdornment,
    onLoadChildren,
    isLoadingChildren,
    getContextMenuItems,
    getSectionContextMenuItems,
    onSectionDrop,
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
    shouldFolderClickActivate,
    onPickerFileClick,
    onLocationChange,
    selectedLocationId,
    selectedSectionKey,
    initialFolderId,
    initialSectionKey,
    onMoveItem,
    onMoveFolder,
    onRenameItem,
    getRenameSeed,
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
  // Larger, finger-friendly rows and caret hit areas on phones. `rowHeight`
  // also feeds the sticky folder/section header stacking, so deriving it once
  // here keeps everything aligned.
  const isMobile = useIsMobile();
  const rowHeight = isMobile ? 36 : ROW_HEIGHT;
  const iconColWidth = isMobile ? 28 : ICON_COL_WIDTH;
  const caretSize = isMobile ? 28 : 18;

  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<VirtualTreeListHandle>(null);

  const [contextMenu, setContextMenu] = useState<NodeMenuState | null>(null);
  const [sectionContextMenu, setSectionContextMenu] =
    useState<SectionMenuState | null>(null);

  const [sectionExpanded, setSectionExpanded] = useState<
    Record<string, boolean>
  >(() => Object.fromEntries(sections.map(section => [section.key, true])));

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
  const debugSectionSummary = useMemo(
    () =>
      sections
        .map(section => `${section.key}:${section.nodes.length}`)
        .join(","),
    [sections],
  );
  const sensors = useDragSensors(8);

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
    (nodes: ResourceTreeNode[], targetId: string): string[] =>
      findAncestorPaths(nodes, targetId, [], getExpansionKey),
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

  const loadChildrenRequestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!onLoadChildren) return;

    const requested = loadChildrenRequestedRef.current;
    const visit = (nodes: ResourceTreeNode[]) => {
      for (const node of nodes) {
        if (!node.isDirectory) continue;
        const expansionKey = getExpansionKey(node);
        if (
          isFolderExpanded(expansionKey) &&
          node.children === undefined &&
          !isLoadingChildren?.(node) &&
          !requested.has(expansionKey)
        ) {
          requested.add(expansionKey);
          onLoadChildren(node);
        } else if (node.children !== undefined) {
          // Clear the guard so subsequent collapses/re-expansions can re-trigger
          // a fetch if the caller dropped the children again.
          requested.delete(expansionKey);
          visit(node.children);
        }
      }
    };

    for (const section of sections) {
      visit(section.nodes);
    }
  }, [
    getExpansionKey,
    isFolderExpanded,
    isLoadingChildren,
    onLoadChildren,
    sections,
  ]);

  // Arrow-key order. Honours the section collapse state only (as before:
  // a header-less section's rows stay navigable unless it was collapsed).
  const flatNodeIds = useMemo(
    () =>
      flattenVisibleNodeIds(filteredSections, {
        showFiles,
        sectionExpanded,
        isFolderExpanded: key =>
          searchQuery.length >= 2 ? true : isFolderExpanded(key),
        getExpansionKey,
      }),
    [
      filteredSections,
      showFiles,
      sectionExpanded,
      searchQuery,
      isFolderExpanded,
      getExpansionKey,
    ],
  );

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
      setRenameValue(getRenameSeed?.(item) ?? item.name);
      setContextMenu(null);
    },
    [enableRename, getRenameSeed],
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

      const seed = getRenameSeed?.(location.node) ?? location.node.name;
      if (nextName && nextName !== seed) {
        onRenameItem?.(itemId, nextName, location.node.isDirectory);
      } else {
        onResortItem?.(itemId);
      }

      cancelInlineRename();
    },
    [
      cancelInlineRename,
      findNodeLocation,
      getRenameSeed,
      onRenameItem,
      onResortItem,
      renameValue,
    ],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent, item: ResourceTreeNode) => {
      event.preventDefault();
      event.stopPropagation();
      // Peek at custom items up front: if the caller returned an empty array
      // for this node, skip opening the menu entirely (rather than flashing an
      // empty popover).
      if (getContextMenuItems) {
        const peek = getContextMenuItems(item, { closeMenu: () => {} });
        if (Array.isArray(peek) && peek.length === 0) {
          return;
        }
      }
      const readOnly = !resolveCanManage(item);
      setContextMenu({
        anchorPosition: { top: event.clientY + 2, left: event.clientX + 2 },
        item,
        readOnly,
      });
      setFocusedNodeId(item.id);
    },
    [getContextMenuItems, resolveCanManage],
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

  const {
    draggedNode,
    dropTargetId,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
  } = useTreeDnd({
    sections,
    findNodeLocation,
    onSectionDrop,
    onMoveItem,
    onMoveFolder,
  });

  useRenderCount("ResourceTree", {
    mode,
    sectionCount: sections.length,
    activeItemId,
  });
  useWhyChanged("ResourceTree", {
    sectionsRef: sections,
    debugSectionSummary,
    mode,
    activeItemId,
    searchQuery,
    focusedNodeId,
    contextMenuItemId: contextMenu?.item.id,
    sectionContextMenuKey: sectionContextMenu?.sectionKey,
    draggedNodeId: draggedNode?.id,
    dropTargetId,
    pendingCreatedFolderId,
    currentSelectedLocation,
    currentSelectedSectionKey,
    showFiles,
    hideFolderIcon,
    enableDragDrop,
    onItemClick,
    onLoadChildren,
    isLoadingChildren,
    getItemIcon,
    getRightAdornment,
    isFolderExpanded,
    onToggleFolder,
    onExpandFolder,
    getFolderExpansionKey,
  });

  useTreeKeyboard({
    mode,
    focusedNodeId,
    activeItemId,
    currentSelectedLocation,
    flatNodeIds,
    findNodeLocation,
    resolveCanManage,
    isNodeExpanded,
    getExpansionKey,
    setFocusedNodeId,
    enableRename,
    enableDelete,
    enableDuplicate,
    enableInfo,
    startInlineRename,
    updateLocationSelection,
    onDeleteItem,
    onDuplicateItem,
    onInfoRequest,
    onFolderInfoRequest,
    onUndo,
    onExpandFolder,
    onToggleFolder,
    onLoadChildren,
    onPickerFileClick,
    onItemClick,
  });

  // Reveal-to-node: expand ancestor folders and scroll the target row into
  // view whenever `revealNonce` changes (e.g. a tab switch or breadcrumb
  // click). `sections` is a dep so the reveal re-attempts once lazily-loaded
  // children arrive (apps fetch their file tree on demand); the
  // `revealDoneNonceRef` guard stops it from re-firing once the row is found,
  // so later unrelated tree changes don't yank the scroll position.
  const revealDoneNonceRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!revealNonce || !revealNodeId) return;
    if (revealDoneNonceRef.current === revealNonce) return;

    const location = findNodeLocation(revealNodeId);
    if (location) {
      const sectionNodes =
        sections.find(section => section.key === location.sectionKey)?.nodes ??
        [];
      for (const expansionKey of findAncestorExpansionKeys(
        sectionNodes,
        revealNodeId,
      )) {
        onExpandFolder(expansionKey);
      }
      setSectionExpanded(prev =>
        prev[location.sectionKey] === false
          ? { ...prev, [location.sectionKey]: true }
          : prev,
      );
    }

    let cancelled = false;
    const tryScroll = () => {
      if (cancelled) return;
      const index = rowsRef.current.findIndex(
        row =>
          (row.kind === "folder" || row.kind === "file") &&
          row.node.id === revealNodeId,
      );
      if (index >= 0 && listRef.current?.revealIndex(index)) {
        revealDoneNonceRef.current = revealNonce;
        cancelled = true;
      }
    };
    // Retry on a short ramp to cover render + lazy child fetch latency.
    const timeouts = [0, 80, 200, 450, 900, 1600].map(delay =>
      window.setTimeout(tryScroll, delay),
    );

    return () => {
      cancelled = true;
      timeouts.forEach(id => window.clearTimeout(id));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce, revealNodeId, sections]);

  const renderRenameInput = (nodeId: string) => (
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
      style={RENAME_INPUT_STYLE}
    />
  );

  const maybeLoadChildren = useCallback(
    (node: ResourceTreeNode) => {
      if (node.children === undefined && onLoadChildren) {
        onLoadChildren(node);
      }
    },
    [onLoadChildren],
  );

  const toggleNode = (node: ResourceTreeNode, isExpanded: boolean) => {
    const willExpand = !isExpanded;
    onToggleFolder(getExpansionKey(node));
    if (willExpand) maybeLoadChildren(node);
  };

  const toggleSection = (sectionKey: string) =>
    setSectionExpanded(prev => ({ ...prev, [sectionKey]: !prev[sectionKey] }));

  const rowConfig: TreeRowConfig = {
    mode,
    activeItemId,
    currentSelectedLocation,
    currentSelectedSectionKey,
    renamingItemId,
    renderRenameInput,
    dropTargetId,
    sectionExpanded,
    rowHeight,
    iconColWidth,
    caretSize,
    hideFolderIcon,
    enableRename,
    getItemIcon,
    getRightAdornment,
    resolveCanManage,
    onFolderRowClick: (event, node, sectionKey, isExpanded) => {
      setFocusedNodeId(node.id);
      if (mode === "picker") {
        updateLocationSelection(node.id, sectionKey);
      } else if (shouldFolderClickActivate?.(node)) {
        // Clicks on the caret itself are handled (and stopped) by the
        // caret's own handler; clicks left of it (the indent) should
        // still toggle, while the name/icon area activates.
        const caret = event.currentTarget.querySelector("[data-tree-caret]");
        if (caret && event.clientX <= caret.getBoundingClientRect().right) {
          toggleNode(node, isExpanded);
        } else {
          onItemClick?.(node);
        }
      } else {
        toggleNode(node, isExpanded);
      }
    },
    onToggleNode: toggleNode,
    onFileRowClick: node => {
      setFocusedNodeId(node.id);
      if (mode === "picker") {
        onPickerFileClick?.(node);
      } else {
        onItemClick?.(node);
      }
    },
    onContextMenu: handleContextMenu,
    onStartRename: startInlineRename,
    onSectionClick: sectionKey => {
      if (mode === "picker") {
        updateLocationSelection(null, sectionKey);
      } else {
        toggleSection(sectionKey);
      }
    },
    onSectionToggle: toggleSection,
    onSectionContextMenu: handleSectionContextMenu,
  };

  const rows = useMemo(
    () =>
      flattenTreeRows(filteredSections, {
        showFiles,
        enableDragDrop,
        sectionExpanded,
        isNodeExpanded,
        isLoadingChildren,
      }),
    [
      filteredSections,
      showFiles,
      enableDragDrop,
      sectionExpanded,
      isNodeExpanded,
      isLoadingChildren,
    ],
  );
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const canManageRow = useCallback(
    (row: Extract<FlatRow, { kind: "folder" | "file" }>) =>
      resolveCanManage(row.node),
    [resolveCanManage],
  );

  const treeContent = (
    <VirtualTreeList
      ref={listRef}
      rows={rows}
      enableDragDrop={enableDragDrop}
      draggedNodeId={draggedNode?.id ?? null}
      canManage={canManageRow}
    />
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
            {getItemIcon?.(draggedNode) ||
              (draggedNode.isDirectory ? <Folder size={14} /> : null)}
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
      <TreeRowProvider value={rowConfig}>
        <React.Profiler id="ResourceTree.content" onRender={onRenderDebug}>
          {content}
        </React.Profiler>
      </TreeRowProvider>

      <NodeContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
        getContextMenuItems={getContextMenuItems}
        enableRename={enableRename}
        enableDuplicate={enableDuplicate}
        enableNewFolder={enableNewFolder}
        enableMove={enableMove}
        enableInfo={enableInfo}
        enableDelete={enableDelete}
        onRename={startInlineRename}
        onDuplicateItem={onDuplicateItem}
        onNewSubfolder={item => {
          onExpandFolder(getExpansionKey(item));
          void triggerCreateFolder(item.id, item.access);
        }}
        onMoveRequest={onMoveRequest}
        onInfoRequest={onInfoRequest}
        onFolderInfoRequest={onFolderInfoRequest}
        onDeleteItem={onDeleteItem}
      />

      <SectionContextMenu
        menu={sectionContextMenu}
        onClose={() => setSectionContextMenu(null)}
        getSectionContextMenuItems={getSectionContextMenuItems}
        onNewFolder={
          enableNewFolder && onCreateFolder
            ? sectionKey => {
                const section = sections.find(
                  entry => entry.key === sectionKey,
                );
                setSectionContextMenu(null);
                void triggerCreateFolder(null, section?.defaultAccess);
              }
            : undefined
        }
      />
    </>
  );
}

const ResourceTree = forwardRef<ResourceTreeRef, ResourceTreeProps>(
  ResourceTreeInner,
);

ResourceTree.displayName = "ResourceTree";

export default ResourceTree;
