// @vitest-environment jsdom
/**
 * Duplicate from the explorer: the copy is the copier's (My Consoles, maybe
 * in a folder of theirs) — it used to land unannounced and unopened in a
 * collapsed folder of another section. Now the explorer says where it went,
 * opens it, and reveals it in the tree.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// zustand's `persist` reads `localStorage` at module load (Node 22+ leaves
// the global undefined): give it an in-memory one first.
vi.hoisted(() => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
      clear: () => memory.clear(),
      key: (i: number) => [...memory.keys()][i] ?? null,
      get length() {
        return memory.size;
      },
    },
  });
});

// One object for the whole run: effects depend on its identity.
const workspace = vi.hoisted(() => ({
  currentWorkspace: { id: "ws", name: "Acme" },
}));
vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => workspace,
}));
// The modals are not under test.
vi.mock("./FolderInfoModal", () => ({ default: () => null }));
vi.mock("./ConsoleInfoModal", () => ({ default: () => null }));
// The tree is not under test: one "Duplicate" for the console "Alpha".
vi.mock("./ConsoleTree", async () => {
  const { forwardRef } = await import("react");
  return {
    default: forwardRef(function FakeTree(
      props: { onDuplicate?: (node: object) => void },
      _ref,
    ) {
      return (
        <button
          type="button"
          onClick={() =>
            props.onDuplicate?.({
              id: "c-alpha",
              name: "Alpha",
              path: "finance/Alpha",
              isDirectory: false,
            })
          }
        >
          Duplicate Alpha
        </button>
      );
    }),
  };
});

import ConsoleExplorer from "./ConsoleExplorer";
import { useConsoleTreeStore } from "../store/consoleTreeStore";
import { useConsoleStore } from "../store/consoleStore";
import { useExplorerRevealStore } from "../store/explorerRevealStore";

afterEach(() => cleanup());

describe("ConsoleExplorer — Duplicate", () => {
  it("says where the copy went, opens it and reveals it in the tree", async () => {
    const copy = {
      id: "c-copy",
      name: "Alpha copy",
      path: "Team Drafts/Alpha copy",
    };
    useConsoleTreeStore.setState({
      myItems: {
        ws: [
          {
            id: "f-drafts",
            name: "Team Drafts",
            path: "Team Drafts",
            isDirectory: true,
            children: [{ ...copy, isDirectory: false }],
          },
        ],
      },
      workspaceItems: { ws: [] },
      sharedItems: { ws: [] },
      duplicateConsole: vi.fn(async () => copy),
    });
    useConsoleStore.setState({
      fetchConsoleContent: vi.fn(async () => null),
    } as never);
    const onConsoleSelect = vi.fn();

    render(<ConsoleExplorer onConsoleSelect={onConsoleSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Alpha" }));

    expect(
      await screen.findByText(
        "Copied to My Consoles › Team Drafts as 'Alpha copy'",
      ),
    ).toBeTruthy();
    // Opened: the copy, under its path and id.
    expect(onConsoleSelect).toHaveBeenCalledWith(
      "Team Drafts/Alpha copy",
      "loading...",
      undefined,
      "c-copy",
      true,
      undefined,
      undefined,
    );
    // Revealed in the Consoles explorer.
    expect(useExplorerRevealStore.getState().request).toMatchObject({
      explorer: "consoles",
      nodeId: "c-copy",
    });
  });

  it("a refused copy opens nothing and says nothing more than the refusal", async () => {
    useConsoleTreeStore.setState({
      myItems: { ws: [] },
      workspaceItems: { ws: [] },
      sharedItems: { ws: [] },
      duplicateConsole: vi.fn(async () => null),
    });
    const onConsoleSelect = vi.fn();
    render(<ConsoleExplorer onConsoleSelect={onConsoleSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Alpha" }));
    await Promise.resolve();
    expect(onConsoleSelect).not.toHaveBeenCalled();
    expect(screen.queryByText(/Copied to/)).toBeNull();
  });
});
