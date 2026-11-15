import { describe, expect, it } from "vitest";
import { ConnectionCache } from "./connection-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Fake = { id: number; closed: number };

function cache(
  options: { now?: () => number; busy?: (v: Fake) => boolean } = {},
) {
  const closed: string[] = [];
  const store = new ConnectionCache<Fake>({
    name: "fake",
    close: (value, key) => {
      value.closed++;
      closed.push(key);
    },
    isBusy: options.busy,
    now: options.now,
  });
  let next = 0;
  const make = async (): Promise<Fake> => ({ id: ++next, closed: 0 });
  return { store, closed, make };
}

describe("ConnectionCache", () => {
  it("shares one creation between concurrent first callers", async () => {
    const { store } = cache();
    const gate = deferred<void>();
    let creates = 0;
    const create = async () => {
      creates++;
      await gate.promise;
      return { id: creates, closed: 0 };
    };
    const a = store.acquire("k", create);
    const b = store.acquire("k", create);
    gate.resolve();
    expect(await a).toBe(await b);
    expect(creates).toBe(1);
    expect(store.pendingKeys()).toEqual([]);
    expect(await store.acquire("k", create)).toBe(await a);
    expect(creates).toBe(1);
  });

  it("does not cache a failed creation", async () => {
    const { store, make } = cache();
    await expect(
      store.acquire("k", async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    expect(store.size).toBe(0);
    expect((await store.acquire("k", make)).id).toBe(1);
  });

  it("closes one connection's keys, bare and per database, and only those", async () => {
    const { store, closed, make } = cache();
    for (const key of ["a", "a:db1", "a:db2", "ab:db1", "b"]) {
      await store.acquire(key, make);
    }
    await store.closeConnection("a");
    expect(closed.sort()).toEqual(["a", "a:db1", "a:db2"]);
    expect(store.keys().sort()).toEqual(["ab:db1", "b"]);
    await store.closeAll();
    expect(store.size).toBe(0);
  });

  it("closes a creation still in flight once it lands, without storing it", async () => {
    const { store, closed } = cache();
    const gate = deferred<void>();
    const value: Fake = { id: 1, closed: 0 };
    const acquiring = store.acquire("a:db", async () => {
      await gate.promise;
      return value;
    });
    const closing = store.closeConnection("a");
    gate.resolve();
    expect(await acquiring).toBe(value);
    await closing;
    expect(value.closed).toBe(1);
    expect(closed).toEqual(["a:db"]);
    expect(store.size).toBe(0);
  });

  it("forgets only the value it was given", async () => {
    const { store, make } = cache();
    const old = await store.acquire("k", make);
    await store.close("k");
    const live = await store.acquire("k", make);
    expect(store.forget("k", old)).toBe(false);
    expect(store.get("k")).toBe(live);
    expect(store.forget("k", live)).toBe(true);
    expect(store.size).toBe(0);
  });

  it("sweeps idle entries that are not busy", async () => {
    let now = 1_000;
    const busy = new Set<number>();
    const { store, closed, make } = cache({
      now: () => now,
      busy: v => busy.has(v.id),
    });
    await store.acquire("idle", make);
    const held = await store.acquire("busy", make);
    await store.acquire("used", make);
    busy.add(held.id);
    now += 10_000;
    store.touch("used");
    expect(await store.sweepIdle(5_000)).toEqual(["idle"]);
    expect(closed).toEqual(["idle"]);
    expect(store.keys().sort()).toEqual(["busy", "used"]);
  });

  it("logs, never throws, when a close fails", async () => {
    const store = new ConnectionCache<Fake>({
      name: "fake",
      close: () => {
        throw new Error("boom");
      },
    });
    await store.acquire("k", async () => ({ id: 1, closed: 0 }));
    await expect(store.closeAll()).resolves.toBeUndefined();
    expect(store.size).toBe(0);
  });
});
