// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Both stores persist through `localStorage`, which this Node's jsdom leaves
// undefined; an in-memory one lets the persist path run for real.
const storage = vi.hoisted(() => {
  const data = new Map<string, string>();
  const memory = {
    data,
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
    value: memory,
    configurable: true,
    writable: true,
  });
  return memory;
});

const http = vi.hoisted(() => ({
  GET: vi.fn(),
  PATCH: vi.fn(),
  POST: vi.fn(),
  PUT: vi.fn(),
  DELETE: vi.fn(),
}));

vi.mock("../api", async importOriginal => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: http };
});

import { useFlowStore } from "./flowStore";
import { useConsoleStore } from "./consoleStore";

const WID = "ws-1";

function listedFlow(id: string, name: string) {
  return {
    _id: id,
    workspaceId: WID,
    name,
    slug: name.toLowerCase(),
    type: "scheduled" as const,
    syncMode: "incremental" as const,
    runCount: 0,
    createdBy: "u1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** What openapi-fetch resolves for a 200 with a JSON body. */
const ok = (body: unknown) => ({
  data: body,
  error: undefined,
  response: { ok: true, status: 200 },
});

beforeEach(() => {
  vi.clearAllMocks();
  useFlowStore.setState({
    flows: {},
    loading: {},
    error: {},
    selectedFlowId: null,
    executionHistory: {},
  });
});

describe("flowStore fetchFlows", () => {
  it("stores the listed flows", async () => {
    http.GET.mockResolvedValueOnce(
      ok({
        success: true,
        data: [listedFlow("f1", "Orders")],
      }),
    );

    const listed = await useFlowStore.getState().fetchFlows(WID);

    expect(listed).toHaveLength(1);
    expect(useFlowStore.getState().flows[WID]?.[0]?.name).toBe("Orders");
    expect(useFlowStore.getState().error[WID]).toBeNull();
  });

  it("treats HTTP 412 as an empty list so disconnect clears the explorer", async () => {
    useFlowStore.setState({
      flows: {
        [WID]: [listedFlow("stale", "Stale") as never],
      },
      error: { [WID]: "previous error" },
    });
    http.GET.mockResolvedValueOnce({
      data: { success: false, error: "GitHub repository required" },
      error: { error: "GitHub repository required" },
      response: { ok: false, status: 412, statusText: "Precondition Failed" },
    });

    const listed = await useFlowStore.getState().fetchFlows(WID);

    const state = useFlowStore.getState();
    expect(listed).toEqual([]);
    expect(state.flows[WID]).toEqual([]);
    expect(state.error[WID]).toBeNull();
  });

  it("records the error when the request fails for a non-412 reason", async () => {
    http.GET.mockRejectedValueOnce(new Error("boom"));

    const listed = await useFlowStore.getState().fetchFlows(WID);

    const state = useFlowStore.getState();
    expect(listed).toEqual([]);
    expect(state.error[WID]).toBe("boom");
    expect(state.loading[WID]).toBeUndefined();
  });
});

describe("flowStore keeps open flow tabs titled after the flow", () => {
  beforeEach(() => {
    useConsoleStore.setState({ tabs: {}, activeTabId: null });
  });

  it("retitles an open tab by id when a refetch brings a new name (laptop rename + Refresh)", async () => {
    useConsoleStore.setState(state => {
      (state.tabs as Record<string, unknown>).t1 = {
        id: "t1",
        title: "Orders nightly sync",
        content: "",
        kind: "flow-editor",
        metadata: { flowId: "f1" },
      };
      (state.tabs as Record<string, unknown>).t2 = {
        id: "t2",
        title: "Another flow",
        content: "",
        kind: "flow-editor",
        metadata: { flowId: "gone" },
      };
    });
    http.GET.mockResolvedValueOnce(
      ok({ success: true, data: [listedFlow("f1", "Orders v3 sync")] }),
    );

    await useFlowStore.getState().fetchFlows(WID);

    const tabs = useConsoleStore.getState().tabs;
    expect(tabs.t1?.title).toBe("Orders v3 sync");
    // A flow the list lacks keeps its tab as it was; the editor reports it.
    expect(tabs.t2?.title).toBe("Another flow");
  });
});

describe("flowStore persists file-born flows", () => {
  /**
   * What the list sends for flows that came from git: a row whose source
   * connection the lookup could not find (`dataSourceId: null`), and a file
   * with no row yet (`gitOnly`). Rejecting the null failed EVERY save of
   * the whole list ("Validation failed when saving flow-store-v2"), so the
   * copy on disk froze at an older list.
   */
  it("saves the list with null connection lookups instead of refusing it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const fileBorn = {
      ...listedFlow("f2", "Orders v3 sync"),
      createdBy: "git",
      sourceType: "connector",
      dataSourceId: null,
      destinationDatabaseId: null,
      tableDestinationConnection: null,
      aliases: ["orders-sync"],
    };
    const gitOnly = {
      _id: "f3",
      workspaceId: WID,
      slug: "fresh",
      name: "fresh",
      createdBy: "git",
      runCount: 0,
      sourceType: "connector",
      gitOnly: true,
      syncMode: "full",
      enabled: false,
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
      definitionInvalid: {
        reason: "connector source has no connection_id",
        at: "2026-10-06T00:00:00.000Z",
        path: "flows/fresh.yml",
      },
    };
    http.GET.mockResolvedValueOnce(
      ok({ success: true, data: [fileBorn, gitOnly] }),
    );

    await useFlowStore.getState().fetchFlows(WID);

    const saving = errors.mock.calls.filter(call =>
      String(call[0]).includes("Validation failed when saving flow-store-v2"),
    );
    expect(saving).toEqual([]);
    const saved = JSON.parse(storage.getItem("flow-store-v2") ?? "{}");
    expect(
      saved.state.flows[WID].map((flow: { _id: string }) => flow._id),
    ).toEqual(["f2", "f3"]);
    expect(saved.state.flows[WID][0].dataSourceId).toBeNull();
    errors.mockRestore();
  });
});
