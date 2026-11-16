/**
 * Box leases and lifecycle (RFC connector-runtime §6, iteration 2), against a
 * mocked provider, the in-process store and signals, and fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoxHandle, BoxProvider } from "./box-provider";
import { MemoryBoxSignals } from "./box-signals";
import { MemoryBoxStore, type BoxRecord } from "./box-store";
import { BOX_LEASE_DEFAULTS, type BoxLeaseConfig } from "./config";
import type { BoxMetrics } from "./metrics";
import { BoxScheduler, boxKey, type RunSpec } from "./scheduler";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

type Life = "running" | "paused" | "dead";

function fakeProvider() {
  const life = new Map<string, Life>();
  const failPing = new Set<string>();
  const failTemplate = new Set<string>();
  const account = { appSessions: 0, fail: false };
  const provider = {
    life,
    failPing,
    failTemplate,
    account,
    /** App sessions plus running connector boxes: the whole account. */
    countRunning: vi.fn(async () => {
      if (account.fail) throw new Error("list failed");
      return (
        account.appSessions +
        [...life.values()].filter(state => state === "running").length
      );
    }),
    lease: vi.fn(async (box: BoxHandle, options: { template?: string }) => {
      if (options.template && failTemplate.has(options.template)) {
        throw new Error("snapshot not found");
      }
      life.set(box.boxId, "running");
    }),
    exec: vi.fn(),
    ping: vi.fn(async (box: BoxHandle) => {
      if (failPing.has(box.boxId) || life.get(box.boxId) === "dead") {
        return false;
      }
      life.set(box.boxId, "running");
      return true;
    }),
    pause: vi.fn(async (box: BoxHandle) => {
      life.set(box.boxId, "paused");
    }),
    kill: vi.fn(async (box: BoxHandle) => {
      life.set(box.boxId, "dead");
    }),
    snapshot: vi.fn(async (_box: BoxHandle, name: string) => `snap:${name}`),
    deleteSnapshot: vi.fn(async () => undefined),
  };
  return provider satisfies BoxProvider;
}

function fakeMetrics() {
  return {
    leaseWait: vi.fn(),
    boxSeconds: vi.fn(),
    reaped: vi.fn(),
    failedPing: vi.fn(),
    boxCounts: vi.fn(),
    ceilingReached: vi.fn(),
  } satisfies BoxMetrics;
}

const run = (overrides: Partial<RunSpec> = {}): RunSpec => ({
  workspaceId: "ws1",
  connectionId: "conn-a",
  bundleHash: "hash-1",
  command: "read",
  runtimeId: "rt-1",
  ...overrides,
});

