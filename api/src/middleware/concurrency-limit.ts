import type { Context, Next } from "hono";
import { repoCloneInProgress } from "../apps/cloud-repo/clone-state";
import { loggers } from "../logging";

const logger = loggers.api("concurrency-limit");

/**
 * A per-instance bulkhead for routes whose cost is a subprocess or a sandbox
 * round trip rather than a database read.
 *
 * Cloud Run sizes an instance by request concurrency (80), but 80 concurrent
 * git walks on one vCPU do not finish 80x slower — they starve the UI,
 * webhooks and Inngest steps sharing the instance until Cloud Run answers
 * "no available instance" for all of them (2026-10-19). A pool caps how many
 * such requests one instance runs at once; a request that cannot get a slot
 * within `maxWaitMs` is refused with 503 + Retry-After, which the client can
 * retry, instead of queuing until it times out.
 *
 * Pools are named so routes sharing a resource share a cap.
 */
export interface ConcurrencyPoolOptions {
  name: string;
  /** Requests of this pool running at once on this instance. */
  max: number;
  /** How long a request may wait for a slot before it is refused. */
  maxWaitMs: number;
}

export interface ConcurrencyPool {
  readonly name: string;
  /** Resolves with a release function, or null when no slot freed in time. */
  acquire(): Promise<(() => void) | null>;
  readonly active: number;
  readonly waiting: number;
}

export function createConcurrencyPool(
  options: ConcurrencyPoolOptions,
): ConcurrencyPool {
  let active = 0;
  const queue: Array<(release: (() => void) | null) => void> = [];

  const release = () => {
    const next = queue.shift();
    if (next) {
      // Hand the slot straight to the next waiter: `active` is unchanged.
      next(once());
      return;
    }
    active--;
  };
  const once = () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
    };
  };

  return {
    name: options.name,
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
    acquire() {
      if (active < options.max) {
        active++;
        return Promise.resolve(once());
      }
      return new Promise(resolve => {
        const waiter = (r: (() => void) | null) => {
          clearTimeout(timer);
          resolve(r);
        };
        const timer = setTimeout(() => {
          const i = queue.indexOf(waiter);
          if (i >= 0) queue.splice(i, 1);
          resolve(null);
        }, options.maxWaitMs);
        queue.push(waiter);
      });
    },
  };
}

function busy(c: Context): Response {
  return c.json(
    {
      success: false,
      error: "This server is busy; retry in a moment.",
    },
    { status: 503, headers: { "Retry-After": "2" } },
  );
}

export interface ConcurrencyLimitOptions {
  /**
   * Refuse at once (503 + Retry-After), without waiting for a slot, when
   * this says the request would only queue behind slow work: a clone of
   * the workspace repo in progress (2026-11-16: waiters held the pool for
   * 10 s and then failed anyway).
   */
  shedWhen?: (c: Context) => boolean;
}

/** Hono middleware running the request inside `pool`. */
export function concurrencyLimit(
  pool: ConcurrencyPool,
  options: ConcurrencyLimitOptions = {},
) {
  return async (c: Context, next: Next) => {
    if (options.shedWhen?.(c)) {
      logger.warn("Repo clone in progress; refusing request", {
        pool: pool.name,
        path: c.req.path,
      });
      return busy(c);
    }
    const release = await pool.acquire();
    if (!release) {
      logger.warn("Concurrency pool full; refusing request", {
        pool: pool.name,
        path: c.req.path,
        active: pool.active,
        waiting: pool.waiting,
      });
      return busy(c);
    }
    try {
      await next();
    } finally {
      release();
    }
  };
}

/**
 * Git subprocess work on the workspace repo, and the sandbox round trips that
 * read a working copy (apps files/status, workspace repo status). Generous:
 * at normal load an instance runs well under one of these at a time; this is
 * a ceiling for herds, not a throttle.
 */
export const repoWorkPool = createConcurrencyPool({
  name: "repo-work",
  max: 12,
  maxWaitMs: 10_000,
});

/**
 * For the repo-work routes: refuse at once while this instance clones the
 * request's workspace repo. The clone takes 11 to 14 s on a new instance;
 * a waiter would hold its place for 10 s and fail anyway.
 */
export const shedWhileCloning: ConcurrencyLimitOptions = {
  shedWhen: c => {
    const workspaceId = c.req.param("workspaceId");
    return Boolean(workspaceId && repoCloneInProgress(workspaceId));
  },
};
