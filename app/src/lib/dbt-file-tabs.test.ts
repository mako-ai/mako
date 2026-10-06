// @vitest-environment jsdom
/**
 * A renamed dbt file keeps its tab: same id, new path (so the URL follows),
 * title renamed only when it still matched the file name.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// The console store persists through `localStorage`, which this Node's
// jsdom environment leaves undefined (an own `globalThis.localStorage`
// that jsdom does not override). An in-memory Storage keeps the test about
// tabs, not about the host.
vi.hoisted(() => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
});

import { useConsoleStore } from "../store/consoleStore";
import { retargetDbtFileTabs } from "./dbt-file-tabs";

type AnyTab = Record<string, unknown>;

function seedTab(id: string, tab: AnyTab) {
  useConsoleStore.setState(state => {
    (state.tabs as Record<string, AnyTab>)[id] = tab;
  });
}

beforeEach(() => {
  useConsoleStore.setState(state => {
    state.tabs = {};
  });
});

describe("retargetDbtFileTabs", () => {
  it("moves matching tabs in place and leaves everything else alone", () => {
    seedTab("t1", {
      id: "t1",
      kind: "dbt-file",
      title: "orders.sql",
      metadata: { projectId: "p1", path: "models/orders.sql" },
    });
    seedTab("t2", {
      id: "t2",
      kind: "dbt-file",
      title: "My orders",
      metadata: { projectId: "p1", path: "models/orders.sql" },
    });
    seedTab("t3", {
      id: "t3",
      kind: "dbt-file",
      title: "orders.sql",
      metadata: { projectId: "p2", path: "models/orders.sql" },
    });
    seedTab("t4", {
      id: "t4",
      kind: "console",
      title: "orders.sql",
      metadata: { path: "models/orders.sql" },
    });

    expect(
      retargetDbtFileTabs("p1", "models/orders.sql", "models/fct_orders.sql"),
    ).toBe(2);

    const tabs = useConsoleStore.getState().tabs as unknown as Record<
      string,
      AnyTab
    >;
    expect(tabs.t1.metadata).toEqual({
      projectId: "p1",
      path: "models/fct_orders.sql",
    });
    expect(tabs.t1.title).toBe("fct_orders.sql");
    // A hand-set title is the user's.
    expect(tabs.t2.title).toBe("My orders");
    expect((tabs.t2.metadata as AnyTab).path).toBe("models/fct_orders.sql");
    // Other project, other kind: untouched.
    expect((tabs.t3.metadata as AnyTab).path).toBe("models/orders.sql");
    expect((tabs.t4.metadata as AnyTab).path).toBe("models/orders.sql");
  });

  it("is a no-op for a rename to itself", () => {
    seedTab("t1", {
      id: "t1",
      kind: "dbt-file",
      title: "a.sql",
      metadata: { projectId: "p1", path: "models/a.sql" },
    });
    expect(retargetDbtFileTabs("p1", "models/a.sql", "models/a.sql")).toBe(0);
  });
});
