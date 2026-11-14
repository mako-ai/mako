import { describe, expect, it, vi } from "vitest";
import {
  closeTabsOf,
  consoleLocationsInTree,
  retargetConsoleTabs,
  type TreeConsoleNode,
} from "./console-tab-location";

const file = (id: string, name: string): TreeConsoleNode => ({
  id,
  name,
  isDirectory: false,
});
const folder = (
  id: string,
  name: string,
  children: TreeConsoleNode[],
): TreeConsoleNode => ({ id, name, isDirectory: true, children });

describe("where the tree says a console is", () => {
  it("builds the path from the names on the way down, and the section it is shown in", () => {
    const locations = consoleLocationsInTree(
      [file("a", "Alpha one"), folder("f", "Team", [file("b", "report")])],
      [folder("g", "Shared", [folder("h", "Q1", [file("c", "plan")])])],
    );
    expect(Object.fromEntries(locations)).toEqual({
      a: { title: "Alpha one", filePath: "Alpha one", access: "private" },
      b: { title: "report", filePath: "Team/report", access: "private" },
      c: { title: "plan", filePath: "Shared/Q1/plan", access: "workspace" },
    });
  });
});

describe("open tabs follow the tree", () => {
  const actions = () => ({
    updateTitle: vi.fn(),
    updateFilePath: vi.fn(),
    updateAccess: vi.fn(),
  });

  it("retargets a renamed console's tab: title and path, nothing else", () => {
    const tabs = {
      // Renamed in the tree from "Alpha" to "Alpha one": the stale path
      // must not keep the old name as if it were a folder.
      a: {
        id: "a",
        kind: "console",
        title: "Alpha",
        filePath: "Alpha",
        access: "private" as const,
        isSaved: true,
      },
      b: {
        id: "b",
        kind: "console",
        title: "report",
        filePath: "Team/report",
        access: "private" as const,
        isSaved: true,
      },
    };
    const api = actions();
    const changed = retargetConsoleTabs(
      tabs,
      consoleLocationsInTree(
        [file("a", "Alpha one"), folder("f", "Team", [file("b", "report")])],
        [],
      ),
      api,
    );
    expect(changed).toEqual(["a"]);
    expect(api.updateTitle).toHaveBeenCalledWith("a", "Alpha one");
    expect(api.updateFilePath).toHaveBeenCalledWith("a", "Alpha one");
    expect(api.updateAccess).toHaveBeenCalledWith("a", "private");
    expect(api.updateTitle).toHaveBeenCalledTimes(1);
  });

  it("leaves alone a draft, a tab of another kind, and a console the tree does not list", () => {
    const api = actions();
    const changed = retargetConsoleTabs(
      {
        draft: { id: "draft", kind: "console", title: "x", isSaved: false },
        nb: { id: "a", kind: "notebook", title: "x", isSaved: true },
        gone: { id: "gone", kind: "console", title: "x", isSaved: true },
      },
      consoleLocationsInTree([file("draft", "named"), file("a", "named")], []),
      api,
    );
    expect(changed).toEqual([]);
    expect(api.updateTitle).not.toHaveBeenCalled();
  });
});

describe("closing the tabs of something deleted", () => {
  it("closes the console's tab, or the notebook's, and no other", () => {
    const store = {
      tabs: {
        a: { id: "a", kind: "console" },
        legacy: { id: "legacy" },
        t1: { id: "t1", kind: "notebook", metadata: { notebookId: "n1" } },
        t2: { id: "t2", kind: "notebook", metadata: { notebookId: "n2" } },
      },
      closeTab: vi.fn(),
    };
    expect(closeTabsOf(store, { consoleId: "a" })).toEqual(["a"]);
    expect(closeTabsOf(store, { consoleId: "legacy" })).toEqual(["legacy"]);
    expect(closeTabsOf(store, { notebookId: "n1" })).toEqual(["t1"]);
    expect(closeTabsOf(store, { consoleId: "t2" })).toEqual([]);
    expect(store.closeTab.mock.calls.map(call => call[0])).toEqual([
      "a",
      "legacy",
      "t1",
    ]);
  });
});
