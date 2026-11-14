// @vitest-environment jsdom
/**
 * A renamed dbt file keeps its tab: same id, new path (so the URL
 * follows), the title renamed only while it was the file's name. An old
 * link opened cold follows the file to where the server says it is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The console store persists through `localStorage`, which this Node's
// jsdom leaves undefined. An in-memory one keeps the test about tabs.
vi.hoisted(() => {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
});
const links = vi.hoisted(() => ({ resolveObjectRef: vi.fn() }));
vi.mock("./object-links", () => links);

import { useConsoleStore } from "../store/consoleStore";
import { tabUrlPath } from "./tab-routing";
import { followMovedDbtFile, retargetDbtFileTabs } from "./dbt-file-tabs";

type Tab = ReturnType<typeof useConsoleStore.getState>["tabs"][string];
const tab = (id: string) => useConsoleStore.getState().tabs[id];
function open(id: string, path: string, extra: Partial<Tab> = {}) {
  useConsoleStore.setState(state => {
    state.tabOrder.push(id);
    state.tabs[id] = {
      id,
      kind: "dbt-file",
      title: path.slice(path.lastIndexOf("/") + 1),
      content: "",
      metadata: { projectId: "p1", path },
      ...extra,
    } as Tab;
  });
}

beforeEach(() => {
  links.resolveObjectRef.mockReset();
  useConsoleStore.setState(state => {
    state.tabs = {};
    state.tabOrder = [];
    state.activeTabId = null;
  });
});
const openPaths = () =>
  useConsoleStore
    .getState()
    .tabOrder.map(id => `${id}:${String(tab(id).metadata?.path)}`);

describe("retargetDbtFileTabs", () => {
  it("moves the tabs on that file in place and leaves every other tab alone", () => {
    open("t1", "models/orders.sql");
    open("t2", "models/orders.sql", { title: "My orders" });
    open("t3", "models/customers.sql");
    open("t4", "models/orders.sql", {
      metadata: { projectId: "p2", path: "models/orders.sql" },
    });
    useConsoleStore.getState().setActiveTab("t2");
    expect(
      retargetDbtFileTabs("p1", "models/orders.sql", "models/marts/fct.sql"),
    ).toBe(2);
    // One tab for the file: the first moves, its twin closes, and the focus
    // the twin had goes to the tab that stays. Other tabs are untouched.
    expect(openPaths()).toEqual([
      "t1:models/marts/fct.sql",
      "t3:models/customers.sql",
      "t4:models/orders.sql",
    ]);
    expect(useConsoleStore.getState().activeTabId).toBe("t1");
    expect(tab("t1").title).toBe("fct.sql");
    expect(tabUrlPath("t1", tab("t1"))).toBe("/x/p1/file/models/marts/fct.sql");
    expect(tab("t4").metadata?.projectId).toBe("p2");
    expect(retargetDbtFileTabs("p1", "models/a.sql", "models/a.sql")).toBe(0);
    expect(retargetDbtFileTabs("p1", "models/none.sql", "models/x.sql")).toBe(
      0,
    );
  });

  it("a title set by hand stays when the tab moves", () => {
    open("t1", "models/orders.sql", { title: "My orders" });
    retargetDbtFileTabs("p1", "models/orders.sql", "models/fct.sql");
    expect(tab("t1")).toMatchObject({
      title: "My orders",
      metadata: { path: "models/fct.sql" },
    });
  });

  it("focuses the tab already open on the new path instead of making a second one", () => {
    // What repeated visits of one old link used to leave: the tab from the
    // first visit (restored on reload), and a new tab on the old path.
    open("kept", "models/orders_v2.sql");
    open("other", "models/customers.sql");
    for (const visit of ["v2", "v3"]) {
      open(visit, "models/orders.sql");
      useConsoleStore.getState().setActiveTab(visit);
      retargetDbtFileTabs("p1", "models/orders.sql", "models/orders_v2.sql");
      expect(openPaths()).toEqual([
        "kept:models/orders_v2.sql",
        "other:models/customers.sql",
      ]);
      expect(useConsoleStore.getState().activeTabId).toBe("kept");
    }
    // A background tab on the old path closes without taking the focus.
    open("stale", "models/orders.sql");
    useConsoleStore.getState().setActiveTab("other");
    retargetDbtFileTabs("p1", "models/orders.sql", "models/orders_v2.sql");
    expect(openPaths()).toHaveLength(2);
    expect(useConsoleStore.getState().activeTabId).toBe("other");
  });
});

describe("followMovedDbtFile", () => {
  it("points the tab of an old link at where the file is now", async () => {
    open("t1", "models/orders.sql");
    links.resolveObjectRef.mockResolvedValue({
      via: "alias",
      current: { slug: "models/fct_orders.sql" },
    });
    expect(await followMovedDbtFile("ws", "p1", "models/orders.sql")).toBe(
      "models/fct_orders.sql",
    );
    expect(links.resolveObjectRef).toHaveBeenCalledWith(
      "ws",
      "dbt_file",
      "p1/models/orders.sql",
    );
    expect(tab("t1").metadata?.path).toBe("models/fct_orders.sql");
    // Asked twice at once (the link and the editor): one request, and both
    // callers learn where the file went.
    links.resolveObjectRef.mockClear();
    open("t2", "models/orders.sql");
    const both = await Promise.all([
      followMovedDbtFile("ws", "p1", "models/orders.sql"),
      followMovedDbtFile("ws", "p1", "models/orders.sql"),
    ]);
    expect(both).toEqual(["models/fct_orders.sql", "models/fct_orders.sql"]);
    expect(links.resolveObjectRef).toHaveBeenCalledTimes(1);
    expect(openPaths()).toEqual(["t1:models/fct_orders.sql"]);
  });

  it("leaves the tab alone for a current link, a dead one, and a server that cannot say", async () => {
    open("t1", "models/orders.sql");
    for (const answer of [
      () => Promise.resolve({ via: "current", current: { slug: "x.sql" } }),
      () => Promise.resolve(null),
      () => Promise.reject(new Error("503")),
    ]) {
      links.resolveObjectRef.mockImplementation(answer);
      expect(
        await followMovedDbtFile("ws", "p1", "models/orders.sql"),
      ).toBeNull();
      expect(tab("t1").metadata?.path).toBe("models/orders.sql");
    }
  });
});
