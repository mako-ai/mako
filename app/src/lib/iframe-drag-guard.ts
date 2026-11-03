/**
 * While a pane divider drag is active, make every iframe transparent to
 * pointer events. Cross-origin iframes (e.g. the sandboxed app preview)
 * otherwise swallow pointermove/pointerup once the cursor crosses them,
 * freezing the drag mid-flight.
 *
 * Reference-counted so overlapping drags (e.g. an intersection drag that
 * activates a horizontal and a vertical handle at once) restore styles only
 * after the last one ends.
 */

let activeDrags = 0;
let savedStyles: Array<[HTMLIFrameElement, string]> = [];

export function setIframeDragGuard(active: boolean): void {
  if (active) {
    activeDrags += 1;
    if (activeDrags > 1) return;
    savedStyles = Array.from(document.querySelectorAll("iframe")).map(frame => [
      frame,
      frame.style.pointerEvents,
    ]);
    for (const [frame] of savedStyles) {
      frame.style.pointerEvents = "none";
    }
  } else {
    activeDrags = Math.max(0, activeDrags - 1);
    if (activeDrags > 0) return;
    for (const [frame, previous] of savedStyles) {
      frame.style.pointerEvents = previous;
    }
    savedStyles = [];
  }
}

/**
 * `elementRef` for resize `Separator`s that reports drags like
 * react-resizable-panels v3's `onDragging`. v4 has no drag callback, but it
 * marks the separator being dragged `data-separator="active"` — including
 * drags started in its hit area outside the visible strip, which never reach
 * the separator element's own pointer events.
 *
 * Create one per call site and keep it stable (module scope or useMemo): v4
 * re-attaches the ref whenever its identity changes. One instance can serve
 * many separators. React detaches with `ref(null)` without saying which
 * element, so separators that have left the document are dropped then.
 */
export function separatorDragRef(
  onDragging: (isDragging: boolean) => void = setIframeDragGuard,
): (element: HTMLElement | null) => void {
  type Entry = { observer: MutationObserver; dragging: boolean };
  const tracked = new Map<HTMLElement, Entry>();
  return element => {
    for (const [node, entry] of tracked) {
      if (node.isConnected) continue;
      entry.observer.disconnect();
      if (entry.dragging) onDragging(false);
      tracked.delete(node);
    }
    if (!element || tracked.has(element)) return;
    const entry: Entry = {
      dragging: false,
      observer: new MutationObserver(() => {
        const active = element.getAttribute("data-separator") === "active";
        if (active === entry.dragging) return;
        entry.dragging = active;
        onDragging(active);
      }),
    };
    entry.observer.observe(element, {
      attributes: true,
      attributeFilter: ["data-separator"],
    });
    tracked.set(element, entry);
  };
}
