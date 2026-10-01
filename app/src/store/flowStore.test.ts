// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

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
