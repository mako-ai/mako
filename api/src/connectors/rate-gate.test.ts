/**
 * The per-key rate gate shared by sync and the connection proxy: one request
 * at a time per key, first come first served within a lane, sync first.
 */
import { describe, expect, it } from "vitest";
import { RateGateBusyError, throttledRequest } from "./rate-gate";

describe("rate gate", () => {
  it("runs one request at a time per key, in order", async () => {
    const order: string[] = [];
    let running = 0;
    let most = 0;
    const job = (name: string) => async () => {
      running += 1;
      most = Math.max(most, running);
      order.push(name);
      await new Promise(r => setTimeout(r, 2));
      running -= 1;
      return name;
    };
    const results = await Promise.all(
      ["a", "b", "c"].map(n => throttledRequest("key-1", job(n), 1)),
    );
    expect(results).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(most).toBe(1);
  });

  it("lets a waiting sync request go before a waiting proxy request", async () => {
    const order: string[] = [];
    const job = (name: string) => async () => {
      order.push(name);
      await new Promise(r => setTimeout(r, 2));
    };
    const first = throttledRequest("key-2", job("sync-1"), 1);
    const proxy = throttledRequest("key-2", job("proxy-1"), 1, "proxy");
    const sync = throttledRequest("key-2", job("sync-2"), 1);
    await Promise.all([first, proxy, sync]);
    expect(order).toEqual(["sync-1", "sync-2", "proxy-1"]);
  });

  it("passes a failure to its caller and keeps the gate open", async () => {
    await expect(
      throttledRequest(
        "key-3",
        async () => {
          throw new Error("boom");
        },
        0,
      ),
    ).rejects.toThrow("boom");
    await expect(throttledRequest("key-3", async () => 1, 0)).resolves.toBe(1);
  });

  it("gives a waiting proxy request a turn after four sync requests", async () => {
    const order: string[] = [];
    const job = (name: string) => async () => {
      order.push(name);
      await new Promise(r => setTimeout(r, 1));
    };
    const syncs = ["s1", "s2", "s3", "s4", "s5", "s6"].map(n =>
      throttledRequest("key-4", job(n), 0),
    );
    const proxy = throttledRequest("key-4", job("p1"), 0, "proxy");
    await Promise.all([...syncs, proxy]);
    expect(order).toEqual(["s1", "s2", "s3", "s4", "p1", "s5", "s6"]);
  });

  it("refuses a proxy request that waits too long, and lets its signal cancel it", async () => {
    let release: () => void = () => {};
    const blocking = throttledRequest(
      "key-5",
      () => new Promise<void>(r => (release = r)),
      0,
    );
    const ran: string[] = [];
    const late = throttledRequest(
      "key-5",
      async () => ran.push("late"),
      0,
      "proxy",
      { queueMs: 5 },
    );
    await expect(late).rejects.toBeInstanceOf(RateGateBusyError);
    await expect(late).rejects.toThrow(
      "Too many requests are waiting for this service's rate limit; try again shortly.",
    );
    const controller = new AbortController();
    const cancelled = throttledRequest(
      "key-5",
      async () => ran.push("cancelled"),
      0,
      "proxy",
      { signal: controller.signal },
    );
    controller.abort(new Error("stopped"));
    await expect(cancelled).rejects.toThrow("stopped");
    release();
    await blocking;
    await expect(
      throttledRequest("key-5", async () => 2, 0, "proxy"),
    ).resolves.toBe(2);
    expect(ran).toEqual([]);
  });
});
