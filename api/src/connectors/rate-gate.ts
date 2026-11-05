/**
 * One request at a time per API key, with a pause after each.
 *
 * Several flows may use the same key at once, and the connection proxy
 * (connections/proxy.service.ts) uses it too; without coordination they
 * blast the vendor's shared rate-limit bucket and trigger 429s. Each key has
 * one gate: a request waits its turn, runs, and the gate stays closed for
 * that request's `minDelayMs` after it completes.
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
}

interface Gate {
  busy: boolean;
  sync: Job[];
  proxy: Job[];
  /** Sync requests run since the last proxy request. */
  syncStreak: number;
}

const gates = new Map<string, Gate>();

function gateFor(key: string): Gate {
  let gate = gates.get(key);
  if (!gate) {
    gate = { busy: false, sync: [], proxy: [], syncStreak: 0 };
    gates.set(key, gate);
  }
  return gate;
}

function next(gate: Gate): Job | undefined {
  const proxyTurn =
    gate.proxy.length > 0 &&
    (gate.sync.length === 0 || gate.syncStreak >= PROXY_TURN_AFTER);
  if (proxyTurn) {
    gate.syncStreak = 0;
    return gate.proxy.shift();
  }
  const job = gate.sync.shift();
  if (job) gate.syncStreak += 1;
  return job;
}

function pump(key: string, gate: Gate): void {
  if (gate.busy) return;
  const job = next(gate);
  if (!job) {
    gates.delete(key);
    return;
  }
  gate.busy = true;
  void job.run().finally(() => {
    gate.busy = false;
    pump(key, gate);
  });
}

/**
 * Run `fn` when the gate of `key` opens, then keep it closed `minDelayMs`.
 * Resolves or rejects with `fn`'s own result; a proxy request still waiting
 * after `queueMs` rejects with RateGateBusyError, and one whose `signal`
 * aborts while waiting rejects with the signal's reason.
 */
export function throttledRequest<T>(
  key: string,
  fn: () => Promise<T>,
  minDelayMs: number,
  lane: RateGateLane = "sync",
  {
    signal,
    queueMs = lane === "proxy" ? PROXY_QUEUE_MS : undefined,
  }: { signal?: AbortSignal; queueMs?: number } = {},
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
    };
    const onAbort = () => leave(signal?.reason);
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const job: Job = {
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