/** A promise and the function that settles it, to hold a run open. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => (open = resolve));
  return { opened, open };
}

let store: MemoryBoxStore;
let signals: MemoryBoxSignals;
let provider: ReturnType<typeof fakeProvider>;
let metrics: ReturnType<typeof fakeMetrics>;

function scheduler(config: Partial<BoxLeaseConfig> = {}) {
  return new BoxScheduler({
    store,
    signals,
    provider,
    metrics,
    config: { ...BOX_LEASE_DEFAULTS, ...config },
  });
}

const boxes = (): BoxRecord[] => [...store.boxes.values()];
const box = (boxId: string): BoxRecord => {
  const found = store.boxes.get(boxId);
  if (!found) throw new Error(`no box ${boxId}`);
  return found;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-16T09:00:00Z"));
  store = new MemoryBoxStore();
  signals = new MemoryBoxSignals();
  provider = fakeProvider();
  metrics = fakeMetrics();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("lease acquire and release", () => {
  it("leases a fresh box for the run and leaves it idle afterwards", async () => {
    const s = scheduler();
    let during: BoxRecord | undefined;
    const result = await s.withLease(run(), async lease => {
      during = { ...box(lease.boxId) };
      expect(lease.ctx.sessionKey).toBe(`connector-box:${lease.boxId}`);
      expect(lease.fresh).toBe(true);
      return "done";
    });

    expect(result).toBe("done");
    expect(during?.state).toBe("leased");
    expect(during?.leasedBy).toMatch(/^run_/);
    expect(during?.key).toBe(boxKey("conn-a", "hash-1"));
    const [after] = boxes();
    expect(after.state).toBe("idle");
    expect(after.leasedBy).toBeNull();
    expect(after.runs).toBe(1);
    expect(provider.lease).toHaveBeenCalledTimes(1);
    expect(metrics.leaseWait).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ source: "fresh", connectionId: "conn-a" }),
    );
    expect(metrics.boxSeconds).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ workspaceId: "ws1", connectionId: "conn-a" }),
    );
  });

  it("reuses the idle box for the next run of the same key, without a ping while it is warm", async () => {
    const s = scheduler();
    const first = await s.withLease(run(), async lease => lease.boxId);
    provider.ping.mockClear();
    const second = await s.withLease(run(), async lease => {
      expect(lease.fresh).toBe(false);
      return lease.boxId;
    });

    expect(second).toBe(first);
    expect(provider.lease).toHaveBeenCalledTimes(1);
    // The previous run ended well moments ago: that was the liveness check.
    expect(provider.ping).not.toHaveBeenCalled();
    expect(box(first).runs).toBe(2);
  });

  it("pings an idle box again once its last good run is older than the liveness TTL", async () => {
    const s = scheduler({ livenessTtlMs: 10 * SECOND, idlePauseMs: HOUR });
    await s.withLease(run(), async lease => lease.boxId);
    provider.ping.mockClear();
    vi.setSystemTime(Date.now() + 11 * SECOND);
    await s.withLease(run(), async lease => lease.boxId);
    expect(provider.ping).toHaveBeenCalledTimes(1);
  });

  it("pings an idle box whose last run failed", async () => {
    const s = scheduler();
    await s
      .withLease(run(), async () => {
        throw new Error("vendor said 500");
      })
      .catch(() => undefined);
    provider.ping.mockClear();
    await s.withLease(run(), async lease => lease.boxId);
    expect(provider.ping).toHaveBeenCalledTimes(1);
  });

  it("pings after success, then a failure, even within the TTL of the success", async () => {
    const s = scheduler();
    await s.withLease(run(), async lease => lease.boxId);
    await s
      .withLease(run(), async lease => lease.markFailed("timed out"))
      .catch(() => undefined);
    provider.ping.mockClear();
    await s.withLease(run(), async lease => lease.boxId);
    expect(provider.ping).toHaveBeenCalledTimes(1);
  });

  it("pings a paused box, which a lease resumes", async () => {
    const s = scheduler();
    const id = await s.withLease(run(), async lease => lease.boxId);
    await vi.advanceTimersByTimeAsync(BOX_LEASE_DEFAULTS.idlePauseMs + SECOND);
    expect(box(id).state).toBe("paused");
    provider.ping.mockClear();
    await s.withLease(run(), async lease => lease.boxId);
    expect(provider.ping).toHaveBeenCalledTimes(1);
  });

  it("kills a warm box that turns out to be gone at its first command, so no run gets it again", async () => {
    const s = scheduler();
    const first = await s.withLease(run(), async lease => lease.boxId);
    const gone = Object.assign(
      new Error("Sandbox is probably not running anymore"),
      {
        name: "SandboxNotFoundError",
      },
    );
    await expect(
      s.withLease(run(), async () => {
        throw gone;
      }),
    ).rejects.toThrow("not running");
    expect(box(first).state).toBe("killed");
    expect(box(first).killReason).toBe("unhealthy: box gone");
    const next = await s.withLease(run(), async lease => lease.boxId);
    expect(next).not.toBe(first);
  });

  it("memoises per box: computed once while warm, again after a resume or a failure", async () => {
    const s = scheduler();
    const compute = vi.fn(async () => "installed");
    const id = await s.withLease(run(), async lease => {
      await lease.memo("bundle", compute);
      return lease.boxId;
    });
    await s.withLease(run(), lease => lease.memo("bundle", compute));
    expect(compute).toHaveBeenCalledTimes(1);

    // A run that fails forgets what the box holds.
    await s
      .withLease(run(), async () => {
        throw new Error("vendor said 500");
      })
      .catch(() => undefined);
    await s.withLease(run(), lease => lease.memo("bundle", compute));
    expect(compute).toHaveBeenCalledTimes(2);

    // So does a resume from paused.
    await vi.advanceTimersByTimeAsync(BOX_LEASE_DEFAULTS.idlePauseMs + SECOND);
    expect(box(id).state).toBe("paused");
    await s.withLease(run(), lease => lease.memo("bundle", compute));
    expect(compute).toHaveBeenCalledTimes(3);

    // And an explicit forget.
    await s.withLease(run(), async lease => {
      lease.forgetMemo();
      await lease.memo("bundle", compute);
    });
    expect(compute).toHaveBeenCalledTimes(4);
  });

  it("releases the lease when the run throws, and counts the failure", async () => {
    const s = scheduler();
    let boxId = "";
    await expect(
      s.withLease(run(), async lease => {
        boxId = lease.boxId;
        throw new Error("vendor said 500");
      }),
    ).rejects.toThrow("vendor said 500");

    expect(box(boxId).state).toBe("idle");
    expect(box(boxId).failures).toBe(1);
  });

  it("records the box-seconds the run held", async () => {
    const s = scheduler();
    const hold = gate();
    const pending = s.withLease(run(), () => hold.opened);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(12 * SECOND);
    hold.open();
    await pending;

    expect(boxes()[0].boxSeconds).toBeCloseTo(12, 0);
  });
});

describe("one box per connection", () => {
  it("never gives two connections the same box, even on one hash", async () => {
    const s = scheduler();
    const a = await s.withLease(
      run({ connectionId: "conn-a" }),
      async l => l.boxId,
    );
    const b = await s.withLease(
      run({ connectionId: "conn-b" }),
      async l => l.boxId,
    );

    expect(a).not.toBe(b);
    expect(box(a).connectionId).toBe("conn-a");
    expect(box(b).connectionId).toBe("conn-b");
    // A's idle box is not a candidate for B, and vice versa.
    const again = await s.withLease(
      run({ connectionId: "conn-b" }),
      async l => l.boxId,
    );
    expect(again).toBe(b);
  });

  it("gives a new hash a fresh box and drains the old hash's boxes", async () => {
    const s = scheduler();
    const old = await s.withLease(
      run({ bundleHash: "hash-1" }),
      async l => l.boxId,
    );
    const next = await s.withLease(
      run({ bundleHash: "hash-2" }),
      async l => l.boxId,
    );

    expect(next).not.toBe(old);
    expect(box(old).draining).toBe(true);
    await s.reap();
    expect(box(old).state).toBe("killed");
    expect(box(old).killReason).toBe("drained");
    expect(box(next).state).toBe("idle");
  });

  it("kills a one-off box (an unsaved connection) as soon as its run ends", async () => {
    const s = scheduler();
    const id = await s.withLease(
      run({ connectionId: "unsaved:x", oneOff: true }),
      async l => l.boxId,
    );
    expect(box(id).state).toBe("killed");
  });
});

describe("concurrent runs", () => {
  it("gives concurrent runs of one connection different boxes", async () => {
    const s = scheduler();
    const hold = gate();
    const seen: string[] = [];
    const runs = [1, 2, 3].map(() =>
      s.withLease(run(), async lease => {
        seen.push(lease.boxId);
        await hold.opened;
      }),
    );
    // Acquisition is serialised per key (one head of the queue at a time).
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    expect(new Set(seen).size).toBe(3);
    hold.open();
    await Promise.all(runs);
    expect(boxes().every(b => b.state === "idle")).toBe(true);
  });

  it("queues runs past the per-connection cap and serves them first in, first out", async () => {
    const s = scheduler({ maxPerConnection: 1 });
    const order: number[] = [];
    const holds = [gate(), gate(), gate()];
    const runs = holds.map((hold, index) =>
      s.withLease(run(), async lease => {
        order.push(index);
        await hold.opened;
        return lease.boxId;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([0]);

    holds[0].open();
    await vi.advanceTimersByTimeAsync(1 * SECOND);
    expect(order).toEqual([0, 1]);
    holds[1].open();
    await vi.advanceTimersByTimeAsync(1 * SECOND);
    expect(order).toEqual([0, 1, 2]);
    holds[2].open();

    const ids = await Promise.all(runs);
    // One box, reused in turn.
    expect(new Set(ids).size).toBe(1);
    expect(metrics.leaseWait).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.objectContaining({ queued: true }),
    );
  });

  it("gives up after the queue wait", async () => {
    const s = scheduler({ maxPerConnection: 1, queueWaitMs: 5 * SECOND });
    const hold = gate();
    const first = s.withLease(run(), () => hold.opened);
    await vi.advanceTimersByTimeAsync(0);
    const second = s.withLease(run(), async () => undefined);
    const failed = expect(second).rejects.toThrow(/No connector box/);
    await vi.advanceTimersByTimeAsync(6 * SECOND);
    await failed;
    hold.open();
    await first;
  });
});

describe("heartbeats and the reaper", () => {
  it("kills a box whose lease stopped beating", async () => {
    const s = scheduler();
    // acquire without withLease: the process that held it is gone.
    const held = await s.acquire(run());
    await vi.advanceTimersByTimeAsync(
      BOX_LEASE_DEFAULTS.heartbeatTimeoutMs + SECOND,
    );

    const summary = await s.reap();

    expect(summary.killed["heartbeat stopped"]).toBe(1);
    expect(box(held.box.boxId).state).toBe("killed");
    expect(provider.kill).toHaveBeenCalledWith(
      expect.objectContaining({ boxId: held.box.boxId }),
    );
    expect(metrics.reaped).toHaveBeenCalledWith(
      "heartbeat stopped",
      expect.objectContaining({ boxId: held.box.boxId }),
    );
  });

  it("leaves a beating lease alone", async () => {
    const s = scheduler();
    const hold = gate();
    let boxId = "";
    const pending = s.withLease(run(), async lease => {
      boxId = lease.boxId;
      await hold.opened;
    });
    await vi.advanceTimersByTimeAsync(
      3 * BOX_LEASE_DEFAULTS.heartbeatTimeoutMs,
    );

    const summary = await s.reap();
    expect(summary.killed).toEqual({});
    expect(box(boxId).state).toBe("leased");
    hold.open();
    await pending;
  });

  it("kills a box whose lease passed its deadline", async () => {
    const s = scheduler({ deadlineMarginMs: MINUTE });
    const hold = gate();
    const pending = s.withLease(run({ timeoutMs: MINUTE }), () => hold.opened);
    await vi.advanceTimersByTimeAsync(2 * MINUTE + SECOND);

    const summary = await s.reap();
    expect(summary.killed["lease expired"]).toBe(1);
    hold.open();
    await pending;
    // The run's release finds the box already gone and changes nothing.
    expect(boxes()[0].state).toBe("killed");
  });
});

describe("idle, pause and TTL", () => {
  it("pauses a box after it sits idle for idlePauseMs", async () => {
    const s = scheduler();
    const id = await s.withLease(run(), async lease => {
      lease.noteRuntime("rt-1");
      return lease.boxId;
    });
    expect(box(id).state).toBe("idle");

    await vi.advanceTimersByTimeAsync(BOX_LEASE_DEFAULTS.idlePauseMs - SECOND);
    expect(box(id).state).toBe("idle");
    await vi.advanceTimersByTimeAsync(2 * SECOND);

    expect(box(id).state).toBe("paused");
    expect(provider.pause).toHaveBeenCalledTimes(1);
    // Templates are taken before a credentialed run, never at pause time.
    expect(provider.snapshot).not.toHaveBeenCalled();
  });

  it("pauses idle boxes from the reaper too (another process released them)", async () => {
    const s = scheduler();
    const id = await s.withLease(run(), async l => l.boxId);
    const reaper = scheduler();
    vi.setSystemTime(Date.now() + BOX_LEASE_DEFAULTS.idlePauseMs + SECOND);

    const summary = await reaper.reap();
    expect(summary.paused).toBe(1);
    expect(box(id).state).toBe("paused");
    expect(summary.counts.paused).toBe(1);
    expect(metrics.boxCounts).toHaveBeenCalled();
  });

  it("resumes a paused box for the next run", async () => {
    const s = scheduler();
    const id = await s.withLease(run(), async l => l.boxId);
    await vi.advanceTimersByTimeAsync(BOX_LEASE_DEFAULTS.idlePauseMs + SECOND);
    expect(box(id).state).toBe("paused");

    const again = await s.withLease(run(), async lease => {
      expect(lease.fresh).toBe(false);
      return lease.boxId;
    });
    expect(again).toBe(id);
    expect(metrics.leaseWait).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.objectContaining({ source: "paused" }),
    );
  });

  it("kills a paused box after 1 h when its connection did not run in the last day", async () => {
    const s = scheduler();
    const id = await s.withLease(run(), async l => l.boxId);
    await vi.advanceTimersByTimeAsync(BOX_LEASE_DEFAULTS.idlePauseMs + SECOND);

    vi.setSystemTime(Date.now() + 50 * MINUTE);
    await s.reap();
    expect(box(id).state).toBe("paused");

    vi.setSystemTime(Date.now() + 11 * MINUTE);
    const summary = await s.reap();
    expect(summary.killed.ttl).toBe(1);
    expect(box(id).state).toBe("killed");
  });

  it("keeps a paused box 24 h when its connection ran in the last day", async () => {
    const s = scheduler({ maxAgeMs: 48 * HOUR });
    await s.withLease(run(), async l => l.boxId);
    vi.setSystemTime(Date.now() + 2 * HOUR);
    const id = await s.withLease(run(), async l => l.boxId);
    await vi.advanceTimersByTimeAsync(BOX_LEASE_DEFAULTS.idlePauseMs + SECOND);

    vi.setSystemTime(Date.now() + 23 * HOUR);
    await s.reap();
    expect(box(id).state).toBe("paused");

    vi.setSystemTime(Date.now() + 2 * HOUR);
    const summary = await s.reap();
    expect(summary.killed.ttl).toBe(1);
  });

  it("starts a new box for the key from its snapshot template", async () => {
    const s = scheduler();
    const hold = gate();
    // Box 1 is fresh: its key gets a template before its first command.
    await s.withLease(run(), async lease => {
      lease.noteRuntime("rt-1");
      await lease.snapshotPristine("rt-1");
    });
    expect(provider.snapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BOX_LEASE_DEFAULTS.idlePauseMs + SECOND);
    // Box 1 is busy, so a concurrent run needs a second box.
    const busy = s.withLease(run(), () => hold.opened);
    await vi.advanceTimersByTimeAsync(0);
    await s.withLease(run(), async lease => {
      expect(lease.fresh).toBe(true);
    });

    expect(provider.lease).toHaveBeenLastCalledWith(expect.any(Object), {
      template: expect.stringMatching(/^snap:mako-cbox-/),
    });
    expect(metrics.leaseWait).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.objectContaining({ source: "template" }),
    );
    hold.open();
    await busy;
  });

  it("falls back to the base template when a snapshot will not restore", async () => {
    const s = scheduler();
    const key = `${boxKey("conn-a", "hash-1")}:rt-1`;
    await store.claimTemplate(key, new Date());
    await store.completeTemplate(key, "snap:gone");
    provider.failTemplate.add("snap:gone");

    await s.withLease(run(), async lease => {
      expect(lease.fresh).toBe(true);
    });
    expect(provider.lease).toHaveBeenLastCalledWith(expect.any(Object), {});
    expect(store.templates.size).toBe(0);
    // The record AND the snapshot go: nothing is left to leak.
    expect(provider.deleteSnapshot).toHaveBeenCalledWith("snap:gone");
  });

  it("deletes templates unused for the template TTL", async () => {
    const s = scheduler();
    await store.claimTemplate("k", new Date());
    await store.completeTemplate("k", "snap:old");
    vi.setSystemTime(Date.now() + BOX_LEASE_DEFAULTS.templateTtlMs + SECOND);
    const summary = await s.reap();
    expect(summary.templatesDeleted).toBe(1);
    expect(provider.deleteSnapshot).toHaveBeenCalledWith("snap:old");
  });
});

describe("health", () => {
  it("kills a box that fails its ping and replaces it", async () => {
    // Past the liveness TTL, so the idle box is pinged.
    const s = scheduler({ livenessTtlMs: SECOND });
    const first = await s.withLease(run(), async l => l.boxId);
    vi.setSystemTime(Date.now() + 2 * SECOND);
    provider.failPing.add(first);

    const second = await s.withLease(run(), async l => l.boxId);

    expect(second).not.toBe(first);
    expect(box(first).state).toBe("killed");
    expect(box(first).killReason).toBe("failed ping");
    expect(metrics.failedPing).toHaveBeenCalledWith(
      expect.objectContaining({ boxId: first }),
    );
    expect(box(second).state).toBe("idle");
  });

  it("fails the run, and leaves no live box, when a new box will not answer", async () => {
    const s = scheduler();
    provider.ping.mockResolvedValue(false);

    await expect(s.withLease(run(), async () => undefined)).rejects.toThrow(
      /first ping/,
    );
    expect(boxes().every(b => b.state === "killed")).toBe(true);
  });

  it("retires a box after maxFailures failed runs", async () => {
    const s = scheduler({ maxFailures: 2 });
    let id = "";
    for (let i = 0; i < 2; i++) {
      await s
        .withLease(run(), async lease => {
          id = lease.boxId;
          lease.markFailed("timed out");
        })
        .catch(() => undefined);
    }
    expect(box(id).state).toBe("killed");
    expect(box(id).killReason).toBe("retired");
  });

  it("retires a box older than maxAgeMs instead of leasing it", async () => {
    const s = scheduler({ maxAgeMs: HOUR, ttlStaleMs: 10 * HOUR });
    const first = await s.withLease(run(), async l => l.boxId);
    vi.setSystemTime(Date.now() + HOUR + SECOND);
    const second = await s.withLease(run(), async l => l.boxId);

    expect(second).not.toBe(first);
    expect(box(first).killReason).toBe("retired");
  });
});

describe("account ceiling shared with app sessions", () => {
  // The E2B account runs 20 boxes at once, and app sessions use about 17.
  const ceiling = { accountCeiling: 20, appReserve: 2, accountCountTtlMs: 0 };

  it("starts a box while the account is under the ceiling minus the app reserve", async () => {
    provider.account.appSessions = 17;
    const s = scheduler(ceiling);
    await s.withLease(run(), async lease => {
      expect(lease.fresh).toBe(true);
    });
    expect(provider.lease).toHaveBeenCalledTimes(1);
  });

  it("never takes the reserved slots: a second box waits, then reuses the first", async () => {
    provider.account.appSessions = 17;
    const s = scheduler(ceiling);
    const hold = gate();
    let first = "";
    const busy = s.withLease(run(), async lease => {
      first = lease.boxId;
      await hold.opened;
    });
    await vi.advanceTimersByTimeAsync(0);
    let second = "";
    const waiting = s.withLease(run(), async lease => {
      second = lease.boxId;
    });
    await vi.advanceTimersByTimeAsync(5 * SECOND);

    // 17 app sessions + 1 connector box = 18 = 20 - 2: no new box.
    expect(second).toBe("");
    expect(provider.lease).toHaveBeenCalledTimes(1);
    expect(metrics.ceilingReached).toHaveBeenCalledWith({
      running: 18,
      limit: 18,
    });

    hold.open();
    await busy;
    await vi.advanceTimersByTimeAsync(1 * SECOND);
    await waiting;
    expect(second).toBe(first);
  });

  it("does not resume a paused box when app sessions fill the account", async () => {
    const s = scheduler({ ...ceiling, queueWaitMs: 3 * SECOND });
    const id = await s.withLease(run(), async l => l.boxId);
    await vi.advanceTimersByTimeAsync(BOX_LEASE_DEFAULTS.idlePauseMs + SECOND);
    expect(box(id).state).toBe("paused");

    provider.account.appSessions = 18;
    const failed = expect(
      s.withLease(run(), async () => undefined),
    ).rejects.toThrow(/No connector box/);
    await vi.advanceTimersByTimeAsync(4 * SECOND);
    await failed;
    expect(box(id).state).toBe("paused");
  });

  it("waits when the account count is unknown", async () => {
    provider.account.fail = true;
    const s = scheduler({ ...ceiling, queueWaitMs: 2 * SECOND });
    const failed = expect(
      s.withLease(run(), async () => undefined),
    ).rejects.toThrow(/No connector box/);
    await vi.advanceTimersByTimeAsync(3 * SECOND);
    await failed;
    expect(provider.lease).not.toHaveBeenCalled();
  });

  it("reads the ceiling and the reserve from the environment", async () => {
    const { boxLeaseConfig } = await import("./config");
    process.env.CONNECTOR_BOX_ACCOUNT_CEILING = "50";
    process.env.CONNECTOR_BOX_APP_RESERVE = "0";
    try {
      expect(boxLeaseConfig()).toMatchObject({
        accountCeiling: 50,
        appReserve: 0,
      });
    } finally {
      delete process.env.CONNECTOR_BOX_ACCOUNT_CEILING;
      delete process.env.CONNECTOR_BOX_APP_RESERVE;
    }
    expect(boxLeaseConfig()).toMatchObject({
      accountCeiling: 20,
      appReserve: 2,
    });
  });
});

describe("templates", () => {
  it("takes one snapshot per key when two fresh boxes race", async () => {
    const s = scheduler();
    const holds = [gate(), gate()];
    let release!: () => void;
    const slow = new Promise<void>(resolve => (release = resolve));
    provider.snapshot.mockImplementation(async (_box, name) => {
      await slow;
      return `snap:${name}`;
    });
    const runs = holds.map(hold =>
      s.withLease(run(), async lease => {
        const snap = lease.snapshotPristine("rt-1");
        await hold.opened;
        await snap;
      }),
    );
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    release();
    holds.forEach(h => h.open());
    await Promise.all(runs);

    expect(provider.snapshot).toHaveBeenCalledTimes(1);
    expect(store.templates.size).toBe(1);
  });

  it("drops the claim when the snapshot fails, so a later box can retry", async () => {
    const s = scheduler();
    provider.snapshot.mockRejectedValueOnce(new Error("snapshot failed"));
    await s.withLease(run(), lease => lease.snapshotPristine("rt-1"));
    expect(store.templates.size).toBe(0);
  });

  it("never snapshots a box restored from a template or a reused box", async () => {
    const s = scheduler();
    await s.withLease(run(), lease => lease.snapshotPristine("rt-1"));
    await s.withLease(run(), lease => lease.snapshotPristine("rt-1"));
    expect(provider.snapshot).toHaveBeenCalledTimes(1);
  });

  it("deletes a connection's templates and drains its boxes when it is deleted or rekeyed", async () => {
    const s = scheduler();
    const id = await s.withLease(run(), async lease => {
      await lease.snapshotPristine("rt-1");
      return lease.boxId;
    });
    await s.withLease(run({ connectionId: "conn-b" }), lease =>
      lease.snapshotPristine("rt-1"),
    );

    await s.forgetConnection("conn-a");

    expect(box(id).draining).toBe(true);
    expect([...store.templates.keys()]).toEqual([
      `${boxKey("conn-b", "hash-1")}:rt-1`,
    ]);
    expect(provider.deleteSnapshot).toHaveBeenCalledTimes(1);
    await s.reap();
    expect(box(id).state).toBe("killed");
  });
});

describe("draining and unhealthy boxes", () => {
  it("kills a box drained during its idle window instead of pausing it", async () => {
    const s = scheduler();
    const id = await s.withLease(run(), async l => l.boxId);
    await store.drainOtherHashes("conn-a", "hash-2");
    await vi.advanceTimersByTimeAsync(BOX_LEASE_DEFAULTS.idlePauseMs + SECOND);

    expect(box(id).state).toBe("killed");
    expect(box(id).killReason).toBe("drained");
    expect(provider.pause).not.toHaveBeenCalled();
  });

  it("kills a box marked unhealthy (a run's cleanup failed) instead of idling it", async () => {
    const s = scheduler();
    const id = await s.withLease(run(), async lease => {
      lease.markUnhealthy("cleanup failed");
      return lease.boxId;
    });
    expect(box(id).state).toBe("killed");
    expect(box(id).killReason).toMatch(/^unhealthy: cleanup failed/);
  });
});

describe("Redis outage", () => {
  function brokenSignals() {
    const broken = new MemoryBoxSignals();
    const fail = () => Promise.reject(new Error("ECONNREFUSED"));
    Object.assign(broken, {
      kind: "redis",
      beat: fail,
      lastBeats: fail,
      enqueue: fail,
      ensure: fail,
      isHead: fail,
      dequeue: fail,
      depth: fail,
    });
    return broken;
  }

  it("still leases, and writes every heartbeat to Mongo, with Redis down", async () => {
    signals = brokenSignals();
    const s = scheduler();
    const hold = gate();
    let boxId = "";
    const pending = s.withLease(run(), async lease => {
      boxId = lease.boxId;
      await hold.opened;
    });
    await vi.advanceTimersByTimeAsync(0);
    const started = box(boxId).heartbeatAt?.getTime() ?? 0;
    await vi.advanceTimersByTimeAsync(5 * BOX_LEASE_DEFAULTS.heartbeatMs);

    expect(box(boxId).heartbeatAt?.getTime()).toBeGreaterThan(started);
    hold.open();
    await pending;
    expect(box(boxId).state).toBe("idle");
  });

  it("kills nothing for heartbeat age when the beats cannot be read", async () => {
    const s = scheduler();
    const held = await s.acquire(run());
    vi.setSystemTime(Date.now() + 3 * BOX_LEASE_DEFAULTS.heartbeatTimeoutMs);
    const reaper = new BoxScheduler({
      store,
      signals: brokenSignals(),
      provider,
      metrics,
      config: BOX_LEASE_DEFAULTS,
    });

    const summary = await reaper.reap();
    expect(summary.killed).toEqual({});
    expect(box(held.box.boxId).state).toBe("leased");
  });

  it("still enforces the per-connection cap without the queue", async () => {
    signals = brokenSignals();
    const s = scheduler({ maxPerConnection: 2 });
    const hold = gate();
    const runs = [1, 2, 3].map(() => s.withLease(run(), () => hold.opened));
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    expect(await store.countLeased(boxKey("conn-a", "hash-1"))).toBe(2);
    hold.open();
    await vi.advanceTimersByTimeAsync(2 * SECOND);
    await Promise.all(runs);
  });
});

describe("account ceiling across instances", () => {
  it("lets two API instances with the same stale count start one box between them", async () => {
    // 17 app sessions, limit 20 - 2 = 18: exactly one connector box fits.
    provider.account.appSessions = 17;
    provider.countRunning.mockImplementation(async () => 17);
    const config = { accountCeiling: 20, appReserve: 2 };
    const a = scheduler(config);
    const b = scheduler(config);
    const hold = gate();
    const runs = [
      a.withLease(run({ connectionId: "conn-a" }), () => hold.opened),
      b.withLease(run({ connectionId: "conn-b" }), () => hold.opened),
      a.withLease(run({ connectionId: "conn-c" }), () => hold.opened),
      b.withLease(run({ connectionId: "conn-d" }), () => hold.opened),
    ].map(p => p.catch(() => "gave up"));
    await vi.advanceTimersByTimeAsync(3 * SECOND);

    expect(provider.lease).toHaveBeenCalledTimes(1);
    hold.open();
    await vi.advanceTimersByTimeAsync(BOX_LEASE_DEFAULTS.queueWaitMs);
    await Promise.all(runs);
  });

  it("remembers a failed count for the TTL instead of listing every poll", async () => {
    provider.account.fail = true;
    const s = scheduler({
      accountCountTtlMs: 5 * SECOND,
      queueWaitMs: 4 * SECOND,
    });
    const failed = expect(
      s.withLease(run(), async () => undefined),
    ).rejects.toThrow(/No connector box/);
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    await failed;
    // 4 s of polling every 250 ms is 16 polls; one count covers them all.
    expect(provider.countRunning).toHaveBeenCalledTimes(1);
  });
});

describe("queue", () => {
  it("puts a dropped waiter back at its original place", async () => {
    const q = new MemoryBoxSignals();
    const first = { runId: "r1", priority: 1, enqueuedAt: 1 };
    const second = { runId: "r2", priority: 1, enqueuedAt: 2 };
    await q.enqueue("k", first, 1);
    await q.enqueue("k", second, 60_000);
    vi.setSystemTime(Date.now() + 10);
    // r2 sees r1 dead and drops it...
    expect(await q.isHead("k", "r2")).toBe(true);
    // ...then r1, merely slow, comes back and is first again.
    await q.ensure("k", first, 60_000);
    expect(await q.isHead("k", "r1")).toBe(true);
    expect(await q.isHead("k", "r2")).toBe(false);
  });
});

describe("snapshot leaks", () => {
  it("never snapshots a one-off box", async () => {
    const s = scheduler();
    await s.withLease(run({ connectionId: "unsaved:x", oneOff: true }), lease =>
      lease.snapshotPristine("rt-1"),
    );
    expect(provider.snapshot).not.toHaveBeenCalled();
  });

  it("deletes a snapshot that finished after its claim was dropped", async () => {
    const s = scheduler();
    provider.snapshot.mockImplementationOnce(async (_box, name) => {
      store.templates.clear();
      return `snap:${name}`;
    });
    await s.withLease(run(), lease => lease.snapshotPristine("rt-1"));
    expect(provider.deleteSnapshot).toHaveBeenCalledWith(
      expect.stringMatching(/^snap:mako-cbox-/),
    );
    expect(store.templates.size).toBe(0);
  });

  it("parks a snapshot whose delete failed, and the reaper deletes it later", async () => {
    const s = scheduler();
    const key = `${boxKey("conn-a", "hash-1")}:rt-1`;
    await store.claimTemplate(key, new Date());
    await store.completeTemplate(key, "snap:broken");
    provider.failTemplate.add("snap:broken");
    provider.deleteSnapshot.mockRejectedValueOnce(new Error("E2B 500"));

    await s.withLease(run(), async () => undefined);

    // Not restorable under the key, but still on record for the sweep.
    expect(await store.getTemplate(key)).toBeNull();
    expect([...store.templates.keys()]).toEqual([`${key}#dead:snap:broken`]);
    const summary = await s.reap();
    expect(summary.templatesDeleted).toBe(1);
    expect(provider.deleteSnapshot).toHaveBeenLastCalledWith("snap:broken");
    expect(store.templates.size).toBe(0);
  });
});
