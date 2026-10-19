import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { loggers } from "../logging";

const logger = loggers.api("edge-origin");

/**
 * Requests must come through Cloudflare.
 *
 * The Cloud Run service is `--allow-unauthenticated` and its *.run.app URL
 * answers directly, so every Cloudflare protection (rate-limit rules, WAF,
 * bot fight) is one hostname away from being skipped. Cloudflare adds a
 * secret header to every request it proxies (a Transform Rule setting
 * `x-mako-edge`), and the origin checks it.
 *
 * `EDGE_ORIGIN_SECRET` unset → off. Set → `EDGE_ORIGIN_CHECK=shadow`
 * (default: log what arrives without the header, refuse nothing) or
 * `enforce` (403). Exempt: Inngest, which is configured to call the run.app
 * URL directly and is signed; health probes.
 */
const HEADER = "x-mako-edge";
const EXEMPT_PREFIXES = ["/api/inngest", "/health"];

function secret(): string | undefined {
  return process.env.EDGE_ORIGIN_SECRET || undefined;
}

function enforcing(): boolean {
  return process.env.EDGE_ORIGIN_CHECK === "enforce";
}

function matches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Shadow logging is sampled: one line per path prefix per minute.
const lastLogged = new Map<string, number>();

export async function edgeOriginMiddleware(c: Context, next: Next) {
  const expected = secret();
  const path = c.req.path;
  if (!expected || EXEMPT_PREFIXES.some(p => path.startsWith(p))) {
    return next();
  }
  if (matches(c.req.header(HEADER), expected)) return next();

  const prefix = path.split("/").slice(0, 3).join("/") || "/";
  const now = Date.now();
  if (now - (lastLogged.get(prefix) ?? 0) > 60_000) {
    lastLogged.set(prefix, now);
    logger.warn("Request reached the origin without passing the edge", {
      path,
      host: c.req.header("host"),
      userAgent: c.req.header("user-agent"),
      enforced: enforcing(),
    });
  }
  if (!enforcing()) return next();
  return c.json({ success: false, error: "Forbidden" }, 403);
}
