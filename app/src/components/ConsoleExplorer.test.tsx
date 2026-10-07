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
// The tree is not under test: "Duplicate" and "Open" for the console
// "Alpha".
vi.mock("./ConsoleTree", async () => {
  const { forwardRef } = await import("react");
  const alpha = {
    id: "c-alpha",
    name: "Alpha",
    path: "finance/Alpha",
    isDirectory: false,
  };
  return {
    default: forwardRef(function FakeTree(
      props: {
        onDuplicate?: (node: object) => void;
        onFileOpen?: (node: object) => void;
        onMoveRequest?: (node: object) => void;
        onSoftDelete?: (node: object) => void;
        onDeleteRequest?: (node: object) => void;
        onUndo?: () => void;
      },
      _ref,
    ) {
      return (
        <>
          <button type="button" onClick={() => props.onDuplicate?.(alpha)}>
            Duplicate Alpha
          </button>
          <button type="button" onClick={() => props.onFileOpen?.(alpha)}>
            Open Alpha
          </button>
          <button type="button" onClick={() => props.onMoveRequest?.(alpha)}>
            Move Alpha
          </button>
          <button type="button" onClick={() => props.onSoftDelete?.(alpha)}>
            Delete Alpha
          </button>
          <button type="button" onClick={() => props.onUndo?.()}>
            Ctrl+Z
          </button>
          <button
            type="button"
            onClick={() =>
              props.onDeleteRequest?.({
                id: "f-fin",
                name: "finance",
                path: "finance",
                isDirectory: true,
              })
            }
          >
            Delete folder finance
          </button>
        </>
      );
    }),
  };
});
// The picker is not under test: "Move Here" picks Workspace › finance.
vi.mock("./FileExplorerDialog", () => ({
  default: (props: {
    open: boolean;
    onMove?: (
      folderId: string | null,
      name?: string,
      section?: "my" | "workspace",
    ) => void;
  }) =>
    props.open ? (
      <button
        type="button"
        onClick={() => props.onMove?.("f-fin", undefined, "workspace")}
      >
        Move Here
      </button>
    ) : null,
}));

import ConsoleExplorer from "./ConsoleExplorer";
import { useConsoleTreeStore } from "../store/consoleTreeStore";
import { useConsoleStore } from "../store/consoleStore";
import { useExplorerRevealStore } from "../store/explorerRevealStore";
import { useConsoleContentStore } from "../store/consoleContentStore";
import { computeConsoleStateHash } from "../utils/stateHash";

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

