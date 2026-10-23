/**
 * The per-key rate gate shared by sync and the connection proxy: one request
 * at a time per key, first come first served within a lane, sync first.
 */
import { describe, expect, it } from "vitest";
import { throttledRequest } from "../connectors/rate-gate";

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
});
