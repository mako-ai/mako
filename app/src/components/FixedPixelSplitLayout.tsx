import { useCallback, useRef, type ReactNode } from "react";
import { Box, styled } from "@mui/material";
import {
  SIDE_PANEL_COLLAPSE_THRESHOLD_PX,
  SIDE_PANEL_MAX_WIDTH_PX,
  SIDE_PANEL_MIN_WIDTH_PX,
} from "../store/uiStore";

const MIN_CENTER_PANEL_WIDTH_PX = 320;
const HANDLE_WIDTH_PX = 4;

const ResizeHandle = styled("div")(({ theme }) => ({
  width: HANDLE_WIDTH_PX,
  flexShrink: 0,
  background: theme.palette.divider,
  cursor: "col-resize",
  transition: "background-color 0.2s ease",
  touchAction: "none",
  "&:hover": {
    backgroundColor: theme.palette.primary.main,
  },
}));

function clampWidth(px: number): number {
  return Math.min(
    Math.max(px, SIDE_PANEL_MIN_WIDTH_PX),
    SIDE_PANEL_MAX_WIDTH_PX,
  );
}

type DragSide = "left" | "right";

function usePixelResizeDrag({
  side,
  getStartWidth,
  onWidthChange,
  onDragEnd,
  getMaxWidth,
}: {
  side: DragSide;
  getStartWidth: () => number;
  onWidthChange: (widthPx: number) => void;
  onDragEnd?: (widthPx: number) => void;
  getMaxWidth: () => number;
}) {
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(0);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      dragStartXRef.current = event.clientX;
      dragStartWidthRef.current = getStartWidth();

      const onPointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        const deltaX = moveEvent.clientX - dragStartXRef.current;
        const signedDelta = side === "left" ? deltaX : -deltaX;
        const maxWidth = getMaxWidth();
        const nextWidth = clampWidth(
          Math.min(dragStartWidthRef.current + signedDelta, maxWidth),
        );
        onWidthChange(nextWidth);
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== event.pointerId) return;
        handle.releasePointerCapture(event.pointerId);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        const deltaX = upEvent.clientX - dragStartXRef.current;
        const signedDelta = side === "left" ? deltaX : -deltaX;
        const maxWidth = getMaxWidth();
        const finalWidth = clampWidth(
          Math.min(dragStartWidthRef.current + signedDelta, maxWidth),
        );
        onDragEnd?.(finalWidth);
      };

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [getMaxWidth, getStartWidth, onDragEnd, onWidthChange, side],
  );

  return onPointerDown;
}

export interface FixedPixelSplitLayoutProps {
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidthPx: number;
  rightWidthPx: number;
  onLeftWidthChange: (widthPx: number) => void;
  onRightWidthChange: (widthPx: number) => void;
  onLeftCollapse: () => void;
  onRightCollapse: () => void;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
}

export function FixedPixelSplitLayout({
  leftOpen,
  rightOpen,
  leftWidthPx,
  rightWidthPx,
  onLeftWidthChange,
  onRightWidthChange,
  onLeftCollapse,
  onRightCollapse,
  left,
  center,
  right,
}: FixedPixelSplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const getMaxLeftWidth = useCallback(() => {
    const containerWidth = containerRef.current?.clientWidth ?? 0;
    if (containerWidth <= 0) return SIDE_PANEL_MAX_WIDTH_PX;
    const rightOccupied = rightOpen ? rightWidthPx + HANDLE_WIDTH_PX : 0;
    const leftHandle = leftOpen ? HANDLE_WIDTH_PX : 0;
    return Math.max(
      SIDE_PANEL_MIN_WIDTH_PX,
      containerWidth - rightOccupied - leftHandle - MIN_CENTER_PANEL_WIDTH_PX,
    );
  }, [leftOpen, rightOpen, rightWidthPx]);

  const getMaxRightWidth = useCallback(() => {
    const containerWidth = containerRef.current?.clientWidth ?? 0;
    if (containerWidth <= 0) return SIDE_PANEL_MAX_WIDTH_PX;
    const leftOccupied = leftOpen ? leftWidthPx + HANDLE_WIDTH_PX : 0;
    const rightHandle = rightOpen ? HANDLE_WIDTH_PX : 0;
    return Math.max(
      SIDE_PANEL_MIN_WIDTH_PX,
      containerWidth - leftOccupied - rightHandle - MIN_CENTER_PANEL_WIDTH_PX,
    );
  }, [leftOpen, leftWidthPx, rightOpen]);

  const finishLeftDrag = useCallback(
    (widthPx: number) => {
      if (widthPx < SIDE_PANEL_COLLAPSE_THRESHOLD_PX) {
        onLeftCollapse();
        return;
      }
      onLeftWidthChange(widthPx);
    },
    [onLeftCollapse, onLeftWidthChange],
  );

  const finishRightDrag = useCallback(
    (widthPx: number) => {
      if (widthPx < SIDE_PANEL_COLLAPSE_THRESHOLD_PX) {
        onRightCollapse();
        return;
      }
      onRightWidthChange(widthPx);
    },
    [onRightCollapse, onRightWidthChange],
  );

  const onLeftHandlePointerDown = usePixelResizeDrag({
    side: "left",
    getStartWidth: () => leftWidthPx,
    onWidthChange: onLeftWidthChange,
    onDragEnd: finishLeftDrag,
    getMaxWidth: getMaxLeftWidth,
  });

  const onRightHandlePointerDown = usePixelResizeDrag({
    side: "right",
    getStartWidth: () => rightWidthPx,
    onWidthChange: onRightWidthChange,
    onDragEnd: finishRightDrag,
    getMaxWidth: getMaxRightWidth,
  });

  return (
    <Box
      ref={containerRef}
      sx={{
        display: "flex",
        height: "100%",
        width: "100%",
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      {leftOpen ? (
        <>
          <Box
            sx={{
              width: leftWidthPx,
              flexShrink: 0,
              height: "100%",
              overflow: "hidden",
              minWidth: 0,
            }}
          >
            {left}
          </Box>
          <ResizeHandle onPointerDown={onLeftHandlePointerDown} />
        </>
      ) : null}

      <Box sx={{ flex: 1, minWidth: 0, height: "100%", overflow: "hidden" }}>
        {center}
      </Box>

      {rightOpen ? (
        <>
          <ResizeHandle onPointerDown={onRightHandlePointerDown} />
          <Box
            sx={{
              width: rightWidthPx,
              flexShrink: 0,
              height: "100%",
              overflow: "hidden",
              minWidth: 0,
              borderLeft: "1px solid",
              borderColor: "divider",
            }}
          >
            {right}
          </Box>
        </>
      ) : null}
    </Box>
  );
}
