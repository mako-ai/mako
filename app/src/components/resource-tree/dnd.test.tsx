// @vitest-environment jsdom
/**
 * A row that cannot be dragged is not a disabled row: a console shared with
 * this person opens, renames and has a menu, but the sidebar marked it
 * `aria-disabled="true"` (dnd-kit's attribute for a disabled DRAG source).
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { DraggableTreeItem } from "./dnd";
import { dragAttributes } from "./utils";

afterEach(cleanup);

function row(disabled: boolean) {
  render(
    <DndContext>
      <DraggableTreeItem id="c1" disabled={disabled}>
        <div data-testid="row">Secret Margin</div>
      </DraggableTreeItem>
    </DndContext>,
  );
  return screen.getByTestId("row");
}

describe("DraggableTreeItem", () => {
  it("does not mark a row it cannot drag as disabled", () => {
    const el = row(true);
    expect(el.getAttribute("aria-disabled")).toBeNull();
    expect(el.getAttribute("aria-roledescription")).toBeNull();
  });

  it("keeps the drag semantics of a row that can be dragged", () => {
    const el = row(false);
    expect(el.getAttribute("aria-disabled")).toBe("false");
    expect(el.getAttribute("aria-roledescription")).toBe("draggable");
  });
});

describe("dragAttributes", () => {
  it("passes an enabled drag source's attributes through", () => {
    const attrs = { role: "button", "aria-disabled": false };
    expect(dragAttributes(attrs, false)).toBe(attrs);
  });
});
