/**
 * `resolveObjectRef` is what the dead-link notices key on, so its contract
 * matters: `null` means the server said NOT FOUND; anything else that goes
 * wrong is thrown, because "unknown" must never be shown as "deleted".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/result";

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./api-client", () => ({
  apiClient: { get: (...args: unknown[]) => h.get(...args) },
}));

import { resolveObjectRef } from "./object-links";

describe("resolveObjectRef", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the resolved ref on success", async () => {
    const resolved = {
      kind: "notebook",
      id: "n1",
      via: "current",
      current: { title: "Churn", url: "/n/n1" },
    };
    h.get.mockResolvedValue({ success: true, resolved });
    expect(await resolveObjectRef("ws1", "notebook", "n1")).toEqual(resolved);
    expect(h.get).toHaveBeenCalledWith("/workspaces/ws1/objects/resolve", {
      kind: "notebook",
      ref: "n1",
    });
  });

  it("returns null only on a 404", async () => {
    h.get.mockRejectedValue(new ApiError("Not found", 404));
    expect(await resolveObjectRef("ws1", "dashboard", "d1")).toBeNull();
  });

  it("throws on any other failure (5xx, network), never pretending the object is gone", async () => {
    h.get.mockRejectedValue(new ApiError("Internal", 500));
    await expect(
      resolveObjectRef("ws1", "dashboard", "d1"),
    ).rejects.toMatchObject({ status: 500 });
    h.get.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(resolveObjectRef("ws1", "notebook", "n1")).rejects.toThrow(
      "Failed to fetch",
    );
  });
});
