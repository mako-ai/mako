import { createHash } from "node:crypto";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { Redis } from "ioredis";
import { sessionManager } from "../auth/session";
import { loggers } from "../logging";
import { BASE_REDIS_OPTIONS } from "../utils/redis";

const logger = loggers.api("rate-limit");

/**
 * Per-caller request budget for the whole API.
 *
 * Until this, only the auth routes were limited, so one browser tab in a loop,
 * a runaway agent or a five-line script could take the service down: Cloud
 * Run's own "no available instance" 429 was the only ceiling, and it refuses
 * everyone (2026-10-19). This charges each caller a COST per request — a git
 * walk or a sandbox round trip is worth more than a Mongo read — against a
 * per-minute budget shared by every instance through Redis.
 *
 * Runs before auth, so the caller is keyed by a hash of what identifies it
 * (session cookie, bearer token, else client IP) rather than a user id: no
 * database lookup on the hot path, and an unauthenticated flood is limited
 * too. The key is hashed — a token never lands in Redis or a log.
 *
 * `API_RATE_LIMIT_MODE`: `shadow` (default) logs who WOULD be refused,
 * `enforce` refuses with 429 + Retry-After, `off` disables. Ship in shadow,
 * read the logs, then enforce.
 */

export type RateLimitMode = "off" | "shadow" | "enforce";

export function rateLimitMode(): RateLimitMode {
  const mode = process.env.API_RATE_LIMIT_MODE;
  return mode === "off" || mode === "enforce" ? mode : "shadow";
}

const WINDOW_MS = 60_000;

/** Cost units per caller per minute. */
export function rateLimitBudget(): number {
  const parsed = Number(process.env.API_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1200;
}

/**
 * Callers that are not people and already have their own guard: Inngest
 * (signed, and its steps must never be refused mid-run), provider webhooks
 * (refusing one drops a CDC event), and health probes.
 */
const EXEMPT_PREFIXES = ["/api/inngest", "/api/webhooks/", "/health"];

/** Ordered: first match wins. Everything else costs 1. */
const ROUTE_COSTS: Array<[RegExp, number]> = [
  [/^\/api\/workspaces\/[^/]+\/apps\/[^/]+\/branches$/, 5],
  [/^\/api\/workspaces\/[^/]+\/apps\/[^/]+\/(files|status|file)$/, 3],
  [/^\/api\/workspaces\/[^/]+\/repo\/(status|branches)$/, 3],
  [/^\/api\/workspaces\/[^/]+\/execute/, 3],
  [/^\/api\/agent\/chat/, 5],
  [/^\/api\/mcp/, 2],
];

export function routeCost(path: string): number {
  for (const [pattern, cost] of ROUTE_COSTS) {
    if (pattern.test(path)) return cost;
  }
  return 1;
}

export interface Caller {
  key: string;
  kind: "session" | "bearer" | "ip";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function callerOf(c: Context): Caller {
  const auth = c.req.header("authorization");
  if (auth) return { key: `b:${hash(auth)}`, kind: "bearer" };
  const session = getCookie(c, sessionManager.sessionCookieName);
  if (session) return { key: `s:${hash(session)}`, kind: "session" };
  // Behind Cloudflare the client is cf-connecting-ip; x-forwarded-for's
  // first hop otherwise.
  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  return { key: `i:${hash(ip)}`, kind: "ip" };
}

// ---------------------------------------------------------------------------
// Counter store: Redis when configured (shared across instances), else
// in-process. Fail OPEN: a Redis blip must never turn into refused requests.
// ---------------------------------------------------------------------------

interface CounterStore {
  /** Add `cost` to `key`'s window and return the window's total. */
  add(key: string, cost: number, ttlMs: number): Promise<number>;
}

function memoryStore(): CounterStore {
  const counters = new Map<string, { total: number; expiresAt: number }>();
  let lastSweep = Date.now();
  return {
    async add(key, cost, ttlMs) {
      const now = Date.now();
      if (now - lastSweep > WINDOW_MS) {
        lastSweep = now;
        for (const [k, v] of counters) {
          if (v.expiresAt <= now) counters.delete(k);
        }
      }
      const hit = counters.get(key);
      if (!hit || hit.expiresAt <= now) {
        counters.set(key, { total: cost, expiresAt: now + ttlMs });
        return cost;
      }
      hit.total += cost;
      return hit.total;
    },
  };
}

function redisStore(url: string): CounterStore {
  const redis = new Redis(url, {
    ...BASE_REDIS_OPTIONS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
  });
  redis.on("error", error =>
    logger.warn("Rate limit redis error", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return {
    async add(key, cost, ttlMs) {
      // Keys are per window, so refreshing the TTL on every hit is harmless —
      // and plain PEXPIRE (not NX) works on any Redis version.
      const [[, total]] = (await redis
        .multi()
        .incrby(key, cost)
        .pexpire(key, ttlMs)
        .exec()) as [[Error | null, number], unknown];
      return total;
    },
  };
}

let store: CounterStore | null = null;
function getStore(): CounterStore {
  if (!store) {
    store = process.env.REDIS_URL
      ? redisStore(process.env.REDIS_URL)
      : memoryStore();
  }
  return store;
}

/** Test seam: rebuild the store (memory mode) on next use. */
export function resetRateLimitForTests(): void {
  store = null;
  shadowLogged.clear();
}

// Shadow mode logs a caller once per window, not once per request.
const shadowLogged = new Set<string>();

export async function apiRateLimitMiddleware(c: Context, next: Next) {
  const mode = rateLimitMode();
  const path = c.req.path;
  if (
    mode === "off" ||
    !path.startsWith("/api/") ||
    EXEMPT_PREFIXES.some(p => path.startsWith(p))
  ) {
    return next();
  }

  const caller = callerOf(c);
  const cost = routeCost(path);
  const windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const windowKey = `ratelimit:api:${caller.key}:${windowStart}`;
  let total: number;
  try {
    total = await getStore().add(windowKey, cost, WINDOW_MS);
  } catch {
    return next();
  }

  const budget = rateLimitBudget();
  if (total <= budget) return next();

  const retryAfter = Math.max(
    1,
    Math.ceil((windowStart + WINDOW_MS - Date.now()) / 1000),
  );
  if (mode === "shadow") {
    if (!shadowLogged.has(windowKey)) {
      shadowLogged.add(windowKey);
      if (shadowLogged.size > 10_000) shadowLogged.clear();
      logger.warn("Rate limit exceeded (shadow: not refused)", {
        caller: caller.key,
        callerKind: caller.kind,
        path,
        total,
        budget,
      });
    }
    return next();
  }
  logger.warn("Rate limit exceeded; refusing request", {
    caller: caller.key,
    callerKind: caller.kind,
    path,
    total,
    budget,
  });
  return c.json(
    { success: false, error: "Too many requests; slow down and retry." },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}
