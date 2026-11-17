/**
 * A bounded number of requests at a time per API key, with a pause after
 * each.
 *
 * Several flows, and several entities of one flow, may use the same key at
 * once, and the connection proxy (connections/proxy.service.ts) uses it too;
 * without coordination they blast the vendor's shared rate-limit bucket and
 * trigger 429s. Each key has one gate: a request waits its turn, runs, and
 * its slot stays taken for that request's `minDelayMs` after it completes.
 * A request starts only while fewer than its own `maxInFlight` (default 1)
 * and every running request's `maxInFlight` hold a slot: a one-slot request
 * runs alone, so a key whose callers all pass 1 runs one request at a time,
 * as it always did. A request that may not start yet holds the head of the
 * queue: nothing behind it overtakes it.
 *
 * Two lanes: sync first, but not forever. When the gate opens, a waiting
 * sync request goes before a waiting proxy request, except that after
 * PROXY_TURN_AFTER sync requests in a row the next waiting proxy request goes
 * first. Within a lane, first come first served. A proxy request waits at
 * most PROXY_QUEUE_MS for its turn, and leaves the queue when its signal
 * aborts. The gate lives in this process only.
 */

export type RateGateLane = "sync" | "proxy";

/** Sync requests in a row before a waiting proxy request gets a turn. */
const PROXY_TURN_AFTER = 4;
/** How long a proxy request waits for its turn before it is refused. */
const PROXY_QUEUE_MS = 30_000;

/** A request that waited too long for its turn. */
export class RateGateBusyError extends Error {
  constructor() {
    super(
      "Too many requests are waiting for this service's rate limit; try again shortly.",
    );
    this.name = "RateGateBusyError";
  }
}

interface Job {
  run: () => Promise<void>;
  /** Start only while fewer than this many requests hold a slot. */
  maxInFlight: number;
}

interface Gate {
  /** Requests running or in their pause. */
  inFlight: number;
  /** The `maxInFlight` of each of those requests. */
  limits: number[];
  sync: Job[];
  proxy: Job[];
  /** Sync requests run since the last proxy request. */
  syncStreak: number;
}

const gates = new Map<string, Gate>();

function gateFor(key: string): Gate {
  let gate = gates.get(key);
  if (!gate) {
    gate = { inFlight: 0, limits: [], sync: [], proxy: [], syncStreak: 0 };
    gates.set(key, gate);
  }
  return gate;
}

/** The lane whose head goes next, without taking it. */
function nextLane(gate: Gate): RateGateLane | undefined {
  const proxyTurn =
    gate.proxy.length > 0 &&
    (gate.sync.length === 0 || gate.syncStreak >= PROXY_TURN_AFTER);
  if (proxyTurn) return "proxy";
  return gate.sync.length > 0 ? "sync" : undefined;
}

function pump(key: string, gate: Gate): void {
  for (;;) {
    const lane = nextLane(gate);
    if (!lane) {
      if (gate.inFlight === 0 && gates.get(key) === gate) gates.delete(key);
      return;
    }
    const job = gate[lane][0];
    if (gate.inFlight >= Math.min(job.maxInFlight, ...gate.limits)) return;
    gate[lane].shift();
    gate.syncStreak = lane === "proxy" ? 0 : gate.syncStreak + 1;
    gate.inFlight += 1;
    gate.limits.push(job.maxInFlight);
    void job.run().finally(() => {
      gate.inFlight -= 1;
      gate.limits.splice(gate.limits.indexOf(job.maxInFlight), 1);
      pump(key, gate);
    });
  }
}

/**
 * Run `fn` when the gate of `key` has a slot for it, then keep that slot
 * `minDelayMs`. Resolves or rejects with `fn`'s own result; a proxy request
 * still waiting after `queueMs` rejects with RateGateBusyError, and one
 * whose `signal` aborts while waiting rejects with the signal's reason.
 */
export function throttledRequest<T>(
  key: string,
  fn: () => Promise<T>,
  minDelayMs: number,
  lane: RateGateLane = "sync",
  {
    signal,
    queueMs = lane === "proxy" ? PROXY_QUEUE_MS : undefined,
    maxInFlight = 1,
  }: { signal?: AbortSignal; queueMs?: number; maxInFlight?: number } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const gate = gateFor(key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const leave = (why: unknown) => {
      const queue = gate[lane];
      const at = queue.indexOf(job);
      if (at === -1) return;
      queue.splice(at, 1);
      cleanup();
      reject(why);
      // It may have held the head of the queue for a slot the next one fits.
      queueMicrotask(() => pump(key, gate));
    };
    const onAbort = () => leave(signal?.reason);
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const job: Job = {
      maxInFlight: Math.max(1, Math.floor(maxInFlight)),
      run: async () => {
        cleanup();
        try {
          resolve(await fn());
        } catch (error) {
          reject(error);
        } finally {
          await new Promise(r => setTimeout(r, minDelayMs));
        }
      },
    };
    gate[lane].push(job);
    if (queueMs !== undefined) {
      timer = setTimeout(() => leave(new RateGateBusyError()), queueMs);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    // Started on a later tick, as a promise chain would: the caller's
    // synchronous code finishes first.
    queueMicrotask(() => pump(key, gate));
  });
}
