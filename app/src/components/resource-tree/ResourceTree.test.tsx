// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import ResourceTree from "../ResourceTree";
import type { ResourceTreeNode, ResourceTreeSection } from "./types";

vi.mock("../../hooks/useIsMobile", () => ({ useIsMobile: () => false }));

const node = (id: string, children?: ResourceTreeNode[]): ResourceTreeNode => ({
  id,
  name: id,
  path: id,
  isDirectory: children !== undefined,
  children,
});

const sections: ResourceTreeSection[] = [
  {
    key: "my",
    label: "My Consoles",
    nodes: [node("reports", [node("weekly")]), node("scratch")],
  },
];

function Harness({
  onItemClick,
  enableDragDrop = false,
}: {
  onItemClick: (id: string) => void;
  enableDragDrop?: boolean;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <ResourceTree
      sections={sections}
      enableDragDrop={enableDragDrop}
      isFolderExpanded={key => !!expanded[key]}
      onToggleFolder={key => setExpanded(p => ({ ...p, [key]: !p[key] }))}
      onExpandFolder={key => setExpanded(p => ({ ...p, [key]: true }))}
      onItemClick={item => onItemClick(item.id)}
    />
  );
}

/** The live (interactive) row for a node; header ghosts are aria-hidden. */
const liveRow = (id: string) => {
  const el = document.querySelector(`[data-node-id="${id}"]`);
  if (!el) throw new Error(`row ${id} not rendered`);
  return el as HTMLElement;
};

/**
 * The inline pointer-events in effect for an element: the nearest ancestor
 * (or itself) that sets one. jsdom ignores pointer-events in hit testing, so
 * this checks the styles a browser would apply.
 */
const effectivePointerEvents = (el: HTMLElement | null) => {
  for (let node = el; node; node = node.parentElement) {
    if (node.style.pointerEvents) return node.style.pointerEvents;
  }
  return "auto";
};

describe("ResourceTree (flat rows)", () => {
  afterEach(cleanup);

  it("attaches drag handlers to file and folder rows", () => {
    render(<Harness onItemClick={vi.fn()} enableDragDrop />);
    // dnd-kit's attributes reach the row's own button, not a dropped prop.
    expect(liveRow("scratch").getAttribute("aria-roledescription")).toBe(
      "draggable",
    );
    expect(liveRow("reports").getAttribute("aria-roledescription")).toBe(
      "draggable",
    );
  });

  it("keeps pinned headers clickable inside their pointer-events:none scope", () => {
    render(<Harness onItemClick={vi.fn()} enableDragDrop />);
    fireEvent.click(liveRow("reports"));
    expect(effectivePointerEvents(liveRow("reports"))).not.toBe("none");
    const header = screen
      .getAllByText("My Consoles")
      .map(el => el.closest(".MuiListItemButton-root") as HTMLElement | null)
      .find(el => el && el.getAttribute("aria-hidden") !== "true");
    expect(effectivePointerEvents(header ?? null)).not.toBe("none");
  });

  it("expands and collapses folders on click", () => {
    render(<Harness onItemClick={vi.fn()} />);
    expect(screen.getAllByText("My Consoles").length).toBeGreaterThan(0);
    expect(document.querySelector('[data-node-id="weekly"]')).toBeNull();

    fireEvent.click(liveRow("reports"));
    expect(liveRow("weekly")).toBeTruthy();

    fireEvent.click(liveRow("reports"));
    expect(document.querySelector('[data-node-id="weekly"]')).toBeNull();
  });

  it("renders exactly one live row per node", () => {
    render(<Harness onItemClick={vi.fn()} />);
    fireEvent.click(liveRow("reports"));
    for (const id of ["reports", "weekly", "scratch"]) {
      expect(document.querySelectorAll(`[data-node-id="${id}"]`)).toHaveLength(
        1,
      );
    }
  });

  it("collapses a section from its header", () => {
    render(<Harness onItemClick={vi.fn()} />);
    const header = screen
      .getAllByText("My Consoles")
      .map(el => el.closest('[role="button"], .MuiListItemButton-root'))
      .find(el => el && el.getAttribute("aria-hidden") !== "true");
    expect(header).toBeTruthy();
    fireEvent.click(header as HTMLElement);
    expect(document.querySelector('[data-node-id="scratch"]')).toBeNull();
  });

  it("navigates with the keyboard and opens with Enter", () => {
    const onItemClick = vi.fn();
    render(<Harness onItemClick={onItemClick} />);
    fireEvent.click(liveRow("reports")); // focus + expand
    fireEvent.keyDown(window, { key: "ArrowDown" }); // weekly
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onItemClick).toHaveBeenCalledWith("weekly");

    fireEvent.keyDown(window, { key: "ArrowUp" }); // reports
    fireEvent.keyDown(window, { key: "ArrowLeft" }); // collapse
    expect(document.querySelector('[data-node-id="weekly"]')).toBeNull();
    fireEvent.keyDown(window, { key: "ArrowRight" }); // expand
    expect(liveRow("weekly")).toBeTruthy();
  });
});
