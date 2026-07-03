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
