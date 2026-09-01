/**
 * The live-binding circuit breaker.
 *
 * What must hold, stated as the prod incident it exists to prevent: a binding
 * whose query keeps failing must stop reaching the warehouse, and a page that
 * mounts several tables at once must start ONE query, not one per table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logging", () => ({
  loggers: { api: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

import {
  LiveBindingCoolingDown,
  cooldownMsFor,
  resetLiveBindingGuardForTests,
  withLiveBindingGuard,
} from "./live-binding-guard";

const target = { workspaceId: "w1", slug: "app", name: "email_links" };

beforeEach(() => {
  delete process.env.REDIS_URL; // memory store
  resetLiveBindingGuardForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cooldownMsFor", () => {
  it("doubles per consecutive failure and caps", () => {
    expect(cooldownMsFor(0)).toBe(0);
    expect(cooldownMsFor(1)).toBe(60_000);
    expect(cooldownMsFor(2)).toBe(120_000);
    expect(cooldownMsFor(3)).toBe(240_000);
    // Capped, and stays capped however long the streak runs.
    expect(cooldownMsFor(10)).toBe(15 * 60_000);
    expect(cooldownMsFor(100)).toBe(15 * 60_000);
  });
});

describe("the storm this prevents", () => {
  it("turns a retry storm into a handful of queries", async () => {
    let queries = 0;
    const attempt = () =>
      withLiveBindingGuard(target, async () => {
        queries += 1;
        throw new Error("Query timed out after 300 seconds.");
      }).catch(() => undefined);

    // The observed storm: a request every 30s for 48 minutes.
    await attempt();
    for (let elapsed = 0; elapsed < 48 * 60_000; elapsed += 30_000) {
      vi.setSystemTime(Date.now() + 30_000);
      await attempt();
    }

    // 41 attempts reached BigQuery in the real incident. With 1m/2m/4m/8m/15m
    // backoff the same 48 minutes admits 7 — at t=0, 1m, 3m, 7m, 15m, 31m, 46m.
    // Asserted exactly: "fewer" would pass even if the backoff barely worked.
    expect(queries).toBe(7);
  });

  it("refuses without running the query, and says how long to wait", async () => {
    await expect(
      withLiveBindingGuard(target, async () => {
        throw new Error("BigQuery said no");
      }),
    ).rejects.toThrow("BigQuery said no");

    let ran = false;
    const refused = await withLiveBindingGuard(target, async () => {
      ran = true;
      return "never";
    }).catch(e => e);

    expect(ran).toBe(false); // the warehouse was not touched
    expect(refused).toBeInstanceOf(LiveBindingCoolingDown);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(refused.failures).toBe(1);
    // The reason survives, so the user is told what actually went wrong.
    expect(refused.message).toBe("BigQuery said no");
  });

  it("lets the binding through again once the window passes", async () => {
    await withLiveBindingGuard(target, async () => {
      throw new Error("boom");
    }).catch(() => undefined);

    vi.setSystemTime(Date.now() + 61_000);
    await expect(
      withLiveBindingGuard(target, async () => "fresh parquet"),
    ).resolves.toBe("fresh parquet");
  });

  it("escalates while it keeps failing, and resets after a success", async () => {
    const fail = () =>
      withLiveBindingGuard(target, async () => {
        throw new Error("boom");
      }).catch(e => e);

    await fail(); // 1st failure -> 1m
    vi.setSystemTime(Date.now() + 61_000);
    await fail(); // 2nd -> 2m
    vi.setSystemTime(Date.now() + 121_000);
    await fail(); // 3rd -> 4m

    const refused = await withLiveBindingGuard(target, async () => "x").catch(
      e => e,
    );
    expect(refused.failures).toBe(3);
    expect(refused.retryAfterMs).toBeGreaterThan(120_000); // the 4m window

    // A success wipes the streak: the next failure starts back at one minute.
    vi.setSystemTime(Date.now() + 241_000);
    await withLiveBindingGuard(target, async () => "ok");
    const after = await fail();
    expect(after.message).toBe("boom");
    const nextRefusal = await withLiveBindingGuard(
      target,
      async () => "x",
    ).catch(e => e);
    expect(nextRefusal.failures).toBe(1);
    expect(nextRefusal.retryAfterMs).toBeLessThanOrEqual(60_000);
  });
});

describe("single flight", () => {
  it("a page mounting six tables starts one query, not six", async () => {
    let started = 0;
    let release: (v: string) => void = () => {};
    const gate = new Promise<string>(r => (release = r));

    const calls = Array.from({ length: 6 }, () =>
      withLiveBindingGuard(target, () => {
        started += 1;
        return gate;
      }),
    );
    release("parquet");
    const results = await Promise.all(calls);

    expect(started).toBe(1);
    expect(results).toEqual(Array(6).fill("parquet"));
  });

  it("different bindings are independent — one failing does not block another", async () => {
    await withLiveBindingGuard(target, async () => {
      throw new Error("only this one is broken");
    }).catch(() => undefined);

    await expect(
      withLiveBindingGuard(
        { ...target, name: "email_weekly" },
        async () => "ok",
      ),
    ).resolves.toBe("ok");
  });
});
