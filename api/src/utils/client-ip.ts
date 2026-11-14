import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

/**
 * Who is calling, by network address — for rate limiting and audit only.
 *
 * Request headers are client-controlled unless a proxy we trust rewrites
 * them, so the order matters:
 *
 *   1. `cf-connecting-ip` — production is Cloudflare-fronted and Cloudflare
 *      overwrites this header on every request it proxies, so a client value
 *      never survives the edge. (A caller that skips the edge and hits the
 *      run.app URL directly can forge it; `edgeOriginMiddleware` exists to
 *      refuse those requests once enforced.)
 *   2. `x-forwarded-for`, read from the RIGHT: each proxy APPENDS the address
 *      it saw, so the entries a client typed itself are on the left and the
 *      last {@link trustedProxyHops} entries were written by our own
 *      infrastructure. Taking the first entry — what this code used to do —
 *      lets a client pick a fresh rate-limit bucket per request.
 *   3. The TCP peer address of the socket.
 */

/**
 * How many proxies in front of the API append to `x-forwarded-for`.
 * Cloud Run's front end appends exactly one entry (the address that
 * connected to it), hence the default.
 */
export function trustedProxyHops(): number {
  const parsed = Number(process.env.TRUSTED_PROXY_HOPS);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
}

/** The socket's peer address, or undefined when there is no socket (tests). */
export function socketRemoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address || undefined;
  } catch {
    return undefined;
  }
}

export function clientIp(c: Context): string {
  const cf = c.req.header("cf-connecting-ip")?.trim();
  if (cf) return cf;

  const hops = trustedProxyHops();
  const xff = c.req.header("x-forwarded-for");
  if (xff && hops > 0) {
    const entries = xff
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    if (entries.length > 0) {
      // Fewer entries than proxies means the chain is shorter than configured;
      // the left-most entry is then the closest thing to a trusted value.
      return entries[Math.max(0, entries.length - hops)];
    }
  }

  return socketRemoteAddress(c) ?? "unknown";
}

/** 127.0.0.0/8, ::1 and their IPv4-mapped IPv6 forms. */
export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase();
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice("::ffff:".length) : a;
  return /^127(\.\d{1,3}){3}$/.test(v4);
}
