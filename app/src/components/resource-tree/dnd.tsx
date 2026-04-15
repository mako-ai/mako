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
