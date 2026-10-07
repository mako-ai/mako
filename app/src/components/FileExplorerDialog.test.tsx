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

describe("FileExplorerDialog — the name as it will be saved", () => {
  it("says inline what 'Q1: revenue' will be saved as, and saves that name", () => {
    const onSave = vi.fn();
    render(
      <FileExplorerDialog
        open
        onClose={() => undefined}
        mode="save"
        defaultName=""
        onSave={onSave}
      />,
    );
    fireEvent.change(nameField(), { target: { value: "A/B test: Q1?" } });
    expect(screen.getByText("Will be saved as “A-B test - Q1”.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith("A-B test - Q1", null, "my");
  });

  it("a name no file can be is refused inline, with the reason, and never sent", () => {
    const onSave = vi.fn();
    render(
      <FileExplorerDialog
        open
        onClose={() => undefined}
        mode="save"
        defaultName=""
        onSave={onSave}
      />,
    );
    for (const [typed, reason] of [
      ["CON", /reserved/],
      ["..", /dot/],
      ["???", /name/],
      ["x".repeat(130), /120/],
    ] as const) {
      fireEvent.change(nameField(), { target: { value: typed } });
      expect(screen.getByText(reason)).toBeTruthy();
      const save = screen.getByRole("button", { name: "Save" });
      expect((save as HTMLButtonElement).disabled).toBe(true);
    }
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Rename / Move sends the cleaned name", () => {
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
    fireEvent.change(nameField(), { target: { value: "Ghost: 4" } });
    fireEvent.click(screen.getByRole("button", { name: "Move Here" }));
    expect(onMove).toHaveBeenCalledWith(null, "Ghost - 4", "my");
  });
});
