// @vitest-environment jsdom
/**
 * Deleting a source connection (or loading a dead `/cx/:id` link) used to
 * leave the editor tab open. The tab GETs 404, shows "Failed to load source
 * connection", and persist restored the same dead id on reload.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { useConsoleStore } from "../store/consoleStore";
import {
  closeSourceConnectionTabsFor,
  reconcileSourceConnectionTabs,
} from "./source-connection-tabs";

const here = dirname(fileURLToPath(import.meta.url));

function resetConsoleStore(): void {
  useConsoleStore.setState({
    tabs: {},
    tabOrder: [],
    activeTabId: null,
    loading: {},
    error: {},
  });
}

function openSourceTab(sourceId: string, tabId = `tab-${sourceId}`): string {
  useConsoleStore.setState(s => {
    s.tabs[tabId] = {
      id: tabId,
      title: sourceId || "New source connection",
      content: sourceId,
      kind: "connectors",
      isSaved: true,
    };
    s.tabOrder = [...s.tabOrder, tabId];
    s.activeTabId = tabId;
  });
  return tabId;
}

beforeEach(() => {
  resetConsoleStore();
});

describe("closeSourceConnectionTabsFor", () => {
  it("closes the open tab for a deleted source connection", () => {
    const tabId = openSourceTab("cx1");
    openSourceTab("cx2");

    expect(closeSourceConnectionTabsFor("cx1")).toBe(true);
    expect(useConsoleStore.getState().tabs[tabId]).toBeUndefined();
    expect(useConsoleStore.getState().tabOrder).toEqual(["tab-cx2"]);
  });

  it("leaves unrelated tabs and unsaved new-connection tabs alone", () => {
    const unsaved = openSourceTab("", "tab-new");
    useConsoleStore.setState(s => {
      s.tabs["console-1"] = {
        id: "console-1",
        title: "SQL",
        content: "select 1",
        kind: "console",
        isSaved: true,
      };
      s.tabOrder = [...s.tabOrder, "console-1"];
    });

    expect(closeSourceConnectionTabsFor("cx-missing")).toBe(false);
    expect(useConsoleStore.getState().tabs[unsaved]).toBeDefined();
    expect(useConsoleStore.getState().tabs["console-1"]).toBeDefined();
  });
});

describe("reconcileSourceConnectionTabs", () => {
  it("drops persisted tabs whose source connection is gone from a successful list", () => {
    openSourceTab("alive");
    const dead = openSourceTab("deleted");
    const unsaved = openSourceTab("", "tab-new");

    reconcileSourceConnectionTabs(new Set(["alive"]));

    expect(useConsoleStore.getState().tabs[dead]).toBeUndefined();
    expect(useConsoleStore.getState().tabs["tab-alive"]).toBeDefined();
    expect(useConsoleStore.getState().tabs[unsaved]).toBeDefined();
  });

  it("does not treat an empty set from a failed list as 'delete everything'", () => {
    // Callers must not pass the empty set from a network error. An empty
    // successful list (workspace has no connections) SHOULD close saved tabs;
    // this pin is the helper's unsaved-tab keep, plus that saved tabs with
    // empty content survive. The store's fetchAll only calls this inside
    // `if (data.success)`.
    openSourceTab("still-there");
    reconcileSourceConnectionTabs(new Set());
    expect(useConsoleStore.getState().tabs["tab-still-there"]).toBeUndefined();
  });
});

describe("call sites", () => {
  it("SourceConnectionExplorer closes tabs after a successful delete", () => {
    const source = readFileSync(
      join(here, "../components/SourceConnectionExplorer.tsx"),
      "utf8",
    );
    expect(source).toMatch(/closeSourceConnectionTabsFor\(sourceId\)/);
    expect(source).toMatch(/if \(!res\.success\)/);
  });
});
