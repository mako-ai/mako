// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { separatorDragRef } from "./iframe-drag-guard";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function separator(): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("data-separator", "inactive");
  document.body.appendChild(el);
  return el;
}

describe("separatorDragRef", () => {
  it("reports a drag from the separator's active state, not its own pointer events", async () => {
    const calls: boolean[] = [];
    const ref = separatorDragRef(dragging => calls.push(dragging));
    const el = separator();
    ref(el);

    el.setAttribute("data-separator", "hover");
    await tick();
    expect(calls).toEqual([]);

    el.setAttribute("data-separator", "active");
    await tick();
    el.setAttribute("data-separator", "focus");
    await tick();
    expect(calls).toEqual([true, false]);
    el.remove();
  });

  it("serves several separators and releases one detached mid-drag", async () => {
    const calls: boolean[] = [];
    const ref = separatorDragRef(dragging => calls.push(dragging));
    const a = separator();
    const b = separator();
    ref(a);
    ref(b);
    ref(a); // re-attaching the same element is a no-op

    b.setAttribute("data-separator", "active");
    await tick();
    expect(calls).toEqual([true]);

    b.remove();
    ref(null);
    expect(calls).toEqual([true, false]);

    a.setAttribute("data-separator", "active");
    await tick();
    expect(calls).toEqual([true, false, true]);
    a.remove();
  });
});
