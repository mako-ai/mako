/**
 * One request at a time per API key, with a pause after each.
 *
 * Several flows may use the same key at once, and the connection proxy
 * (connections/proxy.service.ts) uses it too; without coordination they
 * blast the vendor's shared rate-limit bucket and trigger 429s. Each key has
 * one gate: a request waits its turn, runs, and the gate stays closed for
 * that request's `minDelayMs` after it completes.
 *
 * Two lanes: sync first. When the gate opens, a waiting sync request goes
 * before a waiting proxy request; within a lane, first come first served.
 * The gate lives in this process only.
 */

export type RateGateLane = "sync" | "proxy";

interface Job {
  run: () => Promise<void>;
}

interface Gate {
  busy: boolean;
  sync: Job[];
  proxy: Job[];
}

const gates = new Map<string, Gate>();

function gateFor(key: string): Gate {
  let gate = gates.get(key);
  if (!gate) {
    gate = { busy: false, sync: [], proxy: [] };
    gates.set(key, gate);
  }
  return gate;
}

function pump(key: string, gate: Gate): void {
  if (gate.busy) return;
  const job = gate.sync.shift() ?? gate.proxy.shift();
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
 * Resolves or rejects with `fn`'s own result.
 */
export function throttledRequest<T>(
  key: string,
  fn: () => Promise<T>,
  minDelayMs: number,
  lane: RateGateLane = "sync",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const gate = gateFor(key);
    gate[lane].push({
      run: async () => {
        try {
          resolve(await fn());
        } catch (error) {
          reject(error);
        } finally {
          await new Promise(r => setTimeout(r, minDelayMs));
        }
      },
    });
    // Started on a later tick, as a promise chain would: the caller's
    // synchronous code finishes first.
    queueMicrotask(() => pump(key, gate));
  });
}
