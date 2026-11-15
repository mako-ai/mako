import {
  cloneElement,
  type CSSProperties,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { dragWrapperStyle } from "./useTreeDnd";

interface TreeDropZoneProps {
  /** Unique droppable id for this row. */
  id: string;
  /** The tree drop target a drop here resolves to (see resolveDropTarget). */
  dropTarget: string;
  children: ReactNode;
}

/**
 * Drop zone for one flat (virtualized) row. Rows of the same folder share a
 * drop target, so the target travels as droppable data rather than as the
 * (necessarily unique) droppable id.
 */
export function TreeDropZone({ id, dropTarget, children }: TreeDropZoneProps) {
  const { setNodeRef } = useDroppable({ id, data: { dropTarget } });
  return <div ref={setNodeRef}>{children}</div>;
}

interface StickyScopeBoxProps {
  /** Absolute placement of the scope inside the tree. */
  style: CSSProperties;
  header: ReactElement<any>;
}

/** The scope box lets pointer events through to the rows under it. */
function scopeStyle(style: CSSProperties, extra?: CSSProperties) {
  return { ...style, pointerEvents: "none" as const, ...extra };
}

function withPointerEvents(header: ReactElement<any>, extra?: object) {
  const props = header.props as HTMLAttributes<HTMLElement>;
  return cloneElement(header, {
    ...extra,
    ...props,
    style: { ...(props.style ?? {}), pointerEvents: "auto" },
  });
}

/**
 * A folder header drawn as a sticky row over the flat list: the scope box
 * spans the folder's rows (so the header sticks while they scroll by, and
 * the whole folder is its drag source and drop target, as with the nested
 * tree), and the header carries the drag listeners.
 */
export function StickyFolderScope({
  id,
  disabled,
  style,
  header,
}: StickyScopeBoxProps & { id: string; disabled?: boolean }) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id, disabled });
  const { setNodeRef: setDropRef } = useDroppable({ id });
  const setRef = (element: HTMLElement | null) => {
    setDragRef(element);
    setDropRef(element);
  };
  return (
    <div ref={setRef} style={scopeStyle(style, dragWrapperStyle(isDragging))}>
      {withPointerEvents(header, { ...attributes, ...listeners })}
    </div>
  );
}

/** Section header scope; the section's drop target when it has one. */
export function StickySectionScope({
  droppableId,
  style,
  header,
}: StickyScopeBoxProps & { droppableId?: string }) {
  const { setNodeRef } = useDroppable({
    id: droppableId ?? "__section_scope_noop",
    disabled: !droppableId,
  });
  return (
    <div ref={droppableId ? setNodeRef : undefined} style={scopeStyle(style)}>
      {withPointerEvents(header)}
    </div>
  );
}

/** Plain (no drag-and-drop) sticky scope. */
export function StickyScopeBox({ style, header }: StickyScopeBoxProps) {
  return <div style={scopeStyle(style)}>{withPointerEvents(header)}</div>;
}
