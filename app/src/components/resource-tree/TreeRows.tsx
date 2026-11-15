import React, {
  createContext,
  useContext,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  Box,
  ListItemButton,
  ListItemIcon,
  ListItemText as MuiListItemText,
  Skeleton,
  Typography,
} from "@mui/material";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import type { FlatRow } from "./flatten";
import type { ResourceTreeNode, ResourceTreeSection } from "./types";
import { getFolderDropTargetId, isSidebarRowActive } from "./utils";

/** Everything a row needs from the tree; provided once by ResourceTree. */
export interface TreeRowConfig {
  mode: "sidebar" | "picker";
  activeItemId: string | null | undefined;
  currentSelectedLocation: string | null;
  currentSelectedSectionKey: string;
  renamingItemId: string | null;
  renderRenameInput: (nodeId: string) => ReactNode;
  dropTargetId: string | null;
  sectionExpanded: Record<string, boolean>;
  rowHeight: number;
  iconColWidth: number;
  caretSize: number;
  hideFolderIcon: boolean;
  enableRename: boolean;
  getItemIcon?: (
    node: ResourceTreeNode,
    ctx?: { isExpanded: boolean },
  ) => ReactNode;
  getRightAdornment?: (node: ResourceTreeNode) => ReactNode;
  resolveCanManage: (node: ResourceTreeNode) => boolean;
  onFolderRowClick: (
    event: React.MouseEvent<HTMLElement>,
    node: ResourceTreeNode,
    sectionKey: string,
    isExpanded: boolean,
  ) => void;
  onToggleNode: (node: ResourceTreeNode, isExpanded: boolean) => void;
  onFileRowClick: (node: ResourceTreeNode) => void;
  onContextMenu: (event: React.MouseEvent, node: ResourceTreeNode) => void;
  onStartRename: (node: ResourceTreeNode) => void;
  onSectionClick: (sectionKey: string) => void;
  onSectionToggle: (sectionKey: string) => void;
  onSectionContextMenu: (event: React.MouseEvent, sectionKey: string) => void;
}

const TreeRowContext = createContext<TreeRowConfig | null>(null);
export const TreeRowProvider = TreeRowContext.Provider;

function useTreeRowConfig(): TreeRowConfig {
  const config = useContext(TreeRowContext);
  if (!config) throw new Error("Tree rows must render inside ResourceTree");
  return config;
}

const ROW_LABEL_SX = {
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

const RIGHT_ADORNMENT_SX = {
  ml: "auto",
  pl: 1,
  display: "flex",
  alignItems: "center",
  flexShrink: 0,
} as const;

/** Row chrome shared by folder and file rows. */
function buildRowSx({
  depth,
  rowHeight,
  isDropTarget,
  isSelected,
}: {
  depth: number;
  rowHeight: number;
  isDropTarget?: boolean;
  isSelected?: boolean;
}) {
  return {
    pl: 1.5 + depth * 1.5,
    minWidth: 0,
    py: 0,
    minHeight: rowHeight,
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
  };
}

function Caret({
  isExpanded,
  size,
  onClick,
  marker,
}: {
  isExpanded: boolean;
  size: number;
  onClick?: (event: React.MouseEvent) => void;
  /** Folder carets are found by the click handler (data-tree-caret). */
  marker?: boolean;
}) {
  return (
    <Box
      component="span"
      {...(marker ? { "data-tree-caret": true } : {})}
      onClick={onClick}
      sx={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
      }}
    >
      {isExpanded ? (
        <ChevronDown size={14} strokeWidth={1.5} />
      ) : (
        <ChevronRight size={14} strokeWidth={1.5} />
      )}
    </Box>
  );
}

function RightAdornment({ children }: { children: ReactNode }) {
  return children ? <Box sx={RIGHT_ADORNMENT_SX}>{children}</Box> : null;
}

/**
 * Extra DOM props a wrapper attaches to a row: dnd-kit's drag listeners and
 * attributes (DraggableTreeItem) and the sticky header's `pointer-events`
 * style (StickyScopeBox). They go on the row's ListItemButton, before its own
 * handlers, so the row's click/context-menu/rename handlers still win.
 */
type PassThroughProps = HTMLAttributes<HTMLElement>;

interface RowProps extends PassThroughProps {
  /** A layout-only copy (sticky headers draw the live one on top of it). */
  ghost?: boolean;
}

