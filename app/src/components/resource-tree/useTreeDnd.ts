import { useCallback, useState, type CSSProperties } from "react";
import type {
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import type { ResourceTreeNode, ResourceTreeSection } from "./types";
import { findNodeInSections, resolveTreeDropTarget } from "./utils";

/**
 * Touch drags start on a long-press (see useDragSensors), which iOS would
 * otherwise also answer with its callout menu. No `user-select: none` here:
 * the inline rename input renders inside the drag wrappers.
 */
export function dragWrapperStyle(isDragging: boolean): CSSProperties {
  return {
    opacity: isDragging ? 0.4 : 1,
    WebkitTouchCallout: "none",
  };
}

/**
 * The tree drop target an `over` droppable stands for. Flat rows of the same
 * folder share a target, so it travels as droppable data (`dropTarget`)
 * rather than as the (necessarily unique) droppable id.
 */
export function resolveDropTarget(
  over: { id: string | number; data?: { current?: unknown } } | null,
): string | null {
  if (!over) return null;
  const data = over.data?.current as { dropTarget?: string } | undefined;
  return data?.dropTarget ?? String(over.id);
}

interface UseTreeDndArgs {
  sections: ResourceTreeSection[];
  findNodeLocation: (
    id: string,
  ) => { node: ResourceTreeNode; sectionKey: string } | null;
  onSectionDrop?: (sectionKey: string, nodeId: string) => boolean | void;
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
}

/** Drag state and the drop → move resolution for the tree. */
export function useTreeDnd({
  sections,
  findNodeLocation,
  onSectionDrop,
  onMoveItem,
  onMoveFolder,
}: UseTreeDndArgs) {
  const [draggedNode, setDraggedNode] = useState<ResourceTreeNode | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const location = findNodeLocation(String(event.active.id));
      setDraggedNode(location?.node ?? null);
    },
    [findNodeLocation],
  );

  const handleDragOver = useCallback((event: DragOverEvent) => {
    setDropTargetId(resolveDropTarget(event.over));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggedNode(null);
      setDropTargetId(null);

      const { active, over } = event;
      if (!active || !over) return;

      const activeId = String(active.id);
      const overId = resolveDropTarget(over) ?? String(over.id);
      if (activeId === overId) return;

      const activeLocation = findNodeLocation(activeId);
      if (!activeLocation) return;

      const target = resolveTreeDropTarget(sections, overId);
      if (!target) return;

      if (target.kind === "section") {
        // A section that is its own grouping claims the drop; an access
        // bucket (My X / Workspace) falls through to the move below.
        if (onSectionDrop?.(target.sectionKey, activeId) === true) return;
        if (activeLocation.node.isDirectory) {
          onMoveFolder?.(activeId, null, target.access);
        } else {
          onMoveItem?.(activeId, null, target.access);
        }
        return;
      }

      if (target.targetFolderId === activeId) return;
      // Never drop a folder into its own subtree.
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
    [findNodeLocation, onMoveFolder, onMoveItem, onSectionDrop, sections],
  );

  return {
    draggedNode,
    dropTargetId,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
  };
}
