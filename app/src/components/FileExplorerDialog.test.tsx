// @vitest-environment jsdom
/**
 * The Rename / Move picker: a click on another console in the tree picks
 * nothing for the name — it used to replace the typed name with that
 * console's (a misclick renamed "Ghost3" to "orders.sql"). The save dialog
 * still offers a clicked console's name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: { id: "ws" } }),
}));
vi.mock("../store/consoleTreeStore", () => ({
  useConsoleTreeStore: (
    selector: (s: { myItems: object; workspaceItems: object }) => unknown,
  ) => selector({ myItems: {}, workspaceItems: {} }),
}));
// The tree itself is not under test: one console to click.
vi.mock("./ConsoleTree", async () => {
  const { forwardRef } = await import("react");
  return {
    default: forwardRef(function FakeTree(
      props: { onFileClick?: (node: object) => void },
      _ref,
    ) {
      return (
        <button
          type="button"
          onClick={() =>
            props.onFileClick?.({
              id: "c-orders",
              name: "orders.sql",
              path: "orders.sql",
              isDirectory: false,
            })
          }
        >
          orders.sql
        </button>
      );
    }),
  };
});

import FileExplorerDialog from "./FileExplorerDialog";

afterEach(() => cleanup());

const nameField = () => screen.getByRole("textbox") as HTMLInputElement;

describe("FileExplorerDialog — a click in the tree", () => {
  it("Rename / Move: clicking another console keeps the typed name", () => {
    const onMove = vi.fn();
    render(
      <FileExplorerDialog
        open
        onClose={() => undefined}
        mode="move"
        itemName="Ghost3"
        onMove={onMove}
      />,
    );
    fireEvent.change(nameField(), { target: { value: "Ghost4" } });
    fireEvent.click(screen.getByRole("button", { name: "orders.sql" }));
    expect(nameField().value).toBe("Ghost4");
    fireEvent.click(screen.getByRole("button", { name: "Move Here" }));
    expect(onMove).toHaveBeenCalledWith(null, "Ghost4", "my");
  });

  it("Save: clicking a console still offers its name", () => {
    render(
      <FileExplorerDialog
        open
        onClose={() => undefined}
        mode="save"
        defaultName="Untitled"
        onSave={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "orders.sql" }));
    expect(nameField().value).toBe("orders.sql");
  });
});
