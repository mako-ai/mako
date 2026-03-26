import React, {
  type ReactNode,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import {
  Box,
  Chip,
  List,
  ListItemButton,
  ListItemIcon,
  Menu,
  MenuItem,
  ListItemText as MuiListItemText,
  Typography,
  Divider,
} from "@mui/material";
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  Pencil,
  Copy,
  Trash2,
  FolderPlus,
  ArrowRightLeft,
  Info,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
  useDraggable,
  useDroppable,
} from "@dnd-kit/core";
import { filterTree, countItems } from "../store/lib/tree-helpers";

// ── Public types ──

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
  icon: React.ReactNode;
  nodes: ResourceTreeNode[];
  droppableId?: string;
  defaultAccess?: "private" | "workspace";
}

export interface ResourceTreeProps {
  sections: ResourceTreeSection[];
  mode?: "sidebar" | "picker";
  activeItemId?: string | null;
  searchQuery?: string;

  getItemIcon?: (node: ResourceTreeNode) => React.ReactNode;
  showFiles?: boolean;

  enableDragDrop?: boolean;
  enableRename?: boolean;
  enableDuplicate?: boolean;
  enableDelete?: boolean;
  enableMove?: boolean;
  enableInfo?: boolean;
  enableNewFolder?: boolean;

  onItemClick?: (node: ResourceTreeNode) => void;
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
  ) => Promise<string | null>;
  onInfoRequest?: (node: ResourceTreeNode) => void;
  onResortItem?: (id: string) => void;

  isFolderExpanded: (path: string) => boolean;
  onToggleFolder: (path: string) => void;
  onExpandFolder: (path: string) => void;

  canManageItem?: (node: ResourceTreeNode) => boolean;
}

// ── Component ──

