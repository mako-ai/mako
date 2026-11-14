// @vitest-environment jsdom
/**
 * A rename can be the explorer's own: `onRequestRename` is asked whenever
 * one starts (F2, double-click), and a row it takes never gets the inline
 * box. An app row uses it to open its Rename dialog — it shows the app's
 * name, and an unlabelled box holding its link was not a rename anyone
 * could read.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResourceTree, { type ResourceTreeNode } from "./ResourceTree";

afterEach(cleanup);

const nodes: ResourceTreeNode[] = [
  {
    id: "app1",
    name: "Revenue report",
    path: "apps/revenue",
    isDirectory: false,
  },
  { id: "note", name: "Notes", path: "notes", isDirectory: false },
];

function renderTree(onRequestRename?: (node: ResourceTreeNode) => boolean) {
  const onRenameItem = vi.fn();
  render(
    <ResourceTree
      sections={[{ key: "s", label: "Apps", nodes, hideSectionHeader: true }]}
      activeItemId="app1"
      enableDragDrop={false}
      onRenameItem={onRenameItem}
      onRequestRename={onRequestRename}
      isFolderExpanded={() => true}
      onToggleFolder={() => undefined}
      onExpandFolder={() => undefined}
    />,
  );
  return { onRenameItem };
}

describe("ResourceTree onRequestRename", () => {
  it("hands the rename to the explorer and opens no inline box, on double-click and on F2", () => {
    const asked: string[] = [];
    renderTree(node => {
      asked.push(node.id);
      return node.id === "app1";
    });
    fireEvent.doubleClick(screen.getByText("Revenue report"));
    expect(asked).toEqual(["app1"]);
    expect(screen.queryByRole("textbox")).toBeNull();
    // F2 acts on the focused row.
    fireEvent.click(screen.getByText("Revenue report"));
    fireEvent.keyDown(window, { key: "F2" });
    expect(asked).toEqual(["app1", "app1"]);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps the inline box for a row the explorer does not take, and without the prop", () => {
    renderTree(node => node.id === "app1");
    fireEvent.doubleClick(screen.getByText("Notes"));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
      "Notes",
    );
    cleanup();
    renderTree();
    fireEvent.doubleClick(screen.getByText("Revenue report"));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
      "Revenue report",
    );
  });
});