export function FolderRow({
  row,
  ghost,
  ...passThrough
}: RowProps & { row: Extract<FlatRow, { kind: "folder" }> }) {
  const c = useTreeRowConfig();
  const { node, depth, sectionKey, isExpanded } = row;
  const canManage = c.resolveCanManage(node);
  const isSelectedLocation =
    c.mode === "picker" && c.currentSelectedLocation === node.id;
  const isActive = isSidebarRowActive({
    mode: c.mode,
    activeItemId: c.activeItemId,
    nodeId: node.id,
  });
  const isRenaming = !ghost && c.renamingItemId === node.id;
  const isDropTarget =
    c.dropTargetId === node.id ||
    c.dropTargetId === getFolderDropTargetId(node.id);
  const rightAdornment = c.getRightAdornment?.(node);

  const folderIcon = c.hideFolderIcon ? null : c.getItemIcon ? (
    c.getItemIcon(node, { isExpanded })
  ) : isExpanded ? (
    <FolderOpen size={16} strokeWidth={1.5} />
  ) : (
    <Folder size={16} strokeWidth={1.5} />
  );

  return (
    <ListItemButton
      {...(ghost ? {} : passThrough)}
      data-node-id={ghost ? undefined : node.id}
      aria-hidden={ghost || undefined}
      tabIndex={ghost ? -1 : undefined}
      selected={isSelectedLocation || isActive}
      onClick={
        ghost
          ? undefined
          : event => c.onFolderRowClick(event, node, sectionKey, isExpanded)
      }
      onContextMenu={ghost ? undefined : event => c.onContextMenu(event, node)}
      onDoubleClick={
        ghost
          ? undefined
          : event => {
              if (c.enableRename && canManage) {
                event.stopPropagation();
                c.onStartRename(node);
              }
            }
      }
      sx={{
        ...buildRowSx({
          depth,
          rowHeight: c.rowHeight,
          isDropTarget,
          // Folder rows must respect the sidebar active highlight too —
          // entities like apps and Postgres tables open from a directory
          // row (see isSidebarRowActive). Picker selection still wins via
          // `isSelectedLocation`.
          isSelected: isSelectedLocation || isActive,
        }),
        position: "sticky",
        // Stack ancestor headers: depth=1 sits just below the section
        // header (which is sticky at top: 0), depth=2 one row below
        // that, and so on.
        top: depth * c.rowHeight,
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
          isDropTarget || isSelectedLocation || isActive
            ? undefined
            : "background.default",
        ...(ghost ? { visibility: "hidden" } : null),
      }}
    >
      <ListItemIcon
        sx={{
          minWidth: c.iconColWidth,
          mr: 0,
          // MUI's ListItemIcon defaults to `action.active` which looks
          // dimmed; the chevron should match the folder name's color.
          color: "text.primary",
        }}
      >
        <Caret
          marker
          isExpanded={isExpanded}
          size={c.caretSize}
          onClick={
            ghost
              ? undefined
              : event => {
                  event.stopPropagation();
                  c.onToggleNode(node, isExpanded);
                }
          }
        />
      </ListItemIcon>
      {/* Explorers can suppress a folder's icon by returning null from
          getItemIcon (e.g. to show an icon only on entity rows, not on their
          containing folders). Collapse the icon column so the label sits
          right after the chevron, like console folders. */}
      {folderIcon ? (
        <ListItemIcon sx={{ minWidth: c.iconColWidth, mr: 0.75 }}>
          {folderIcon}
        </ListItemIcon>
      ) : null}
      <MuiListItemText
        primary={isRenaming ? c.renderRenameInput(node.id) : node.name}
        slotProps={{
          primary: {
            variant: "body2",
            sx: { ...ROW_LABEL_SX, fontWeight: 500 },
          },
        }}
      />
      <RightAdornment>{rightAdornment}</RightAdornment>
    </ListItemButton>
  );
}

