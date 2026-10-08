// @vitest-environment jsdom
/**
 * "Move to…" is offered for an item where it is this person's to place —
 * never in a `noMoveOut` section (consoles' "Shared with me"): an admin's
 * "Move Here" from there put the owner's console at the owner's root,
 * unasked, while the editor's dialog said it stays in its owner's folder.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ResourceTree, { type ResourceTreeSection } from "./ResourceTree";

afterEach(() => cleanup());

const node = (id: string, name: string) => ({
  id,
  name,
  path: name,
  isDirectory: false,
});

function renderTree() {
  const sections: ResourceTreeSection[] = [
    {
      key: "my",
      label: "My Consoles",
      nodes: [node("mine", "Mine")],
      defaultAccess: "private",
    },
    {
      key: "shared",
      label: "Shared with me",
      nodes: [node("theirs", "Theirs")],
      noNewFolder: true,
      noMoveOut: true,
    },
  ];
  render(
    <ResourceTree
      sections={sections}
      mode="sidebar"
      showFiles
      enableMove
      enableRename
      onMoveRequest={() => undefined}
      onRenameItem={() => undefined}
      // An admin: may manage every item.
      canManageItem={() => true}
      isFolderExpanded={() => true}
      onToggleFolder={() => undefined}
      onExpandFolder={() => undefined}
    />,
  );
}

describe("ResourceTree — Move to… only where the item is this person's to place", () => {
  it("is offered for an item in My Consoles", () => {
    renderTree();
    fireEvent.contextMenu(screen.getByText("Mine"));
    expect(screen.getByText("Move to...")).toBeTruthy();
  });

  it("is not offered in Shared with me — rename in place stays", () => {
    renderTree();
    fireEvent.contextMenu(screen.getByText("Theirs"));
    expect(screen.queryByText("Move to...")).toBeNull();
    expect(screen.getByText("Rename")).toBeTruthy();
  });
});
