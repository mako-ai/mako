import { Context, Next } from "hono";
import { sessionManager } from "./session";
import { getCookie } from "hono/cookie";

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
    }
  }

  await next();
}

/**
 * Rate limiting middleware for auth endpoints
 */
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

export function rateLimitMiddleware(windowMs: number, maxRequests: number) {
  return async (c: Context, next: Next) => {
    const ip =
      c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    const key = `${ip}:${c.req.path}`;
    const now = Date.now();

    const record = rateLimitStore.get(key);

    if (!record || record.resetTime < now) {
      rateLimitStore.set(key, {
        count: 1,
        resetTime: now + windowMs,
      });
    } else {
      record.count++;

      if (record.count > maxRequests) {
        const retryAfter = Math.ceil((record.resetTime - now) / 1000);
        return c.json(
          { error: "Too many requests" },
          {
            status: 429,
            headers: {
              "Retry-After": retryAfter.toString(),
            },
          },
        );
      }
    }

    await next();
  };
}

/**
 * Clean up expired rate limit records periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitStore.entries()) {
    if (record.resetTime < now) {
      rateLimitStore.delete(key);
    }
  }
}, 60000); // Clean up every minute
