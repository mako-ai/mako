// @vitest-environment jsdom
/**
 * A console tab that failed to load (a dead /c/:id link) says so in its
 * breadcrumb — "Console not found", like its body — not "Unsaved console".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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

vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: { id: "ws", name: "Acme" } }),
}));
vi.mock("../contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));

import EntityBreadcrumbs from "./EntityBreadcrumbs";
import { useConsoleStore } from "../store/consoleStore";

afterEach(() => {
  cleanup();
  useConsoleStore.setState({ tabs: {}, tabOrder: [], activeTabId: null });
});

describe("EntityBreadcrumbs — a console that failed to load", () => {
  it("reads 'Console not found', not 'Unsaved console'", () => {
    const id = useConsoleStore.getState().openTab({
      id: "6ac5395a545a64d5b321f871",
      title: "Console",
      content: "",
      kind: "console",
      metadata: { loadError: { status: 404, message: "Console not found" } },
    });
    render(<EntityBreadcrumbs tabId={id} />);
    expect(screen.getByText("Console not found")).toBeTruthy();
    expect(screen.queryByText("Unsaved console")).toBeNull();
  });

  it("a draft that never loaded from anywhere is still an unsaved console", () => {
    const id = useConsoleStore.getState().openTab({
      id: "6ac5395a545a64d5b321f872",
      title: "Untitled",
      content: "",
      kind: "console",
    });
    render(<EntityBreadcrumbs tabId={id} />);
    expect(screen.getByText("Unsaved console")).toBeTruthy();
  });

  it("a console that has not loaded yet reads 'Loading…', not 'Unsaved console'", () => {
    const id = useConsoleStore.getState().openTab({
      id: "6ac5395a545a64d5b321f873",
      title: "y",
      content: "loading...",
      isSaved: true,
      kind: "console",
    });
    render(<EntityBreadcrumbs tabId={id} />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("Unsaved console")).toBeNull();
  });
});