export function FileRow({
  row,
  ...passThrough
}: PassThroughProps & { row: Extract<FlatRow, { kind: "file" }> }) {
  const c = useTreeRowConfig();
  const { node, depth } = row;
  const canManage = c.resolveCanManage(node);
  const isActive = isSidebarRowActive({
    mode: c.mode,
    activeItemId: c.activeItemId,
    nodeId: node.id,
  });
  const isRenaming = c.renamingItemId === node.id;

  return (
    <ListItemButton
      {...passThrough}
      data-node-id={node.id}
      selected={isActive}
      onClick={() => c.onFileRowClick(node)}
      onContextMenu={event => c.onContextMenu(event, node)}
      onDoubleClick={event => {
        if (c.enableRename && canManage) {
          event.stopPropagation();
          c.onStartRename(node);
        }
      }}
      sx={buildRowSx({ depth, rowHeight: c.rowHeight, isSelected: isActive })}
    >
      {!c.hideFolderIcon && (
        <ListItemIcon
          sx={{ minWidth: c.iconColWidth, visibility: "hidden", mr: 0 }}
        />
      )}
      <ListItemIcon
        sx={{
          minWidth: c.iconColWidth,
          // In hideFolderIcon mode the file icon occupies the chevron
          // column. Use the same trailing gap as normal icon rows so
          // connector/database explorer text starts consistently.
          mr: 0.75,
        }}
      >
        {c.getItemIcon ? c.getItemIcon(node) : null}
      </ListItemIcon>
      <MuiListItemText
        primary={isRenaming ? c.renderRenameInput(node.id) : node.name}
        slotProps={{ primary: { variant: "body2", sx: ROW_LABEL_SX } }}
      />
      <RightAdornment>{c.getRightAdornment?.(node)}</RightAdornment>
    </ListItemButton>
  );
}

export function SectionHeaderRow({
  section,
  ghost,
  ...passThrough
}: RowProps & { section: ResourceTreeSection }) {
  const c = useTreeRowConfig();
  const headerSelected =
    c.mode === "picker" &&
    c.currentSelectedLocation === null &&
    c.currentSelectedSectionKey === section.key;
  const isDropTarget = section.droppableId === c.dropTargetId;

  return (
    <ListItemButton
      {...(ghost ? {} : passThrough)}
      aria-hidden={ghost || undefined}
      tabIndex={ghost ? -1 : undefined}
      selected={headerSelected}
      onClick={ghost ? undefined : () => c.onSectionClick(section.key)}
      onContextMenu={
        ghost ? undefined : event => c.onSectionContextMenu(event, section.key)
      }
      sx={{
        py: 0,
        pl: 1.5,
        minWidth: 0,
        minHeight: c.rowHeight,
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
        // stack below this (see rowHeight * depth on FolderRow).
        position: "sticky",
        top: 0,
        zIndex: 30,
        backgroundColor:
          isDropTarget || headerSelected ? undefined : "background.default",
        ...(ghost ? { visibility: "hidden" } : null),
      }}
    >
      <ListItemIcon
        sx={{ minWidth: c.iconColWidth, mr: 0, color: "text.primary" }}
      >
        <Caret
          isExpanded={c.sectionExpanded[section.key] !== false}
          size={c.caretSize}
          onClick={
            ghost
              ? undefined
              : event => {
                  event.stopPropagation();
                  c.onSectionToggle(section.key);
                }
          }
        />
      </ListItemIcon>
      {section.icon ? (
        <ListItemIcon sx={{ minWidth: c.iconColWidth, mr: 0.75 }}>
          {section.icon}
        </ListItemIcon>
      ) : null}
      <MuiListItemText
        primary={section.label}
        slotProps={{
          primary: {
            variant: "body2",
            sx: { fontWeight: 600, ...ROW_LABEL_SX },
          },
        }}
      />
    </ListItemButton>
  );
}

/** Indent of the placeholder rows under a folder at `depth`. */
const childIndent = (depth: number) => 1.5 + (depth + 1) * 1.5 + 2.75;

export function SkeletonRow({ depth }: { depth: number }) {
  return (
    <Box
      sx={{
        pl: childIndent(depth),
        py: 0.5,
        display: "flex",
        alignItems: "center",
      }}
    >
      <Skeleton
        variant="text"
        width={`${50 + Math.random() * 30}%`}
        height={16}
      />
    </Box>
  );
}

export function EmptyFolderRow({ depth }: { depth: number }) {
  const c = useTreeRowConfig();
  return (
    <Typography
      variant="caption"
      sx={{
        color: "text.disabled",
        pl: childIndent(depth),
        py: 0,
        minHeight: c.rowHeight,
        lineHeight: `${c.rowHeight}px`,
        display: "flex",
        alignItems: "center",
      }}
    >
      Empty
    </Typography>
  );
}

export function SectionEmptyRow({ section }: { section: ResourceTreeSection }) {
  return (
    <Typography
      sx={{
        pl: section.hideSectionHeader ? 2.5 : 4,
        py: 0.5,
        color: "text.disabled",
        fontSize: "0.8rem",
        fontStyle: "italic",
      }}
      variant="body2"
    >
      Nothing here yet
    </Typography>
  );
}
