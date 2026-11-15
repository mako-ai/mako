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

function Harness({ onItemClick }: { onItemClick: (id: string) => void }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <ResourceTree
      sections={sections}
      enableDragDrop={false}
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

describe("ResourceTree (flat rows)", () => {
  afterEach(cleanup);

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
