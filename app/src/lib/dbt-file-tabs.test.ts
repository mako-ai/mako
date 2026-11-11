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
  });
});

describe("retargetDbtFileTabs", () => {
  it("moves the tabs on that file in place and leaves every other tab alone", () => {
    open("t1", "models/orders.sql");
    open("t2", "models/orders.sql", { title: "My orders" });
    open("t3", "models/customers.sql");
    open("t4", "models/orders.sql", {
      metadata: { projectId: "p2", path: "models/orders.sql" },
    });
    expect(
      retargetDbtFileTabs("p1", "models/orders.sql", "models/marts/fct.sql"),
    ).toBe(2);
    expect(tab("t1")).toMatchObject({
      title: "fct.sql",
      metadata: { projectId: "p1", path: "models/marts/fct.sql" },
    });
    // A title set by hand stays; the address bar follows the path.
    expect(tab("t2").title).toBe("My orders");
    expect(tabUrlPath("t1", tab("t1"))).toBe("/x/p1/file/models/marts/fct.sql");
    expect(tab("t3").metadata?.path).toBe("models/customers.sql");
    expect(tab("t4").metadata?.path).toBe("models/orders.sql");
    expect(retargetDbtFileTabs("p1", "models/a.sql", "models/a.sql")).toBe(0);
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
