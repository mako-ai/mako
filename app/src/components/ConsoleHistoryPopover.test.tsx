// @vitest-environment jsdom
/**
 * "Restore this version" replaces what the open tab shows. With edits not
 * saved yet, the dialog says so — they are replaced, not kept — and the
 * button says it discards them; a clean tab gets the plain "Restore".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import ConsoleHistoryPopover from "./ConsoleHistoryPopover";
import { useConsoleHistoryStore } from "../store/consoleHistoryStore";
import { useConsoleStore } from "../store/consoleStore";
import { computeConsoleStateHash } from "../utils/stateHash";

const ID = "6ac5395a545a64d5b321f871";
const SAVED = "SELECT 1";

function openTab(content: string) {
  useConsoleStore.setState({ tabs: {}, tabOrder: [], activeTabId: null });
  useConsoleStore.getState().openTab({
    id: ID,
    title: "Revenue",
    content,
    isSaved: true,
    filePath: "Revenue",
    savedStateHash: computeConsoleStateHash(SAVED),
    draftRevision: 2,
    version: 2,
    kind: "console",
  });
}

function openRestoreDialog() {
  const anchor = document.createElement("div");
  document.body.appendChild(anchor);
  render(
    <ConsoleHistoryPopover
      anchorEl={anchor}
      onClose={() => undefined}
      workspaceId="ws"
      consoleId={ID}
    />,
  );
  // The older commit (the latest one cannot be restored).
  const menus = document.querySelectorAll<HTMLElement>(".commit-row-menu");
  fireEvent.click(menus[1]);
  fireEvent.click(screen.getByText("Restore this version…"));
}

beforeEach(() => {
  useConsoleHistoryStore.setState({
    historyByConsole: {
      [ID]: [
        { oid: "b".repeat(40), author: "me", timestamp: 2, subject: "edit" },
        { oid: "a".repeat(40), author: "me", timestamp: 1, subject: "create" },
      ],
    },
    pathByConsole: { [ID]: "consoles/Revenue.sql" },
    fetchHistory: vi.fn(async () => undefined),
  });
});

afterEach(() => {
  cleanup();
});

describe("Restore this version — unsaved edits", () => {
  it("says the unsaved edits are replaced, and the button says it discards them", () => {
    openTab("SELECT 1 -- typed, not saved");
    openRestoreDialog();
    expect(screen.getByText(/This console has unsaved edits/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Discard edits and restore" }),
    ).toBeTruthy();
  });

  it("a clean tab gets the plain Restore", () => {
    openTab(SAVED);
    openRestoreDialog();
    expect(screen.queryByText(/unsaved edits/)).toBeNull();
    expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
  });
});
