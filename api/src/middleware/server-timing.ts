/**
 * Per-request step timings: a `Server-Timing` header the browser's network
 * panel shows, and one structured log line per slow request with the same
 * spans — so "where did the 7 seconds go" is answered from the response or
 * from Cloud Logging, not from guesses.
 *
 * Service code wraps a step in `timed("name", () => work)`; outside a timed
 * request (jobs, tests) that is a plain call. Spans of the same name add up
 * (`git.revParse` called three times is one span with `n=3`). The loop
 * share (`elu`) is how busy the event loop was while the request ran: near
 * 1 means the time went to synchronous work (ours or a neighbour request's),
 * not to waiting on Mongo, git or GitHub.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { Context, Next } from "hono";
import { loggers } from "../logging";

const logger = loggers.api("server-timing");

interface Span {
  ms: number;
  n: number;
}

export class RequestTimings {
  readonly spans = new Map<string, Span>();
  readonly notes = new Map<string, string>();

  add(name: string, ms: number): void {
    const s = this.spans.get(name);
    if (s) {
      s.ms += ms;
      s.n += 1;
    } else this.spans.set(name, { ms, n: 1 });
  }

  /** A fact about the request (`cache=hit`), carried as a zero span. */
  note(name: string, value: string): void {
    this.notes.set(name, value);
  }

  header(totalMs: number, elu: number): string {
    const parts: string[] = [];
    for (const [name, s] of this.spans) {
      parts.push(
        `${token(name)};dur=${s.ms.toFixed(1)}${s.n > 1 ? `;desc="n=${s.n}"` : ""}`,
      );
    }
    for (const [name, value] of this.notes) {
      parts.push(`${token(name)};desc="${value.replace(/["\\]/g, "")}"`);
    }
    parts.push(`elu;desc="${elu.toFixed(2)}"`);
    parts.push(`total;dur=${totalMs.toFixed(1)}`);
    return parts.join(", ");
  }

  toLog(): Record<string, number | string> {
    const out: Record<string, number | string> = {};
    for (const [name, s] of this.spans) {
      out[name] = Math.round(s.ms);
      if (s.n > 1) out[`${name}.n`] = s.n;
    }
    for (const [name, value] of this.notes) out[name] = value;
    return out;
  }
}

const token = (name: string) => name.replace(/[^A-Za-z0-9_.-]/g, "_");

const storage = new AsyncLocalStorage<RequestTimings>();

/** The current request's timings, if it is being timed. */
export function currentTimings(): RequestTimings | undefined {
  return storage.getStore();
}

/** Time `fn` as a span of the current request (a plain call otherwise). */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const timings = storage.getStore();
  if (!timings) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timings.add(name, performance.now() - start);
  }
}

/** Run `fn` as a timed request (tests; the middleware does this per route). */
export function runWithTimings<T>(timings: RequestTimings, fn: () => T): T {
  return storage.run(timings, fn);
}

/** Record a fact about how the current request was served. */
export function noteTiming(name: string, value: string): void {
  storage.getStore()?.note(name, value);
}

/** Requests at least this slow log their spans at info. */
const LOG_THRESHOLD_MS = 300;

/**
 * Time the routes it wraps: Server-Timing on the response, and a
 * "Request timing" log line (spans, loop share) when slow.
 */
export function serverTiming(label: string) {
  return async (c: Context, next: Next) => {
    const timings = new RequestTimings();
    const start = performance.now();
    const elu0 = performance.eventLoopUtilization();
    await storage.run(timings, () => next());
    const total = performance.now() - start;
    const elu = performance.eventLoopUtilization(elu0).utilization;
    try {
      c.res.headers.set("Server-Timing", timings.header(total, elu));
    } catch {
      // An immutable (streamed/proxied) response keeps its own headers.
    }
    const fields = {
      route: label,
      totalMs: Math.round(total),
      elu: Math.round(elu * 100) / 100,
      ...timings.toLog(),
    };
    if (total >= LOG_THRESHOLD_MS) logger.info("Request timing", fields);
    else logger.debug("Request timing", fields);
  };
}
