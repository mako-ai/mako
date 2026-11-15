import React, {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Box, List } from "@mui/material";
import {
  Virtuoso,
  type Components,
  type ListItem,
  type VirtuosoHandle,
} from "react-virtuoso";
import { DraggableTreeItem } from "./dnd";
import {
  StickyFolderScope,
  StickyScopeBox,
  StickySectionScope,
  TreeDropZone,
} from "./flat-dnd";
import {
  ancestorFolderIds,
  computeStickyScopes,
  type FlatRow,
  type RenderedItem,
  type StickyScope,
} from "./flatten";
import {
  EmptyFolderRow,
  FileRow,
  FolderRow,
  SectionEmptyRow,
  SectionHeaderRow,
  SkeletonRow,
} from "./TreeRows";

export interface VirtualTreeListHandle {
  /** Scroll a row to the middle of the panel; false if it isn't rendered. */
  revealIndex: (index: number) => boolean;
}

interface VirtualTreeListProps {
  rows: FlatRow[];
  enableDragDrop: boolean;
  draggedNodeId: string | null;
  canManage: (row: Extract<FlatRow, { kind: "folder" | "file" }>) => boolean;
}

/**
 * The nearest scrollable ancestor — the explorer's scroll container. The
 * explorers scroll inside VSScrollArea (OverlayScrollbars), whose viewport is
 * marked `data-overlayscrollbars-viewport`; it is created after a deferred
 * init, so it may not exist yet on the first layout pass.
 */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  const overlayViewport = el?.closest<HTMLElement>(
    "[data-overlayscrollbars-viewport]",
  );
  if (overlayViewport) return overlayViewport;
  let node = el?.parentElement ?? null;
  while (node && node !== document.body) {
    const { overflowY } = window.getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(overflowY)) return node;
    node = node.parentElement;
  }
  return null;
}

// Keeps MUI's `dense` ListContext around every row, and forwards the inline
// style Virtuoso uses to offset the rendered window.
const VirtuosoRowList: Components<FlatRow>["List"] = memo(
  forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
    function VirtuosoRowList({ style, children, ...rest }, ref) {
      return (
        <List
          component="div"
          dense
          disablePadding
          ref={ref}
          style={style}
          {...rest}
        >
          {children}
        </List>
      );
    },
  ),
);

function sameRendered(a: RenderedItem[], b: RenderedItem[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (item, i) =>
        item.index === b[i].index &&
        item.offset === b[i].offset &&
        item.size === b[i].size,
    )
  );
}

const VIRTUOSO_COMPONENTS: Components<FlatRow> = { List: VirtuosoRowList };
const VIEWPORT_OVERSCAN = { top: 400, bottom: 600 };

/**
 * The tree's rows, virtualized against the explorer's own scroll container
 * (react-virtuoso `customScrollParent`), with section and expanded-folder
 * headers drawn as sticky rows over the list so ancestors stay pinned while
 * their contents scroll, exactly as the nested tree did. Without a
 * scrollable ancestor (tests, unbounded containers) every row renders.
 */
export const VirtualTreeList = forwardRef<
  VirtualTreeListHandle,
  VirtualTreeListProps
>(function VirtualTreeList(
  { rows, enableDragDrop, draggedNodeId, canManage },
  ref,
) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // undefined: not resolved yet (render nothing for one layout pass).
  const [scrollParent, setScrollParent] = useState<
    HTMLElement | null | undefined
  >(undefined);
  const [rendered, setRendered] = useState<RenderedItem[]>([]);
  const [totalHeight, setTotalHeight] = useState(0);

  useLayoutEffect(() => {
    const resolved = findScrollParent(wrapperRef.current);
    setScrollParent(resolved);
    if (resolved) return;
    // Inside an OverlayScrollbars host whose deferred init hasn't run yet:
    // pick the viewport up once it appears (bounded, then stay unvirtualized).
    if (!wrapperRef.current?.closest("[data-overlayscrollbars-initialize]")) {
      return;
    }
    let frames = 0;
    let handle = requestAnimationFrame(function retry() {
      const found = findScrollParent(wrapperRef.current);
      if (found) setScrollParent(found);
      else if (++frames < 120) handle = requestAnimationFrame(retry);
    });
    return () => cancelAnimationFrame(handle);
  }, []);

  const virtualized = !!scrollParent;

  // Without virtualization, measure the rendered rows ourselves so sticky
  // scopes get the same geometry Virtuoso reports.
  useLayoutEffect(() => {
    if (scrollParent !== null) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const items: RenderedItem[] = [];
    wrapper
      .querySelectorAll<HTMLElement>(
        ":scope > [data-flat-list] > [data-flat-index]",
      )
      .forEach(el => {
        items.push({
          index: Number(el.dataset.flatIndex),
          offset: el.offsetTop,
          size: el.offsetHeight,
        });
      });
    // Bail out when nothing moved: a fresh array every pass re-renders, and
    // re-measuring after that render would never settle.
    setRendered(prev => (sameRendered(prev, items) ? prev : items));
    setTotalHeight(wrapper.offsetHeight);
  }, [rows, scrollParent]);

  const handleItemsRendered = useCallback((items: ListItem<FlatRow>[]) => {
    const next = items.map(item => ({
      index: item.index,
      offset: item.offset,
      size: item.size,
    }));
    setRendered(prev => (sameRendered(prev, next) ? prev : next));
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      revealIndex: index => {
        if (index < 0 || index >= rows.length) return false;
        if (virtuosoRef.current) {
          virtuosoRef.current.scrollToIndex({
            index,
            align: "center",
            behavior: "smooth",
          });
          return true;
        }
        const el = wrapperRef.current?.querySelector(
          `[data-flat-index="${index}"]`,
        );
        if (!el) return false;
        // Center the revealed row vertically rather than nudging it just
        // barely into view, so the focused entity lands near the middle.
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        return true;
      },
    }),
    [rows.length],
  );

  const renderRow = (index: number, row: FlatRow) => (
    <FlatTreeRow
      row={row}
      index={index}
      rows={rows}
      enableDragDrop={enableDragDrop}
      draggedNodeId={draggedNodeId}
      canManage={canManage}
    />
  );

  const scopes = computeStickyScopes(rows, rendered, totalHeight);

  return (
    <List
      component="nav"
      dense
      disablePadding
      ref={wrapperRef}
      sx={{ position: "relative" }}
    >
      {scrollParent === undefined ? null : virtualized ? (
        <Virtuoso
          ref={virtuosoRef}
          customScrollParent={scrollParent}
          data={rows}
          computeItemKey={(_, row) => row.key}
          itemContent={renderRow}
          itemsRendered={handleItemsRendered}
          totalListHeightChanged={setTotalHeight}
          increaseViewportBy={VIEWPORT_OVERSCAN}
          components={VIRTUOSO_COMPONENTS}
        />
      ) : (
        <div data-flat-list>
          {rows.map((row, index) => (
            <div key={row.key} data-flat-index={index}>
              {renderRow(index, row)}
            </div>
          ))}
        </div>
      )}
      <StickyHeaders
        rows={rows}
        scopes={scopes}
        enableDragDrop={enableDragDrop}
        canManage={canManage}
      />
    </List>
  );
});

