import {
  cloneElement,
  isValidElement,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";

interface DroppableSectionHeaderProps {
  id: string;
  children: ReactNode;
}

export function DroppableSectionHeader({
  id,
  children,
}: DroppableSectionHeaderProps) {
  const { setNodeRef } = useDroppable({ id });
  return <div ref={setNodeRef}>{children}</div>;
}

interface SectionScopeProps {
  droppableId?: string;
  children: ReactNode;
}

/**
 * Wraps a section header + its tree contents in a single block-level element.
 * This gives sticky section headers a containing block that spans the entire
 * section, so they stay pinned while the section is in view. When a
 * `droppableId` is provided, the outer element also acts as the section-level
 * drop target (replacing a separate `DroppableSectionHeader`).
 */
export function SectionScope({ droppableId, children }: SectionScopeProps) {
  const { setNodeRef } = useDroppable({
    id: droppableId ?? "__section_scope_noop",
    disabled: !droppableId,
  });
  return <div ref={droppableId ? setNodeRef : undefined}>{children}</div>;
}

interface DraggableFolderScopeProps {
  id: string;
  disabled?: boolean;
  header: ReactElement;
  children?: ReactNode;
}

/**
 * Wraps a folder's header + its expanded children in a single block-level
 * element. The outer element is both the drag source and the folder drop
 * target, but drag listeners only attach to the header so pointer events on
 * child rows don't initiate a folder drag. The wrapping element also gives
 * the sticky folder header a containing block that spans the entire folder,
 * so it stays pinned while scrolling through its descendants.
 */
export function DraggableFolderScope({
  id,
  disabled,
  header,
  children,
}: DraggableFolderScopeProps) {
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

  const headerElement = isValidElement(header)
    ? cloneElement(header, {
        ...attributes,
        ...listeners,
        ...(header.props as HTMLAttributes<HTMLElement>),
      })
    : header;

  return (
    <div ref={setRef} style={{ opacity: isDragging ? 0.4 : 1 }}>
      {headerElement}
      {children}
    </div>
  );
}

interface DroppableFolderContentProps {
  folderId: string;
  children: ReactNode;
}

export function DroppableFolderContent({
  folderId,
  children,
}: DroppableFolderContentProps) {
  const { setNodeRef } = useDroppable({
    id: `__folder_content_${folderId}`,
  });
  return <div ref={setNodeRef}>{children}</div>;
}

interface DraggableTreeItemProps {
  id: string;
  disabled?: boolean;
  isFolder?: boolean;
  children: ReactElement;
}

export function DraggableTreeItem({
  id,
  disabled,
  isFolder,
  children,
}: DraggableTreeItemProps) {
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

  const setRef = (element: HTMLElement | null) => {
    setDragRef(element);
    if (isFolder) {
      setDropRef(element);
    }
  };

  if (!isValidElement(children)) {
    return <div ref={setRef}>{children}</div>;
  }

  const childProps = children.props as HTMLAttributes<HTMLElement>;

  return (
    <div ref={setRef} style={{ opacity: isDragging ? 0.4 : 1 }}>
      {cloneElement(children, {
        ...attributes,
        ...listeners,
        ...childProps,
      })}
    </div>
  );
}