describe("ConsoleExplorer — opening a console that is already open", () => {
  const SAVED = "SELECT 1";
  const EDIT = "SELECT 1 -- typed, not saved";

  function openAlpha(content: string) {
    useConsoleStore.setState({ tabs: {}, tabOrder: [], activeTabId: null });
    useConsoleStore.getState().openTab({
      id: "c-alpha",
      title: "Alpha",
      content,
      isSaved: true,
      filePath: "finance/Alpha",
      savedStateHash: computeConsoleStateHash(SAVED),
      draftRevision: 2,
      version: 2,
      kind: "console",
    });
    useConsoleStore.getState().openTab(
      {
        id: "c-other",
        title: "Other",
        content: "SELECT 2",
        isSaved: true,
        filePath: "Other",
        kind: "console",
      },
      { replacePristine: false },
    );
    useConsoleStore.getState().setActiveTab("c-other");
    // The explorer's cache holds the server copy.
    useConsoleContentStore.getState().set("c-alpha", { content: SAVED });
  }

  it("with unsaved edits: only focused — never refetched over the edit, never marked saved", async () => {
    openAlpha(EDIT);
    const fetchConsoleContent = vi.fn(async () => ({
      content: SAVED,
      savedStateHash: computeConsoleStateHash(SAVED),
    }));
    useConsoleStore.setState({ fetchConsoleContent } as never);
    const onConsoleSelect = vi.fn();
    render(<ConsoleExplorer onConsoleSelect={onConsoleSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
    await new Promise(resolve => setTimeout(resolve, 20));

    const state = useConsoleStore.getState();
    expect(state.tabs["c-alpha"].content).toBe(EDIT);
    expect(fetchConsoleContent).not.toHaveBeenCalled();
    expect(onConsoleSelect).not.toHaveBeenCalled();
    expect(state.activeTabId).toBe("c-alpha");
    // Still dirty: Save still has something to save.
    expect(state.tabs["c-alpha"].savedStateHash).toBe(
      computeConsoleStateHash(SAVED),
    );
  });

  it("clean: opened and refreshed from the server as before", async () => {
    openAlpha(SAVED);
    const fetchConsoleContent = vi.fn(async () => null);
    useConsoleStore.setState({ fetchConsoleContent } as never);
    const onConsoleSelect = vi.fn();
    render(<ConsoleExplorer onConsoleSelect={onConsoleSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
    await vi.waitFor(() => expect(fetchConsoleContent).toHaveBeenCalled());
    expect(onConsoleSelect).toHaveBeenCalled();
  });
});

describe("ConsoleExplorer — Move to…", () => {
  function seed(moveItem: () => Promise<boolean>) {
    useConsoleTreeStore.setState({
      myItems: {
        ws: [
          { id: "c-alpha", name: "Alpha", path: "Alpha", isDirectory: false },
        ],
      },
      workspaceItems: {
        ws: [
          {
            id: "f-fin",
            name: "finance",
            path: "finance",
            isDirectory: true,
            children: [],
          },
        ],
      },
      sharedItems: { ws: [] },
      actionError: {},
      moveItem,
    } as never);
  }

  it("says where the console went", async () => {
    const moveItem = vi.fn(async () => true);
    seed(moveItem);
    render(<ConsoleExplorer onConsoleSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Here" }));
    expect(
      await screen.findByText("Moved to Workspace › finance"),
    ).toBeTruthy();
    expect(moveItem).toHaveBeenCalledWith(
      "ws",
      "c-alpha",
      "f-fin",
      "workspace",
      undefined,
    );
  });

  it("names the destination as the tree shows it NOW — not a folder's stale path after an inline rename", async () => {
    const moveItem = vi.fn(async () => true);
    seed(moveItem);
    // "finance" renamed inline to "Fold2": its stored path still says the
    // old name.
    useConsoleTreeStore.setState(state => ({
      workspaceItems: {
        ws: [{ ...state.workspaceItems.ws[0], name: "Fold2", path: "finance" }],
      },
    }));
    render(<ConsoleExplorer onConsoleSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Here" }));
    expect(await screen.findByText("Moved to Workspace › Fold2")).toBeTruthy();
  });

  it("an inline rename the server saved under another name says so", async () => {
    seed(vi.fn(async () => true));
    useConsoleTreeStore.setState({ actionNotice: {} } as never);
    render(<ConsoleExplorer onConsoleSelect={vi.fn()} />);
    useConsoleTreeStore.setState({
      actionNotice: { ws: "Saved as “a-b”" },
    } as never);
    expect(await screen.findByText("Saved as “a-b”")).toBeTruthy();
    expect(useConsoleTreeStore.getState().actionNotice.ws).toBeNull();
  });

  it("a refused move says only why (the store's actionError)", async () => {
    seed(vi.fn(async () => false));
    render(<ConsoleExplorer onConsoleSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Here" }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByText(/Moved to/)).toBeNull();
  });
});

describe("ConsoleExplorer — a tab whose first load failed, and typing during a load", () => {
  const SAVED = "SELECT 1";

  it("a placeholder tab (first fetch failed) is fetched again on the next click", async () => {
    useConsoleStore.setState({ tabs: {}, tabOrder: [], activeTabId: null });
    // What the explorer opens with nothing cached; its fetch then failed.
    useConsoleStore.getState().openTab({
      id: "c-alpha",
      title: "Alpha",
      content: "loading...",
      isSaved: true,
      kind: "console",
    });
    useConsoleContentStore.getState().clear();
    const fetchConsoleContent = vi.fn(async () => null);
    useConsoleStore.setState({ fetchConsoleContent } as never);
    const onConsoleSelect = vi.fn();
    render(<ConsoleExplorer onConsoleSelect={onConsoleSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
    await vi.waitFor(() => expect(fetchConsoleContent).toHaveBeenCalled());
    expect(onConsoleSelect).toHaveBeenCalled();
  });

  it("an edit typed while an open clean tab is being refreshed is not overwritten", async () => {
    useConsoleStore.setState({ tabs: {}, tabOrder: [], activeTabId: null });
    useConsoleStore.getState().openTab({
      id: "c-alpha",
      title: "Alpha",
      content: SAVED,
      isSaved: true,
      filePath: "finance/Alpha",
      savedStateHash: computeConsoleStateHash(SAVED),
      kind: "console",
    });
    useConsoleContentStore.getState().set("c-alpha", { content: SAVED });
    // The fetch is in flight while the user types (the store keeps the
    // edit and answers the server's copy).
    const fetchConsoleContent = vi.fn(async () => {
      useConsoleStore.getState().updateContent("c-alpha", "SELECT 1 -- mine");
      return {
        success: true,
        content: "SELECT 1 -- server",
        savedStateHash: computeConsoleStateHash("SELECT 1 -- server"),
      };
    });
    useConsoleStore.setState({ fetchConsoleContent } as never);
    render(<ConsoleExplorer onConsoleSelect={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Open Alpha" }));
    await vi.waitFor(() => expect(fetchConsoleContent).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 20));

    const tab = useConsoleStore.getState().tabs["c-alpha"];
    expect(tab.content).toBe("SELECT 1 -- mine");
    expect(tab.savedStateHash).toBe(computeConsoleStateHash(SAVED));
  });
});

describe("ConsoleExplorer — undoing a delete (Cmd+Z)", () => {
  it("says it is back, under the name it came back as", async () => {
    useConsoleTreeStore.setState({
      myItems: { ws: [] },
      workspaceItems: { ws: [] },
      sharedItems: { ws: [] },
      actionError: {},
      deleteItem: vi.fn(async () => true),
      restoreConsole: vi.fn(async () => ({ name: "Alpha (2)" })),
    } as never);
    render(<ConsoleExplorer onConsoleSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
    await new Promise(resolve => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole("button", { name: "Ctrl+Z" }));
    expect(await screen.findByText("Restored as 'Alpha (2)'")).toBeTruthy();
  });
});

describe("ConsoleExplorer — every delete says 'Moved to trash' and offers Undo", () => {
  it("a console (no dialog): the toast, then its Undo restores it in place", async () => {
    const restoreConsole = vi.fn(async () => ({ name: "Alpha" }));
    useConsoleTreeStore.setState({
      myItems: { ws: [] },
      workspaceItems: { ws: [] },
      sharedItems: { ws: [] },
      actionError: {},
      deleteItem: vi.fn(async () => true),
      restoreConsole,
    } as never);
    render(<ConsoleExplorer onConsoleSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
    expect(await screen.findByText("Moved “Alpha” to trash")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 'Alpha'")).toBeTruthy();
    expect(restoreConsole).toHaveBeenCalledWith("ws", "c-alpha");
  });

  it("a folder: the confirm promises only an undo; the toast's Undo recreates the folder with its consoles", async () => {
    const deleteItem = vi.fn(async () => true);
    const restoreFolder = vi.fn(async () => ({
      restored: 1,
      failed: 0,
      atRoot: 0,
      folderRecreated: true,
    }));
    const finance = {
      id: "f-fin",
      name: "finance",
      path: "finance",
      isDirectory: true,
      children: [
        { id: "c-q1", name: "Q1", path: "finance/Q1", isDirectory: false },
      ],
    };
    useConsoleTreeStore.setState({
      myItems: { ws: [] },
      workspaceItems: { ws: [finance] },
      sharedItems: { ws: [] },
      actionError: {},
      deleteItem,
      restoreFolder,
    } as never);
    render(<ConsoleExplorer onConsoleSelect={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete folder finance" }),
    );
    const body = await screen.findByText(/Delete the folder “finance”/);
    expect(body.textContent).toMatch(/undo this right after/);
    expect(body.textContent).not.toMatch(/permanent|restored/i);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(
      await screen.findByText(
        "Deleted folder “finance” — 1 console moved to trash",
      ),
    ).toBeTruthy();
    expect(deleteItem).toHaveBeenCalledWith("ws", "f-fin", true);
    // (Once the confirm's closing transition has let go of the page.)
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(
      await screen.findByText("Restored folder “finance” and 1 console"),
    ).toBeTruthy();
    expect(restoreFolder).toHaveBeenCalledWith(
      "ws",
      expect.objectContaining({
        id: "f-fin",
        name: "finance",
        children: [expect.objectContaining({ id: "c-q1" })],
      }),
      { parentId: null, section: "workspace" },
    );
  });

  it("a folder that could not be recreated: its consoles come back to the root, and the toast says so", async () => {
    useConsoleTreeStore.setState({
      myItems: { ws: [] },
      workspaceItems: {
        ws: [
          {
            id: "f-fin",
            name: "finance",
            path: "finance",
            isDirectory: true,
            children: [
              {
                id: "c-q1",
                name: "Q1",
                path: "finance/Q1",
                isDirectory: false,
              },
              {
                id: "c-q2",
                name: "Q2",
                path: "finance/Q2",
                isDirectory: false,
              },
            ],
          },
        ],
      },
      sharedItems: { ws: [] },
      actionError: {},
      deleteItem: vi.fn(async () => true),
      restoreFolder: vi.fn(async () => ({
        restored: 2,
        failed: 0,
        atRoot: 2,
        folderRecreated: false,
      })),
    } as never);
    render(<ConsoleExplorer onConsoleSelect={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Delete folder finance" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(
      await screen.findByText(
        "The folder “finance” could not be recreated — 2 consoles restored to the root of Workspace",
      ),
    ).toBeTruthy();
  });
});
