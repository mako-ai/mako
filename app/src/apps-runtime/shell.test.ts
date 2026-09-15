// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The console store persists through localStorage on every setState, and it
// reads the key at import time. Give it an in-memory one before anything is
// imported, so the test does not depend on which environment this directory
// happens to be matched to.
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const storage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, String(v)),
    removeItem: (k: string) => void memory.delete(k),
    clear: () => memory.clear(),
    key: (i: number) => [...memory.keys()][i] ?? null,
    get length() {
      return memory.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
});

import { useConsoleStore } from "../store/consoleStore";
import { focusAppsTab } from "./shell";

/**
 * A shared app link carries the app's query string, and it has to reach the
 * tab whether that tab is new or already open. focusOrOpenTab only runs the
 * create callback for a new tab, so for everyone who had opened the app
 * before, the tab's stored search won, the address bar was rewritten to it,
 * and the shared view never arrived. Measured on the live shell: a link with
 * `?filters.countries=PL&chart.breakdown=device` opened as "All countries".
 */
describe("focusAppsTab carries a link's query to the tab", () => {
  beforeEach(() => {
    useConsoleStore.setState({
      tabs: {},
      tabOrder: [],
      activeTabId: null,
      loading: {},
      error: {},
    });
    localStorage.clear();
  });

  const searchOf = (id: string) =>
    useConsoleStore.getState().tabs[id]?.metadata?.appSearch;

  it("stores the query on a newly opened tab", () => {
    const id = focusAppsTab(
      "app1",
      "Seller Media",
      "seller-media",
      "?chart.breakdown=device",
    );
    expect(searchOf(id)).toBe("?chart.breakdown=device");
  });

  it("applies a new query to a tab that already exists, without opening a second one", () => {
    const first = focusAppsTab(
      "app1",
      "Seller Media",
      "seller-media",
      "?chart.breakdown=device",
    );
    const again = focusAppsTab(
      "app1",
      "Seller Media",
      "seller-media",
      "?filters.countries=PL&chart.breakdown=device",
    );
    expect(again).toBe(first);
    expect(useConsoleStore.getState().tabOrder).toHaveLength(1);
    expect(searchOf(first)).toBe(
      "?filters.countries=PL&chart.breakdown=device",
    );
  });

  it("a plain link leaves the tab's stored query alone", () => {
    const id = focusAppsTab(
      "app1",
      "Seller Media",
      "seller-media",
      "?chart.breakdown=device",
    );
    focusAppsTab("app1", "Seller Media", "seller-media");
    focusAppsTab("app1", "Seller Media", "seller-media", "");
    expect(searchOf(id)).toBe("?chart.breakdown=device");
  });
});