function FlatTreeRow({
  row,
  index,
  rows,
  enableDragDrop,
  draggedNodeId,
  canManage,
}: {
  row: FlatRow;
  index: number;
  rows: FlatRow[];
  enableDragDrop: boolean;
  draggedNodeId: string | null;
  canManage: VirtualTreeListProps["canManage"];
}) {
  // A dragged folder dims its whole scope, as the nested tree did.
  const dimmed =
    draggedNodeId !== null &&
    ancestorFolderIds(rows, index).includes(draggedNodeId);
  let content: React.ReactNode;

  switch (row.kind) {
    case "section-header":
      // Drawn live by StickyHeaders; this copy only holds its place.
      content = <SectionHeaderRow section={row.section} ghost />;
      break;
    case "folder":
      if (row.isExpanded) {
        // Expanded: a sticky scope header, drawn live by StickyHeaders.
        content = <FolderRow row={row} ghost />;
        break;
      }
      content = enableDragDrop ? (
        <DraggableTreeItem id={row.node.id} disabled={!canManage(row)} isFolder>
          <FolderRow row={row} />
        </DraggableTreeItem>
      ) : (
        <FolderRow row={row} />
      );
      break;
    case "file": {
      const fileRow = <FileRow row={row} />;
      content = enableDragDrop ? (
        <DraggableTreeItem id={row.node.id} disabled={!canManage(row)}>
          {fileRow}
        </DraggableTreeItem>
      ) : (
        fileRow
      );
      break;
    }
    case "skeleton":
      content = <SkeletonRow depth={row.depth} />;
      break;
    case "empty":
      content = <EmptyFolderRow depth={row.depth} />;
      break;
    case "section-empty":
      content = <SectionEmptyRow section={row.section} />;
      break;
    case "spacer":
      return <Box sx={{ height: 24 }} aria-hidden />;
  }

  if ("dropTarget" in row && row.dropTarget) {
    content = (
      <TreeDropZone id={`__row_${row.key}`} dropTarget={row.dropTarget}>
        {content}
      </TreeDropZone>
    );
  }
  return dimmed ? <div style={{ opacity: 0.4 }}>{content}</div> : content;
}

/**
 * Live section / expanded-folder headers. Each is `position: sticky` inside a
 * box spanning its scope, so the browser pins it (and pushes it out at the
 * scope's end) while scrolling; boxes let pointer events through.
 */
function StickyHeaders({
  rows,
  scopes,
  enableDragDrop,
  canManage,
}: {
  rows: FlatRow[];
  scopes: StickyScope[];
  enableDragDrop: boolean;
  canManage: VirtualTreeListProps["canManage"];
}) {
  return (
    <>
      {scopes.map(scope => {
        const row = rows[scope.index];
        const style: React.CSSProperties = {
          position: "absolute",
          left: 0,
          right: 0,
          top: scope.top,
          height: scope.height,
        };
        if (row.kind === "section-header") {
          const header = <SectionHeaderRow section={row.section} />;
          return enableDragDrop ? (
            <StickySectionScope
              key={row.key}
              droppableId={row.section.droppableId}
              style={style}
              header={header}
            />
          ) : (
            <StickyScopeBox key={row.key} style={style} header={header} />
          );
        }
        if (row.kind !== "folder") return null;
        const header = <FolderRow row={row} />;
        return enableDragDrop ? (
          <StickyFolderScope
            key={row.key}
            id={row.node.id}
            disabled={!canManage(row)}
            style={style}
            header={header}
          />
        ) : (
          <StickyScopeBox key={row.key} style={style} header={header} />
        );
      })}
    </>
  );
}
