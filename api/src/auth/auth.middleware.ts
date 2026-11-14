import { createHash } from "node:crypto";
import { Context, Next } from "hono";
import { sessionManager, writeSessionCookie } from "./session";
import { getCookie } from "hono/cookie";
import { enrichContextWithUser, loggers } from "../logging";
import { clientIp } from "../utils/client-ip";
import { normalizeEmail } from "../utils/email.utils";
import { addToCounter, clearCounter } from "../middleware/rate-limit";

const logger = loggers.auth();

/**
 * Authentication middleware to validate session
 */
export async function authMiddleware(c: Context, next: Next) {
  const sessionId = getCookie(c, sessionManager.sessionCookieName);

  if (!sessionId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { session, user } = await sessionManager.validateSession(sessionId);

  if (!session || !user) {
    return c.json({ error: "Invalid session" }, 401);
  }

  // Store user in context
  c.set("user", user);
  c.set("session", session);

  // Slide the browser cookie whenever the session was refreshed so it tracks
  // the DB expiry instead of hard-expiring at the original login time.
  if (session.fresh) {
    writeSessionCookie(c, session.id);
  }

  // Enrich logging context with user ID
  enrichContextWithUser(user.id);

  await next();
}

/**
 * Optional auth middleware - doesn't require authentication but adds user to context if available
 */
export async function optionalAuthMiddleware(c: Context, next: Next) {
  const sessionId = getCookie(c, sessionManager.sessionCookieName);

  if (sessionId) {
    const { session, user } = await sessionManager.validateSession(sessionId);

    if (session && user) {
      c.set("user", user);
      c.set("session", session);

      // Slide the browser cookie whenever the session was refreshed.
      if (session.fresh) {
        writeSessionCookie(c, session.id);
      }

      // Enrich logging context with user ID
      enrichContextWithUser(user.id);
    }
  }

  await next();
}

// ---------------------------------------------------------------------------
// Rate limiting for auth endpoints
//
// Two independent budgets, and a request must fit in both:
//
//   - per client IP + path ({@link rateLimitMiddleware}) — the IP comes from
//     `clientIp`, which only trusts proxy-written headers. It used to be the
//     raw `x-forwarded-for`, so a fresh header per request was a fresh bucket.
//   - per ACCOUNT ({@link accountRateLimitMiddleware}) — keyed on the email in
//     the body, so rotating IPs (a botnet, or a forged header that slips past
//     the edge) cannot brute-force a 6-digit verification/reset code or one
//     account's password.
//
// Counters live in the shared rate-limit store (Redis when configured, so a
// brute force is counted across every instance). If that store errors, a
// per-instance map takes over rather than letting the request through
// uncounted.
// ---------------------------------------------------------------------------

const fallbackStore = new Map<string, { count: number; resetTime: number }>();

function fallbackAdd(key: string, windowMs: number, now: number): number {
  const record = fallbackStore.get(key);
  if (!record || record.resetTime < now) {
    fallbackStore.set(key, { count: 1, resetTime: now + windowMs });
    return 1;
  }
  record.count++;
  return record.count;
}

/** Count one attempt against `bucket`; returns the window total and reset. */
async function countAttempt(
  bucket: string,
  windowMs: number,
): Promise<{ total: number; key: string; resetAt: number }> {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = `ratelimit:auth:${bucket}:${windowStart}`;
  const resetAt = windowStart + windowMs;
  try {
    return { total: await addToCounter(key, 1, windowMs), key, resetAt };
  } catch (error) {
    logger.warn("Auth rate-limit store unavailable; counting per instance", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { total: fallbackAdd(key, windowMs, now), key, resetAt };
  }
}

async function clearAttempts(key: string): Promise<void> {
  fallbackStore.delete(key);
  try {
    await clearCounter(key);
  } catch {
    // Best effort: the window expires on its own.
  }
}

function tooManyRequests(c: Context, resetAt: number) {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  return c.json(
    { success: false, error: "Too many attempts. Please try again later." },
    { status: 429, headers: { "Retry-After": retryAfter.toString() } },
  );
}

function hashBucket(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/**
 * Per client IP + path limiter. Counts every request.
 */
export function rateLimitMiddleware(windowMs: number, maxRequests: number) {
  return async (c: Context, next: Next) => {
    const bucket = `ip:${hashBucket(clientIp(c))}:${c.req.path}`;
    const { total, resetAt } = await countAttempt(bucket, windowMs);
    if (total > maxRequests) {
      logger.warn("Auth rate limit exceeded (ip)", { path: c.req.path });
      return tooManyRequests(c, resetAt);
    }
    await next();
  };
}

/** The normalized `email` field of a JSON body, if there is one. */
async function emailFromBody(c: Context): Promise<string | null> {
  try {
    // Hono caches the parsed body, so the route validator and handler can
    // still read it after this.
    const body: unknown = await c.req.json();
    if (body && typeof body === "object" && "email" in body) {
      const email = (body as { email?: unknown }).email;
      if (typeof email === "string") {
        return normalizeEmail(email) || null;
      }
    }
  } catch {
    // Not JSON — the route's own validation rejects it.
  }
  return null;
}

export interface AccountRateLimitOptions {
  /**
   * Endpoints sharing a bucket share one budget per account. Every endpoint
   * that checks a 6-digit code uses the same bucket, so splitting guesses
   * across them does not multiply the attacker's budget.
   */
  bucket: string;
  windowMs: number;
  max: number;
  /**
   * Forget the account's count when the request succeeds (a correct
   * password/code). Only for endpoints whose success proves knowledge of the
   * secret — never for "send me a code", which always succeeds.
   */
  clearOnSuccess?: boolean;
}

/**
 * Per-account limiter, keyed on the request body's email. Attempts are
 * counted BEFORE the handler runs, so a parallel burst cannot outrun it.
 */
export function accountRateLimitMiddleware(options: AccountRateLimitOptions) {
  return async (c: Context, next: Next) => {
    const email = await emailFromBody(c);
    if (!email) return next();

    const bucket = `acct:${options.bucket}:${hashBucket(email)}`;
    const { total, key, resetAt } = await countAttempt(
      bucket,
      options.windowMs,
    );
    if (total > options.max) {
      logger.warn("Auth rate limit exceeded (account)", {
        path: c.req.path,
        bucket: options.bucket,
      });
      return tooManyRequests(c, resetAt);
    }

    await next();

    if (options.clearOnSuccess && c.res.status >= 200 && c.res.status < 300) {
      await clearAttempts(key);
    }
  };
}

/**
 * Clean up expired fallback records periodically. `unref` so the timer never
 * keeps a process (a test, a CLI) alive on its own.
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of fallbackStore.entries()) {
    if (record.resetTime < now) {
      fallbackStore.delete(key);
    }
  }
}, 60000).unref();
