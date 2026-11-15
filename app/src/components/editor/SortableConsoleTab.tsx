import type React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { Tab, type Theme } from "@mui/material";

/**
 * MUI <Tabs> clones its direct children to inject props (selected, onChange,
 * textColor, indicator, ...). This wrapper accepts all Tab props (plus MUI's
 * clone-injected extras), wires up dnd-kit's useSortable for drag-to-reorder,
 * and forwards everything to an underlying <Tab>.
 *
 * UX:
 * - Dragged tab stays in place (only dimmed); no translation or layout shift.
 * - A thin vertical bar (drop indicator) is rendered on the leading or
 *   trailing edge of the tab currently under the pointer, showing where the
 *   dragged tab will land on drop.
 *
 * Implementation notes:
 * - We intentionally do NOT spread dnd-kit's `attributes` onto the Tab — they
 *   include role="button"/tabIndex which would clobber MUI Tab's own
 *   role="tab"/tabIndex logic and break tab selection + cause a feedback
 *   loop with MUI Tabs' indicator ResizeObserver.
 * - We use inline `style` (not `sx`) for the drag opacity so emotion doesn't
 *   churn className hashes on every pointer move during a drag.
 */
export function SortableConsoleTab(props: React.ComponentProps<typeof Tab>) {
  const id = props.value as string;
  const { listeners, setNodeRef, isDragging, isOver, activeIndex, overIndex } =
    useSortable({ id });

  // Show a drop indicator on the hovered tab, but not on the dragged tab
  // itself and not when dropping would be a no-op (same index).
  const showIndicator =
    isOver && !isDragging && activeIndex !== -1 && activeIndex !== overIndex;
  // Leading edge when moving the tab to the left, trailing edge when moving
  // it to the right.
  const indicatorSide: "left" | "right" =
    activeIndex > overIndex ? "left" : "right";

  const dragStyle: React.CSSProperties = {
    opacity: isDragging ? 0.4 : 1,
  };

  const indicatorSx = showIndicator
    ? {
        "&::after": {
          content: '""',
          position: "absolute",
          top: 0,
          bottom: 0,
          [indicatorSide]: -3,
          width: "6px",
          backgroundColor: (theme: Theme) =>
            theme.palette.mode === "dark"
              ? theme.palette.common.white
              : theme.palette.common.black,
          pointerEvents: "none",
          zIndex: 2,
        },
      }
    : undefined;

  const mergedSx = indicatorSx
    ? ([props.sx, indicatorSx] as React.ComponentProps<typeof Tab>["sx"])
    : props.sx;

  return (
    <Tab
      {...props}
      {...listeners}
      ref={setNodeRef as unknown as React.Ref<HTMLDivElement>}
      sx={mergedSx}
      style={{ ...(props.style || {}), ...dragStyle }}
    />
  );
}
