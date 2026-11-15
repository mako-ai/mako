import React, { type ReactNode } from "react";
import { Divider, Menu, MenuItem } from "@mui/material";
import {
  ArrowRightLeft,
  Copy,
  FolderPlus,
  Info,
  Pencil,
  Trash2,
} from "lucide-react";
import type { ResourceTreeNode } from "./types";

const MENU_ICON_STYLE = { marginRight: 8 };

export interface NodeMenuState {
  anchorPosition: { top: number; left: number };
  item: ResourceTreeNode;
  readOnly: boolean;
}

export interface SectionMenuState {
  anchorPosition: { top: number; left: number };
  sectionKey: string;
}

interface NodeContextMenuProps {
  menu: NodeMenuState | null;
  onClose: () => void;
  getContextMenuItems?: (
    node: ResourceTreeNode,
    helpers: { closeMenu: () => void },
  ) => ReactNode[] | null;
  enableRename: boolean;
  enableDuplicate: boolean;
  enableNewFolder: boolean;
  enableMove: boolean;
  enableInfo: boolean;
  enableDelete: boolean;
  onRename: (node: ResourceTreeNode) => void;
  onDuplicateItem?: (node: ResourceTreeNode) => void;
  onNewSubfolder: (node: ResourceTreeNode) => void;
  onMoveRequest?: (node: ResourceTreeNode) => void;
  onInfoRequest?: (node: ResourceTreeNode) => void;
  onFolderInfoRequest?: (node: ResourceTreeNode) => void;
  onDeleteItem?: (node: ResourceTreeNode) => void;
}

/** A row's context menu: the caller's items, or the default actions. */
export function NodeContextMenu({
  menu,
  onClose,
  getContextMenuItems,
  enableRename,
  enableDuplicate,
  enableNewFolder,
  enableMove,
  enableInfo,
  enableDelete,
  onRename,
  onDuplicateItem,
  onNewSubfolder,
  onMoveRequest,
  onInfoRequest,
  onFolderInfoRequest,
  onDeleteItem,
}: NodeContextMenuProps) {
  const renderItems = (): ReactNode => {
    if (!menu) return null;
    const { item, readOnly } = menu;
    const canManage = !readOnly;

    const customItems = getContextMenuItems?.(item, { closeMenu: onClose });
    if (customItems !== undefined && customItems !== null) {
      return customItems;
    }

    /** Close the menu, then run the action. */
    const act = (action: (node: ResourceTreeNode) => void) => () => {
      onClose();
      action(item);
    };

    return [
      enableRename && canManage && (
        <MenuItem key="rename" onClick={() => onRename(item)}>
          <Pencil size={14} style={MENU_ICON_STYLE} />
          Rename
        </MenuItem>
      ),
      enableDuplicate && !item.isDirectory && (
        <MenuItem
          key="duplicate"
          onClick={act(node => onDuplicateItem?.(node))}
        >
          <Copy size={14} style={MENU_ICON_STYLE} />
          Duplicate
        </MenuItem>
      ),
      enableNewFolder && item.isDirectory && canManage && (
        <MenuItem key="subfolder" onClick={act(onNewSubfolder)}>
          <FolderPlus size={14} style={MENU_ICON_STYLE} />
          New Subfolder
        </MenuItem>
      ),
      enableMove && canManage && onMoveRequest && (
        <MenuItem key="move" onClick={act(onMoveRequest)}>
          <ArrowRightLeft size={14} style={MENU_ICON_STYLE} />
          Move to...
        </MenuItem>
      ),
      enableInfo && !item.isDirectory && onInfoRequest && (
        <MenuItem key="info-file" onClick={act(onInfoRequest)}>
          <Info size={14} style={MENU_ICON_STYLE} />
          Information
        </MenuItem>
      ),
      enableInfo && item.isDirectory && onFolderInfoRequest && (
        <MenuItem key="info-folder" onClick={act(onFolderInfoRequest)}>
          <Info size={14} style={MENU_ICON_STYLE} />
          Information
        </MenuItem>
      ),
      enableDelete && canManage && onDeleteItem && (
        <React.Fragment key="delete-group">
          <Divider />
          <MenuItem onClick={act(onDeleteItem)} sx={{ color: "error.main" }}>
            <Trash2 size={14} style={MENU_ICON_STYLE} />
            Delete
          </MenuItem>
        </React.Fragment>
      ),
    ].filter(Boolean);
  };

  return (
    <Menu
      open={!!menu}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={menu?.anchorPosition}
    >
      {renderItems()}
    </Menu>
  );
}

interface SectionContextMenuProps {
  menu: SectionMenuState | null;
  onClose: () => void;
  getSectionContextMenuItems?: (
    sectionKey: string,
    helpers: { closeMenu: () => void },
  ) => ReactNode[] | null;
  /** Present when the default "New Folder" entry applies. */
  onNewFolder?: (sectionKey: string) => void;
}

/** A section header's menu: the caller's items, or "New Folder". */
export function SectionContextMenu({
  menu,
  onClose,
  getSectionContextMenuItems,
  onNewFolder,
}: SectionContextMenuProps) {
  const renderItems = (): ReactNode => {
    if (!menu) return null;
    const customItems = getSectionContextMenuItems?.(menu.sectionKey, {
      closeMenu: onClose,
    });
    if (customItems !== undefined && customItems !== null) {
      return customItems;
    }
    if (!onNewFolder) return null;
    return (
      <MenuItem onClick={() => onNewFolder(menu.sectionKey)}>
        <FolderPlus size={14} style={MENU_ICON_STYLE} />
        New Folder
      </MenuItem>
    );
  };

  return (
    <Menu
      open={!!menu}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={menu?.anchorPosition}
    >
      {renderItems()}
    </Menu>
  );
}