export default function ResourceTree({
  sections,
  mode = "sidebar",
  activeItemId,
  searchQuery = "",

  getItemIcon,
  showFiles = true,

  enableDragDrop = true,
  enableRename = true,
  enableDuplicate = false,
  enableDelete = true,
  enableMove = false,
  enableInfo = false,
  enableNewFolder = true,

  onItemClick,
  onMoveItem,
  onMoveFolder,
  onRenameItem,
  onDeleteItem,
  onDuplicateItem,
  onCreateFolder,
  onInfoRequest,
  onResortItem,

  isFolderExpanded,
  onToggleFolder,
  onExpandFolder,

  canManageItem,
}: ResourceTreeProps) {
  // ── State ──

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [renamingItemId, setRenamingItemId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [contextMenu, setContextMenu] = useState<{
    anchorPosition: { top: number; left: number };
    item: ResourceTreeNode;
    readOnly?: boolean;
  } | null>(null);

  const [sectionContextMenu, setSectionContextMenu] = useState<{
    anchorPosition: { top: number; left: number };
    sectionKey: string;
  } | null>(null);

  const [sectionExpanded, setSectionExpanded] = useState<
    Record<string, boolean>
  >(() => Object.fromEntries(sections.map(s => [s.key, true])));

  const [draggedNode, setDraggedNode] = useState<ResourceTreeNode | null>(null);

  // ── DnD ──

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const findNodeById = useCallback(
    (id: string): ResourceTreeNode | null => {
      const search = (nodes: ResourceTreeNode[]): ResourceTreeNode | null => {
        for (const n of nodes) {
          if (n.id === id) return n;
          if (n.isDirectory && n.children) {
            const found = search(n.children);
            if (found) return found;
          }
        }
        return null;
      };
      for (const s of sections) {
        const found = search(s.nodes);
        if (found) return found;
      }
      return null;
    },
    [sections],
  );

  const handleDragStart = useCallback(
    (event: { active: { id: string | number } }) => {
      const node = findNodeById(String(event.active.id));
      setDraggedNode(node);
    },
    [findNodeById],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggedNode(null);
      const { active, over } = event;
      if (!over || !active) return;

      const activeId = String(active.id);
      const overId = String(over.id);
      if (activeId === overId) return;

      const activeNode = findNodeById(activeId);
      if (!activeNode) return;

      for (const s of sections) {
        if (overId === s.droppableId) {
          if (activeNode.isDirectory) {
            onMoveFolder?.(activeId, null, s.defaultAccess);
          } else {
            onMoveItem?.(activeId, null, s.defaultAccess);
          }
          return;
        }
      }

      if (overId.startsWith("__folder_content_")) {
        const folderId = overId.replace("__folder_content_", "");
        if (activeNode.isDirectory) {
          onMoveFolder?.(activeId, folderId);
        } else {
          onMoveItem?.(activeId, folderId);
        }
        return;
      }

      const overNode = findNodeById(overId);
      if (overNode?.isDirectory) {
        if (activeNode.isDirectory) {
          onMoveFolder?.(activeId, overId);
        } else {
          onMoveItem?.(activeId, overId);
        }
      }
    },
    [findNodeById, onMoveItem, onMoveFolder, sections],
  );

  // ── Inline rename ──

  const startInlineRename = useCallback(
    (item: ResourceTreeNode) => {
      if (!item.id || !enableRename) return;
      setRenamingItemId(item.id);
      setRenameValue(item.name);
      setContextMenu(null);
    },
    [enableRename],
  );

  const commitInlineRename = useCallback(
    (itemId: string) => {
      const trimmed = renameValue.trim();
      const node = findNodeById(itemId);
      if (!node) {
        setRenamingItemId(null);
        return;
      }
      if (trimmed && trimmed !== node.name) {
        onRenameItem?.(itemId, trimmed, node.isDirectory);
      } else {
        onResortItem?.(itemId);
      }
      setRenamingItemId(null);
    },
    [renameValue, findNodeById, onRenameItem, onResortItem],
  );

  const cancelInlineRename = useCallback(() => {
    setRenamingItemId(null);
    setRenameValue("");
  }, []);

  useEffect(() => {
    if (renamingItemId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingItemId]);

  // ── Context menus ──

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, item: ResourceTreeNode, readOnly?: boolean) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({
        anchorPosition: { top: e.clientY + 2, left: e.clientX + 2 },
        item,
        readOnly,
      });
      setSelectedNodeId(item.id);
    },
    [],
  );

  const handleSectionContextMenu = useCallback(
    (e: React.MouseEvent, sectionKey: string) => {
      e.preventDefault();
      e.stopPropagation();
      setSectionContextMenu({
        anchorPosition: { top: e.clientY + 2, left: e.clientX + 2 },
        sectionKey,
      });
    },
    [],
  );

  // ── Filtered trees ──

  const filteredSections = useMemo(
    () =>
      sections.map(s => ({
        ...s,
        nodes:
          searchQuery.length >= 2 ? filterTree(s.nodes, searchQuery) : s.nodes,
      })),
    [sections, searchQuery],
  );

  // ── Flat node IDs for keyboard nav ──

  const flatNodeIds = useMemo(() => {
    const ids: string[] = [];
    const collect = (nodes: ResourceTreeNode[], sectionVisible: boolean) => {
      if (!sectionVisible) return;
      for (const node of nodes) {
        if (!showFiles && !node.isDirectory) continue;
        if (node.id) ids.push(node.id);
        if (node.isDirectory && node.children && isFolderExpanded(node.path)) {
          collect(node.children, true);
        }
      }
    };
    for (const s of filteredSections) {
      collect(s.nodes, sectionExpanded[s.key] !== false);
    }
    return ids;
  }, [filteredSections, isFolderExpanded, sectionExpanded, showFiles]);

  // ── Keyboard navigation ──

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

      const focusId = selectedNodeId || activeItemId;

      if (e.key === "F2" && enableRename && focusId) {
        const node = findNodeById(focusId);
        if (node) {
          e.preventDefault();
          startInlineRename(node);
        }
        return;
      }

      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        enableDelete &&
        !e.metaKey &&
        focusId
      ) {
        const node = findNodeById(focusId);
        if (node) {
          e.preventDefault();
          onDeleteItem?.(node);
        }
        return;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const currentIdx = focusId ? flatNodeIds.indexOf(focusId) : -1;
        const nextIdx =
          e.key === "ArrowDown"
            ? Math.min(currentIdx + 1, flatNodeIds.length - 1)
            : Math.max(currentIdx - 1, 0);
        if (flatNodeIds[nextIdx]) {
          setSelectedNodeId(flatNodeIds[nextIdx]);
        }
        return;
      }

      if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && focusId) {
        const node = findNodeById(focusId);
        if (node?.isDirectory) {
          e.preventDefault();
          if (e.key === "ArrowRight") {
            onExpandFolder(node.path);
          } else {
            if (isFolderExpanded(node.path)) {
              onToggleFolder(node.path);
            }
          }
        }
        return;
      }

      if (e.key === "Enter" && focusId) {
        const node = findNodeById(focusId);
        if (!node) return;
        e.preventDefault();
        if (node.isDirectory) {
          onToggleFolder(node.path);
        } else {
          onItemClick?.(node);
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    selectedNodeId,
    activeItemId,
    flatNodeIds,
    isFolderExpanded,
    enableRename,
    enableDelete,
    findNodeById,
    startInlineRename,
    onDeleteItem,
    onItemClick,
    onToggleFolder,
    onExpandFolder,
  ]);

  // ── Rename input ──

  const renderInlineRenameInput = (nodeId: string) => (
    <input
      ref={renameInputRef}
      value={renameValue}
      onChange={e => setRenameValue(e.target.value)}
      onBlur={() => commitInlineRename(nodeId)}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commitInlineRename(nodeId);
        }
        if (e.key === "Escape") {
          e.preventDefault();
          cancelInlineRename();
        }
      }}
      onClick={e => e.stopPropagation()}
      style={{
        fontSize: "0.8125rem",
        fontFamily: "inherit",
        border: "1px solid",
        borderColor: "var(--mui-palette-divider, #ccc)",
        borderRadius: 4,
        padding: "1px 4px",
        outline: "none",
        width: "100%",
        background: "transparent",
        color: "inherit",
      }}
    />
  );

  // ── Recursive tree render ──

  const renderTree = (
    nodes: ResourceTreeNode[],
    depth: number = 0,
    readOnlyContext: boolean = false,
  ): ReactNode[] => {
    const items: ReactNode[] = [];

    for (const node of nodes) {
      if (!showFiles && !node.isDirectory) continue;

      const isExpanded = node.isDirectory && isFolderExpanded(node.path);
      const isActive = mode === "sidebar" && activeItemId === node.id;
      const isSelected = selectedNodeId === node.id;
      const isRenaming = renamingItemId === node.id;

      if (node.isDirectory) {
        const folderRow = (
          <ListItemButton
            key={node.id}
            data-node-id={node.id}
            selected={isSelected}
            onClick={() => {
              onToggleFolder(node.path);
              setSelectedNodeId(node.id);
            }}
            onContextMenu={e => handleContextMenu(e, node, readOnlyContext)}
            sx={{
              pl: 0.5 + depth * 1.5,
              py: 0.25,
              minHeight: 28,
            }}
          >
            <ListItemIcon sx={{ minWidth: 22 }}>
              {isExpanded ? (
                <ChevronDown size={14} strokeWidth={1.5} />
              ) : (
                <ChevronRight size={14} strokeWidth={1.5} />
              )}
            </ListItemIcon>
            <ListItemIcon sx={{ minWidth: 22 }}>
              {isExpanded ? (
                <FolderOpen size={16} strokeWidth={1.5} />
              ) : (
                <Folder size={16} strokeWidth={1.5} />
              )}
            </ListItemIcon>
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

        const wrappedRow = enableDragDrop ? (
          <DraggableTreeItem
            key={`drag-${node.id}`}
            id={node.id}
            isFolder
            disabled={readOnlyContext}
          >
            {folderRow}
          </DraggableTreeItem>
        ) : (
          folderRow
        );

        items.push(wrappedRow);

        if (isExpanded && node.children) {
          const childContent = renderTree(
            node.children,
            depth + 1,
            readOnlyContext,
          );

          if (enableDragDrop) {
            items.push(
              <DroppableFolderContent
                key={`drop-${node.id}`}
                folderId={node.id}
              >
                {childContent}
              </DroppableFolderContent>,
            );
          } else {
            items.push(...childContent);
          }
        }
      } else {
        const icon = getItemIcon ? getItemIcon(node) : null;
        const fileRow = (
          <ListItemButton
            key={node.id}
            data-node-id={node.id}
            selected={isActive || isSelected}
            onClick={() => {
              setSelectedNodeId(node.id);
              onItemClick?.(node);
            }}
            onContextMenu={e =>
              handleContextMenu(e, node, readOnlyContext || node.readOnly)
            }
            sx={{
              pl: 0.5 + depth * 1.5 + (icon ? 0 : 1.5),
              py: 0.25,
              minHeight: 28,
            }}
          >
            {icon && (
              <ListItemIcon sx={{ minWidth: 22, visibility: "visible" }}>
                <Box sx={{ width: 14 }} />
              </ListItemIcon>
            )}
            {icon && <ListItemIcon sx={{ minWidth: 22 }}>{icon}</ListItemIcon>}
            {!icon && (
              <ListItemIcon sx={{ minWidth: 22, visibility: "hidden" }}>
                <ChevronRight size={14} />
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
                },
              }}
            />
          </ListItemButton>
        );

        items.push(
          enableDragDrop ? (
            <DraggableTreeItem
              key={`drag-${node.id}`}
              id={node.id}
              disabled={readOnlyContext || node.readOnly}
            >
              {fileRow}
            </DraggableTreeItem>
          ) : (
            fileRow
          ),
        );
      }
    }
    return items;
  };

  // ── Section header ──

  const renderSectionHeader = (section: ResourceTreeSection) => {
    const isExpanded = sectionExpanded[section.key] !== false;
    const filtered = filteredSections.find(s => s.key === section.key);
    const count = filtered ? countItems(filtered.nodes) : 0;

    const header = (
      <ListItemButton
        onClick={() =>
          setSectionExpanded(prev => ({
            ...prev,
            [section.key]: !isExpanded,
          }))
        }
        onContextMenu={e => handleSectionContextMenu(e, section.key)}
        sx={{ px: 1, py: 0.5, gap: 0.5, minHeight: 32 }}
      >
        {isExpanded ? (
          <ChevronDown size={16} strokeWidth={1.5} />
        ) : (
          <ChevronRight size={16} strokeWidth={1.5} />
        )}
        <Box sx={{ display: "flex", flexShrink: 0 }}>{section.icon}</Box>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 600,
            textTransform: "uppercase",
            fontSize: "0.7rem",
            letterSpacing: "0.05em",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {section.label}
        </Typography>
        <Chip
          label={count}
          size="small"
          sx={{ height: 20, fontSize: "0.7rem" }}
        />
      </ListItemButton>
    );

    if (enableDragDrop && section.droppableId) {
      return (
        <DroppableSectionHeader
          key={`section-${section.key}`}
          id={section.droppableId}
        >
          {header}
        </DroppableSectionHeader>
      );
    }
    return (
      <React.Fragment key={`section-${section.key}`}>{header}</React.Fragment>
    );
  };

  // ── Render ──

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <List dense disablePadding>
        {filteredSections.map(section => (
          <React.Fragment key={section.key}>
            {renderSectionHeader(section)}
            {sectionExpanded[section.key] !== false && (
              <>
                {section.nodes.length > 0 ? (
                  renderTree(
                    section.nodes,
                    1,
                    section.defaultAccess === "workspace",
                  )
                ) : (
                  <Typography
                    variant="caption"
                    color="text.disabled"
                    sx={{ display: "block", pl: 4, py: 0.5 }}
                  >
                    Empty
                  </Typography>
                )}
              </>
            )}
          </React.Fragment>
        ))}
      </List>

      {/* Drag overlay */}
      <DragOverlay>
        {draggedNode && (
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
            <span>{draggedNode.name}</span>
          </Box>
        )}
      </DragOverlay>

      {/* Item context menu */}
      <Menu
        open={!!contextMenu}
        onClose={() => setContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu?.anchorPosition}
      >
        {contextMenu &&
          (() => {
            const { item, readOnly } = contextMenu;
            const canManage = canManageItem ? canManageItem(item) : !readOnly;

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
                    onExpandFolder(item.path);
                    await onCreateFolder?.(item.id, item.access);
                  }}
                >
                  <FolderPlus size={14} style={{ marginRight: 8 }} />
                  New Subfolder
                </MenuItem>
              ),
              enableMove && canManage && (
                <MenuItem
                  key="move"
                  onClick={() => {
                    setContextMenu(null);
                  }}
                >
                  <ArrowRightLeft size={14} style={{ marginRight: 8 }} />
                  Move to...
                </MenuItem>
              ),
              enableInfo && (
                <MenuItem
                  key="info"
                  onClick={() => {
                    setContextMenu(null);
                    onInfoRequest?.(item);
                  }}
                >
                  <Info size={14} style={{ marginRight: 8 }} />
                  Information
                </MenuItem>
              ),
              enableDelete && canManage && (
                <React.Fragment key="delete-group">
                  <Divider />
                  <MenuItem
                    onClick={() => {
                      setContextMenu(null);
                      onDeleteItem?.(item);
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

      {/* Section context menu */}
      <Menu
        open={!!sectionContextMenu}
        onClose={() => setSectionContextMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={sectionContextMenu?.anchorPosition}
      >
        {sectionContextMenu && enableNewFolder && (
          <MenuItem
            onClick={async () => {
              const sk = sectionContextMenu.sectionKey;
              setSectionContextMenu(null);
              const section = sections.find(s => s.key === sk);
              await onCreateFolder?.(null, section?.defaultAccess);
            }}
          >
            <FolderPlus size={14} style={{ marginRight: 8 }} />
            New Folder
          </MenuItem>
        )}
      </Menu>
    </DndContext>
  );
}

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
