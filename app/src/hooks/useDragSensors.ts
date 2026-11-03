import { MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";

/**
 * dnd-kit sensors for lists that also have to scroll on a phone.
 *
 * A mouse drag starts after `mouseDistance` px of movement, so a click still
 * selects. A touch drag needs a long-press (250ms, under 5px of movement):
 * a single distance-based PointerSensor turned every vertical swipe over a
 * tree row into a drag, because the whole row is the handle and a scroll
 * travels 8px before the browser claims the pan. Anything that moves first is
 * a scroll, and the browser keeps it.
 *
 * Do not put `touch-action: none` on the draggables: TouchSensor blocks
 * scrolling itself once a drag is active, and the CSS would block it always.
 */
export function useDragSensors(mouseDistance: number) {
  return useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: mouseDistance },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
  );
}
