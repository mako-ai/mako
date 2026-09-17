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
import { focusAppsTab, healAppsTabs } from "./shell";

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

  it("a different query on an existing tab bumps the seed so the iframe reloads with it; the same query does not", () => {
    const seedOf = (id: string) =>
      useConsoleStore.getState().tabs[id]?.metadata?.appSearchSeed;
    const id = focusAppsTab(
      "app1",
      "Seller Media",
      "seller-media",
      "?chart.breakdown=device",
    );
    expect(seedOf(id)).toBeUndefined();
    focusAppsTab(
      "app1",
      "Seller Media",
      "seller-media",
      "?filters.countries=PL",
    );
    expect(seedOf(id)).toBe(1);
    focusAppsTab(
      "app1",
      "Seller Media",
      "seller-media",
      "?filters.countries=PL",
    );
    expect(seedOf(id)).toBe(1);
    focusAppsTab("app1", "Seller Media", "seller-media");
    expect(seedOf(id)).toBe(1);
    focusAppsTab(
      "app1",
      "Seller Media",
      "seller-media",
      "?filters.countries=PT",
    );
    expect(seedOf(id)).toBe(2);
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

/**
 * A move changes what an app's link should say (slug for a top-level app, id
 * for a nested one). The app tab heals itself while mounted; file and diff
 * tabs never re-read their handle, so a file opened before a move produced
 * `/apps/<old-slug>/file/…` — a link that no longer resolves.
 */
describe("healAppsTabs keeps every Apps tab's URL handle current", () => {
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

  const slugOf = (id: string) =>
    useConsoleStore.getState().tabs[id]?.metadata?.appSlug;

  it("rewrites app, app-file and app-diff tabs of a moved app and leaves others alone", () => {
    // Seeded directly: opening tabs through the shell would preview-replace
    // one another (at most one preview tab at a time), and the point is
    // three tabs healed in one pass.
    const tab = (
      id: string,
      kind: "app" | "app-file" | "app-diff",
      metadata: Record<string, unknown>,
    ) => ({ id, title: id, content: "", isSaved: true, kind, metadata });
    useConsoleStore.setState({
      tabs: {
        app: tab("app", "app", { appId: "app1", appSlug: "report" }),
        file: tab("file", "app-file", {
          appId: "app1",
          appSlug: "report",
          path: "src/App.tsx",
        }),
        diff: tab("diff", "app-diff", {
          appId: "app1",
          appSlug: "report",
          path: "src/App.tsx",
          mode: "working",
        }),
        other: tab("other", "app-file", {
          appId: "app2",
          appSlug: "other",
          path: "index.html",
        }),
      } as never,
      tabOrder: ["app", "file", "diff", "other"],
    });
    // app1 moved into a folder: nested, so it is addressed by id now.
    healAppsTabs(new Map([["app1", undefined]]));
    expect(slugOf("app")).toBeUndefined();
    expect(slugOf("file")).toBeUndefined();
    expect(slugOf("diff")).toBeUndefined();
    expect(slugOf("other")).toBe("other");
    // Back to the top level: the slug returns.
    healAppsTabs(new Map([["app1", "report"]]));
    expect(slugOf("app")).toBe("report");
    expect(slugOf("file")).toBe("report");
    expect(slugOf("diff")).toBe("report");
  });
});
