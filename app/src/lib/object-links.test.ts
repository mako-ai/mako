/**
 * resolveObjectRef tells "gone" from "could not find out": only a 404 is
 * null. A caller shows a dead-link notice on null and must never do so
 * because the server was down.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  GET: vi.fn(),
  POST: vi.fn(),
}));
vi.mock("../api", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: { GET: h.GET, POST: h.POST },
    unwrapBody: (res: { status: number; body: { error?: string } }) => {
      if (res.status >= 400) {
        throw new ApiError(res.body.error ?? "failed", res.status);
      }
      return res.body;
    },
  };
});

import { renameObject, resolveObjectRef } from "./object-links";

const resolved = {
  kind: "app",
  id: "a1",
  via: "alias",
  current: { title: "Revenue", slug: "revenue", url: "/apps/revenue" },
};

describe("object links", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks the server what a name points at now", async () => {
    h.GET.mockResolvedValue({ status: 200, body: { success: true, resolved } });
    expect(await resolveObjectRef("ws1", "app", "report")).toEqual(resolved);
    expect(h.GET).toHaveBeenCalledWith(
      "/api/workspaces/{workspaceId}/objects/resolve",
      {
        params: {
          path: { workspaceId: "ws1" },
          query: { kind: "app", ref: "report" },
        },
      },
    );
  });

  it("answers null on a 404 and throws on anything else", async () => {
    h.GET.mockResolvedValue({ status: 404, body: { error: "Not found" } });
    expect(await resolveObjectRef("ws1", "app", "gone")).toBeNull();
    for (const status of [500, 502, 403, 401]) {
      h.GET.mockResolvedValue({ status, body: { error: "nope" } });
      await expect(resolveObjectRef("ws1", "app", "x")).rejects.toMatchObject({
        status,
      });
    }
    h.GET.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(resolveObjectRef("ws1", "app", "x")).rejects.toThrow(
      "Failed to fetch",
    );
  });

  it("renames through the one route, and fails in the server's words", async () => {
    const result = { kind: "app", id: "a1", after: { slug: "revenue" } };
    h.POST.mockResolvedValue({ status: 200, body: { success: true, result } });
    expect(
      await renameObject("ws1", "app", { ref: "a1", slug: "revenue" }),
    ).toEqual(result);
    expect(h.POST).toHaveBeenCalledWith(
      "/api/workspaces/{workspaceId}/objects/{kind}/rename",
      {
        params: { path: { workspaceId: "ws1", kind: "app" } },
        body: { ref: "a1", slug: "revenue" },
      },
    );
    h.POST.mockResolvedValue({
      status: 409,
      body: { error: "Another app already uses the link /apps/revenue." },
    });
    await expect(
      renameObject("ws1", "app", { ref: "a1", slug: "revenue" }),
    ).rejects.toThrow("Another app already uses the link /apps/revenue.");
  });
});
