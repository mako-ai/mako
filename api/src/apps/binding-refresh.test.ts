/**
 * On-demand binding refresh — the shared policy every `__data/<name>/refresh`
 * host runs (viewer, preview, share, sandbox, laptop). What these pin:
 *
 *   - a live binding is never "built": success, nothing stored;
 *   - concurrent refreshes of one binding are ONE materialization;
 *   - the anonymous cooldown is asked once per build, not once per caller,
 *     and a refused slot is a 429 with a retry hint;
 *   - a failed query is a 502 carrying the warehouse's message;
 *   - every host serializes the answer the same way.
 *
 * Pure: the repo read, the build and the claim are injected.
 */
import { describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type { IAppProject } from "../database/workspace-schema";
import {
  BindingRefreshError,
  refreshAppBinding,
  refreshBindingHttp,
  refreshPathBinding,
  type RefreshBindingDeps,
} from "./binding-refresh";

const project = { _id: new Types.ObjectId() } as unknown as IAppProject;

function deps(overrides: Partial<RefreshBindingDeps> = {}): RefreshBindingDeps {
  return {
    readMaterialization: vi.fn(async () => "parquet" as const),
    materialize: vi.fn(async () => ({
      rowCount: 3,
      byteSize: 1024,
      materializedAt: new Date("2026-09-02T10:00:00Z"),
    })),
    claim: vi.fn(async () => ({ claimed: true as const })),
    ...overrides,
  };
}

describe("refreshPathBinding", () => {
  it("matches the data URL's sibling, with or without a leading slash", () => {
    expect(refreshPathBinding("__data/sales/refresh")).toBe("sales");
    expect(refreshPathBinding("/__data/q-1_2/refresh")).toBe("q-1_2");
    expect(refreshPathBinding("__data/sales.parquet")).toBeNull();
    expect(refreshPathBinding("__data/../x/refresh")).toBeNull();
    expect(refreshPathBinding("assets/index.js")).toBeNull();
  });
});

describe("refreshAppBinding", () => {
  it("rebuilds a parquet binding and reports the build", async () => {
    const d = deps();
    const result = await refreshAppBinding(
      { project, name: "sales", actorId: "u1", at: "abc123" },
      d,
    );
    expect(result).toEqual({
      binding: "sales",
      materialization: "parquet",
      rowCount: 3,
      byteSize: 1024,
      materializedAt: "2026-09-02T10:00:00.000Z",
    });
    // Built AT the commit the caller is reading, not the actor's branch.
    expect(d.materialize).toHaveBeenCalledWith(project, "sales", "u1", {
      at: "abc123",
    });
  });

  it("does not build a live binding — it is fresh on every read", async () => {
    const d = deps({
      readMaterialization: vi.fn(async () => "live" as const),
    });
    const result = await refreshAppBinding(
      { project, name: "now", actorId: "u1" },
      d,
    );
    expect(result).toEqual({ binding: "now", materialization: "live" });
    expect(d.materialize).not.toHaveBeenCalled();
  });

  it("rejects an invalid name and an unknown binding before touching anything", async () => {
    const d = deps({ readMaterialization: vi.fn(async () => null) });
    await expect(
      refreshAppBinding({ project, name: "../etc", actorId: "u1" }, d),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      refreshAppBinding({ project, name: "ghost", actorId: "u1" }, d),
    ).rejects.toMatchObject({ status: 404 });
    expect(d.materialize).not.toHaveBeenCalled();
  });

  it("shares one build between concurrent refreshes of the same binding", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const d = deps({
      materialize: vi.fn(async () => {
        await gate;
        return { rowCount: 1, byteSize: 10, materializedAt: new Date() };
      }),
    });
    const input = {
      project,
      name: "shared",
      actorId: "u1",
      cooldownMs: 60_000,
    };
    const first = refreshAppBinding(input, d);
    const second = refreshAppBinding(input, d);
    // Let the second caller reach the in-flight map before the first finishes.
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.rowCount).toBe(1);
    expect(b.rowCount).toBe(1);
    expect(d.materialize).toHaveBeenCalledTimes(1);
    // The cooldown slot was claimed for the build, not per caller.
    expect(d.claim).toHaveBeenCalledTimes(1);
  });

  it("turns a refused cooldown slot into a 429 with a retry hint", async () => {
    const d = deps({
      claim: vi.fn(async () => ({
        claimed: false as const,
        retryAfterMs: 42_000,
      })),
    });
    const error = await refreshAppBinding(
      { project, name: "sales", actorId: "", cooldownMs: 300_000 },
      d,
    ).catch(e => e);
    expect(error).toBeInstanceOf(BindingRefreshError);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(42_000);
    expect(d.materialize).not.toHaveBeenCalled();
  });

  it("does not ask for a cooldown slot when no cooldown applies", async () => {
    const d = deps();
    await refreshAppBinding({ project, name: "sales", actorId: "u1" }, d);
    expect(d.claim).not.toHaveBeenCalled();
  });

  it("reports a failed query as a 502 with the warehouse's message", async () => {
    const d = deps({
      materialize: vi.fn(async () => {
        throw new Error("Syntax error at or near FROM");
      }),
    });
    await expect(
      refreshAppBinding({ project, name: "broken", actorId: "u1" }, d),
    ).rejects.toMatchObject({
      status: 502,
      message: "Syntax error at or near FROM",
    });
    // A failed build leaves nothing in flight: the next refresh tries again.
    await expect(
      refreshAppBinding({ project, name: "broken", actorId: "u1" }, d),
    ).rejects.toMatchObject({ status: 502 });
    expect(d.materialize).toHaveBeenCalledTimes(2);
  });
});

describe("refreshBindingHttp", () => {
  it("serializes success and refresh failures the way the SDK reads them", async () => {
    const ok = await refreshBindingHttp(
      { project, name: "sales", actorId: "u1" },
      deps(),
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      success: true,
      binding: "sales",
      rowCount: 3,
    });

    const cooling = await refreshBindingHttp(
      { project, name: "sales", actorId: "", cooldownMs: 1000 },
      deps({
        claim: vi.fn(async () => ({
          claimed: false as const,
          retryAfterMs: 2500,
        })),
      }),
    );
    expect(cooling.status).toBe(429);
    expect(cooling.body).toMatchObject({ success: false, retryAfterMs: 2500 });
    expect(cooling.headers["retry-after"]).toBe("3");
  });

  it("lets unexpected errors propagate to the host's error handling", async () => {
    const d = deps({
      readMaterialization: vi.fn(async () => {
        throw new Error("git: repository unavailable");
      }),
    });
    await expect(
      refreshBindingHttp({ project, name: "sales", actorId: "u1" }, d),
    ).rejects.toThrow("git: repository unavailable");
  });
});
