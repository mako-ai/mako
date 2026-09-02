// @vitest-environment jsdom
/**
 * fetchAll used to refresh the sidebar and leave persisted editor tabs
 * pointing at source connections that the list no longer contains. Reload
 * then restored the dead tab. Reconcile only after a successful listing —
 * an empty set from a failed request would close every open tab.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getList = vi.hoisted(() => ({
  impl: async (): Promise<{
    data: { success: boolean; data: Array<{ _id: string; name: string }> };
    response: { ok: boolean };
  }> => ({
    data: { success: true, data: [] },
    response: { ok: true },
  }),
}));

vi.mock("../api", () => ({
  api: {
    GET: vi.fn(async () => getList.impl()),
  },
  unwrapBody: (r: { data?: unknown }) => r.data as never,
}));

import { useSourceConnectionEntitiesStore } from "./sourceConnectionEntitiesStore";
import { useConsoleStore } from "./consoleStore";

const WS = "6846e6a01b05af0948070582";

function reset(): void {
  useSourceConnectionEntitiesStore.setState({
    entities: {},
    loading: {},
  });
  useConsoleStore.setState({
    tabs: {},
    tabOrder: [],
    activeTabId: null,
    loading: {},
    error: {},
  });
}

function openSourceTab(sourceId: string): string {
  const tabId = `tab-${sourceId}`;
  useConsoleStore.setState(s => {
    s.tabs[tabId] = {
      id: tabId,
      title: sourceId,
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
  reset();
  getList.impl = async () => ({
    data: { success: true, data: [] },
    response: { ok: true },
  });
});

describe("sourceConnectionEntitiesStore.fetchAll tab reconcile", () => {
  it("closes persisted tabs for source connections the listing no longer has", async () => {
    const dead = openSourceTab("deleted");
    openSourceTab("alive");
    getList.impl = async () => ({
      data: {
        success: true,
        data: [
          {
            _id: "alive",
            name: "Stripe",
            type: "stripe",
            isActive: true,
            config: {},
            settings: {},
            createdAt: "",
            updatedAt: "",
          },
        ],
      },
      response: { ok: true },
    });

    await useSourceConnectionEntitiesStore.getState().fetchAll(WS);

    expect(useConsoleStore.getState().tabs[dead]).toBeUndefined();
    expect(useConsoleStore.getState().tabs["tab-alive"]).toBeDefined();
  });

  it("does not close tabs when the listing fails", async () => {
    const tabId = openSourceTab("still-there");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    getList.impl = async () => {
      throw new Error("network down");
    };

    await useSourceConnectionEntitiesStore.getState().fetchAll(WS);

    expect(useConsoleStore.getState().tabs[tabId]).toBeDefined();
    spy.mockRestore();
  });
});
