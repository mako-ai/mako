/**
 * Per-app origins: published apps served from `<appId>.<apps domain>`
 * (apps.md §30), so the browser's HTTP cache works for them.
 *
 * Why. A published app runs in an iframe sandboxed WITHOUT
 * `allow-same-origin`, because its bytes come from Mako's own origin and that
 * flag would hand AI-written code app.mako.ai's cookies, DOM and storage. The
 * price is an opaque origin, and Chromium gives an opaque-origin frame a
 * transient network isolation key: nothing it fetches is ever read from or
 * written to the HTTP cache. Every open of every app re-downloads the 6 MB
 * DuckDB WASM, the bundle and every parquet.
 *
 * The fix is the Google/GitHub user-content pattern: serve the app from a
 * registrable domain that is not mako.ai, one hostname per app, and frame it
 * WITH `allow-same-origin`. The frame then has a real origin (cacheable), and
 * that origin is foreign to Mako, so it still holds none of Mako's cookies,
 * storage or DOM. One hostname per app keeps apps isolated from each other:
 * two apps open side by side are different origins and cannot reach into
 * each other's frames or storage.
 *
 * `APPS_ORIGIN_BASE` (e.g. `https://makousercontent.com`) turns it on. Unset = off:
 * the view token keeps its relative, opaque-origin URL exactly as before.
 *
 * Rules that must hold, each pinned by app-origin.test.ts:
 * - The apps domain must NOT be a subdomain of Mako's (same-site would send
 *   SameSite=Lax session cookies on requests the app makes to Mako).
 * - An app host serves ONE thing: that app's published files under a token
 *   minted for that app. Every other path, and any token for another app,
 *   is a 404 (apps-host-gate.ts).
 * - App hosts may be framed by Mako only (CSP frame-ancestors).
 */

import { loggers } from "../logging";

const logger = loggers.api("app-origin");

/** Hostname label for an app: its Mongo id (24 lowercase hex). */
const APP_LABEL = /^[0-9a-f]{24}$/;

export interface AppOriginConfig {
  /** `https:` or `http:` (http only makes sense on a laptop). */
  protocol: string;
  /** The apps domain, lowercase, no port: `makousercontent.com`. */
  hostname: string;
  /** Port suffix including the colon, or "" for the default port. */
  port: string;
}

function parseBase(raw: string | undefined): AppOriginConfig | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname || url.hostname.includes("*")) return null;
  return {
    protocol: url.protocol,
    hostname: url.hostname.toLowerCase(),
    port: url.port ? `:${url.port}` : "",
  };
}

/**
 * The last two DNS labels: a cheap stand-in for the registrable domain. It
 * errs on the side of calling two hosts the same site (`a.co.uk` and
 * `b.co.uk` match), which is the safe direction for a check that refuses.
 */
function roughSite(hostname: string): string {
  return hostname.toLowerCase().split(".").slice(-2).join(".");
}

let warnedSameSite = false;

/**
 * The configured apps origin, or null when the feature is off. Refuses a
 * base on the same site as CLIENT_URL: a mako.ai subdomain would make app
 * code same-site with the control plane.
 */
export function appOriginConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppOriginConfig | null {
  const config = parseBase(env.APPS_ORIGIN_BASE);
  if (!config) return null;
  const client = env.CLIENT_URL ? safeUrl(env.CLIENT_URL) : null;
  if (client && roughSite(client.hostname) === roughSite(config.hostname)) {
    if (!warnedSameSite) {
      warnedSameSite = true;
      logger.warn(
        "APPS_ORIGIN_BASE is on the same site as CLIENT_URL; per-app origins stay OFF. Use a separate registrable domain.",
        { appsDomain: config.hostname, clientHost: client.hostname },
      );
    }
    return null;
  }
  return config;
}

function safeUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** `https://<appId>.makousercontent.com`, or null when off or the id is unusable. */
export function appOriginFor(
  appId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const config = appOriginConfig(env);
  const label = appId.toLowerCase();
  if (!config || !APP_LABEL.test(label)) return null;
  return `${config.protocol}//${label}.${config.hostname}${config.port}`;
}

/**
 * The host the browser asked for. Behind Cloudflare the Worker rewrites
 * `Host` to the run.app origin and carries the public one in
 * X-Forwarded-Host. Trusting it is safe here because being an app host
 * only ever RESTRICTS what a request may reach.
 */
export function requestHost(header: (name: string) => string | undefined) {
  const forwarded = header("x-forwarded-host")?.split(",")[0]?.trim();
  return (forwarded || header("host") || "").toLowerCase();
}

/**
 * The app id an app host names, or null for any other host (app.mako.ai,
 * run.app, localhost). `host` may carry a port; it must match the base's.
 */
export function appIdFromHost(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const config = appOriginConfig(env);
  if (!config || !host) return null;
  const lower = host.toLowerCase();
  const suffix = `.${config.hostname}${config.port}`;
  if (!lower.endsWith(suffix)) return null;
  const label = lower.slice(0, -suffix.length);
  return APP_LABEL.test(label) ? label : null;
}

/**
 * Who may frame an app host: Mako's own client origin, plus any extra
 * origins an operator lists (space-separated) in APPS_ORIGIN_FRAME_ANCESTORS.
 */
export function appFrameAncestors(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const origins = new Set<string>();
  const client = env.CLIENT_URL ? safeUrl(env.CLIENT_URL) : null;
  if (client) origins.add(client.origin);
  for (const extra of (env.APPS_ORIGIN_FRAME_ANCESTORS ?? "").split(/\s+/)) {
    const url = extra ? safeUrl(extra) : null;
    if (url) origins.add(url.origin);
  }
  // No client origin known: allow no framing at all rather than any.
  return origins.size ? [...origins].join(" ") : "'none'";
}

// ── Stable URLs ──────────────────────────────────────────────────────────
//
// A cache hit needs the SAME URL twice. Two URLs in the app path change on
// every request today: the view token (its expiry is "now + 30 min") and the
// signed bucket URL a parquet 302 points at (its expiry is "now + 10 min").
// Both become a pure function of a time window: everything minted within one
// window is byte-identical, so a reopen within the window is a cache hit.

const HOUR_S = 60 * 60;

function seconds(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 60 ? Math.floor(value) : fallback;
}

/** How long one view-token URL stays the same. Default 1 h. */
export function tokenWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return seconds(env.APPS_ORIGIN_TOKEN_WINDOW_SECONDS, HOUR_S) * 1000;
}

/**
 * How long one signed parquet URL stays the same. Default 6 h. Longer than
 * the token window on purpose: a parquet is MBs, a bundle is KBs. Capped at
 * 6 days (GCS V4 allows 7) so the window plus its grace stays signable.
 */
export function signedUrlWindowMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    Math.min(
      seconds(env.APPS_STABLE_SIGNED_URL_WINDOW_SECONDS, 6 * HOUR_S),
      6 * 24 * HOUR_S,
    ) * 1000
  );
}

/** The fixed window `now` falls in: [start, end). */
export function stableWindow(
  now: number,
  windowMs: number,
): { start: number; end: number } {
  const start = Math.floor(now / windowMs) * windowMs;
  return { start, end: start + windowMs };
}
