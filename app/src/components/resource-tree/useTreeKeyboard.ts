import { useEffect, useRef } from "react";
import type { ResourceTreeNode } from "./types";

export interface TreeKeyboardOptions {
  mode: "sidebar" | "picker";
  focusedNodeId: string | null;
  activeItemId: string | null | undefined;
  currentSelectedLocation: string | null;
  /** Visible node ids in display order (arrow-key navigation). */
  flatNodeIds: string[];
  findNodeLocation: (
    id: string,
  ) => { node: ResourceTreeNode; sectionKey: string } | null;
  resolveCanManage: (node: ResourceTreeNode) => boolean;
  isNodeExpanded: (node: ResourceTreeNode) => boolean;
  getExpansionKey: (node: ResourceTreeNode) => string;
  setFocusedNodeId: (id: string) => void;
  enableRename: boolean;
  enableDelete: boolean;
  enableDuplicate: boolean;
  enableInfo: boolean;
  startInlineRename: (node: ResourceTreeNode) => void;
  updateLocationSelection: (
    folderId: string | null,
    sectionKey: string,
  ) => void;
  onDeleteItem?: (node: ResourceTreeNode) => void;
  onDuplicateItem?: (node: ResourceTreeNode) => void;
  onInfoRequest?: (node: ResourceTreeNode) => void;
  onFolderInfoRequest?: (node: ResourceTreeNode) => void;
  onUndo?: () => void;
  onExpandFolder: (expansionKey: string) => void;
  onToggleFolder: (expansionKey: string) => void;
  onLoadChildren?: (node: ResourceTreeNode) => void;
  onPickerFileClick?: (node: ResourceTreeNode) => void;
  onItemClick?: (node: ResourceTreeNode) => void;
}

/**
 * Window-level keyboard shortcuts for the tree: arrows move focus / expand /
 * collapse, Enter opens, F2 renames, Delete deletes, ⌘D duplicates, ⌘I shows
 * info, ⌘Z undoes. Ignored while typing in an input or textarea.
 */
export function useTreeKeyboard(options: TreeKeyboardOptions) {
  // The listener reads the latest options without re-subscribing per render.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
      const o = optionsRef.current;

      const focusId =
        o.focusedNodeId ||
        (o.mode === "sidebar" ? o.activeItemId : o.currentSelectedLocation) ||
        null;
      const focusLocation = focusId ? o.findNodeLocation(focusId) : null;
      const focusItem = focusLocation?.node ?? null;
      const canManageFocused = focusItem
        ? o.resolveCanManage(focusItem)
        : false;
      const meta = event.metaKey || event.ctrlKey;

      if (
        event.key === "F2" &&
        focusItem &&
        o.enableRename &&
        canManageFocused
      ) {
        event.preventDefault();
        o.startInlineRename(focusItem);
        return;
      }

      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        focusItem &&
        o.enableDelete &&
        canManageFocused &&
        !meta
      ) {
        event.preventDefault();
        o.onDeleteItem?.(focusItem);
        return;
      }

      if (
        meta &&
        event.key.toLowerCase() === "d" &&
        focusItem &&
        o.enableDuplicate &&
        !focusItem.isDirectory
      ) {
        event.preventDefault();
        o.onDuplicateItem?.(focusItem);
        return;
      }

      if (
        meta &&
        event.key.toLowerCase() === "i" &&
        focusItem &&
        o.enableInfo
      ) {
        event.preventDefault();
        if (focusItem.isDirectory) {
          o.onFolderInfoRequest?.(focusItem);
        } else {
          o.onInfoRequest?.(focusItem);
        }
        return;
      }

      if (
        meta &&
        event.key.toLowerCase() === "z" &&
        !event.shiftKey &&
        o.onUndo
      ) {
        event.preventDefault();
        o.onUndo();
        return;
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const ids = o.flatNodeIds;
        const currentIndex = focusId ? ids.indexOf(focusId) : -1;
        const nextIndex =
          event.key === "ArrowDown"
            ? Math.min(currentIndex + 1, ids.length - 1)
            : Math.max(currentIndex - 1, 0);
        if (ids[nextIndex]) {
          o.setFocusedNodeId(ids[nextIndex]);
        }
        return;
      }

      if (event.key === "ArrowRight" && focusItem?.isDirectory) {
        event.preventDefault();
        if (!o.isNodeExpanded(focusItem)) {
          o.onExpandFolder(o.getExpansionKey(focusItem));
          if (focusItem.children === undefined && o.onLoadChildren) {
            o.onLoadChildren(focusItem);
          }
        }
        return;
      }

      if (event.key === "ArrowLeft" && focusItem?.isDirectory) {
        event.preventDefault();
        if (o.isNodeExpanded(focusItem)) {
          o.onToggleFolder(o.getExpansionKey(focusItem));
        }
        return;
      }

      if (event.key === "Enter" && focusItem && focusLocation) {
        event.preventDefault();
        if (focusItem.isDirectory) {
          if (o.mode === "picker") {
            o.updateLocationSelection(focusItem.id, focusLocation.sectionKey);
          } else {
            o.onToggleFolder(o.getExpansionKey(focusItem));
          }
        } else if (o.mode === "picker") {
          o.onPickerFileClick?.(focusItem);
        } else {
          o.onItemClick?.(focusItem);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
