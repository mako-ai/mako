/**
 * Local-development login shortcut.
 *
 * Typing a real password (or bouncing through an OAuth provider) on every
 * local restart is friction with no security value on a laptop. This lets a
 * single shared secret from `.env` stand in for any local user's password.
 *
 * It is OFF unless `DEV_LOGIN_PASSWORD` is set, and there are four INDEPENDENT
 * guards. Every one of them must hold; any single one failing disables the
 * shortcut completely:
 *
 *   1. `NODE_ENV !== "production"`.
 *   2. `DEV_LOGIN_PASSWORD` is set and at least {@link MIN_SECRET_LENGTH}
 *      characters — a short secret is treated as unset, never as "good enough".
 *   3. The request arrived on a loopback host (`localhost`, `127.0.0.1`, `::1`).
 *   4. The process REFUSES TO BOOT if `NODE_ENV=production` and the variable is
 *      set at all (see {@link assertDevLoginSafeAtBoot}) — a misconfiguration
 *      is a loud crash at startup, never a quietly weakened login.
 *
 * Guard 3 is the one that earns its keep. `NODE_ENV` comes from Cloud Run env
 * vars rather than the Dockerfile, so a deploy could in principle omit it; a
 * request to a deployed instance still arrives with `Host: pr-697.mako.ai` or
 * `app.mako.ai`, never a loopback address. Guards 1 and 3 therefore have to
 * fail *together* — in two different systems — before this is reachable, and
 * guard 4 makes the most likely single mistake fatal at boot.
 *
 * The shortcut deliberately reuses the ordinary `POST /api/auth/login` route
 * rather than adding an endpoint: no new surface to secure, no second code
 * path to keep in sync, and it works from the login form and from `curl`
 * alike.
 */
import { timingSafeEqual } from "node:crypto";
import { loggers } from "../logging";

const log = loggers.api("dev-login");

/**
 * Short enough to type, long enough that it is not worth guessing even in the
 * (guarded-against) world where this is somehow reachable off-localhost.
 */
export const MIN_SECRET_LENGTH = 12;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * The configured secret, or null when the shortcut is off for ANY reason —
 * unset, blank, too short, or running in production.
 */
export function devLoginSecret(): string | null {
  if (isProduction()) return null;
  const secret = process.env.DEV_LOGIN_PASSWORD?.trim();
  if (!secret) return null;
  if (secret.length < MIN_SECRET_LENGTH) {
    log.warn(
      "DEV_LOGIN_PASSWORD is set but shorter than the minimum; dev login stays DISABLED",
      { minLength: MIN_SECRET_LENGTH },
    );
    return null;
  }
  return secret;
}

/** True when `host` (an HTTP Host header, with or without a port) is loopback. */
export function isLoopbackHost(host: string | undefined | null): boolean {
  if (!host) return false;
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return false;
  let hostname: string;
  if (trimmed.startsWith("[")) {
    // Bracketed IPv6 literal, optionally with a port: "[::1]" / "[::1]:8080".
    const end = trimmed.indexOf("]");
    if (end === -1) return false;
    hostname = trimmed.slice(1, end);
  } else if (trimmed.indexOf(":") !== trimmed.lastIndexOf(":")) {
    // More than one colon and no brackets: a bare IPv6 literal such as "::1".
    // Invalid in a real Host header, but splitting it on ":" would silently
    // yield an empty hostname, so handle it explicitly rather than by accident.
    hostname = trimmed;
  } else {
    hostname = trimmed.split(":")[0];
  }
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/** Whether the dev shortcut may be considered at all for this request. */
export function devLoginEnabledForRequest(
  host: string | undefined | null,
): boolean {
  return devLoginSecret() !== null && isLoopbackHost(host);
}

/**
 * Constant-time comparison against the configured secret. Returns false
 * whenever the shortcut is disabled, so callers cannot accidentally treat
 * "no secret configured" as a match.
 */
export function matchesDevLoginSecret(candidate: string): boolean {
  const secret = devLoginSecret();
  if (!secret || !candidate) return false;
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(secret, "utf8");
  // timingSafeEqual throws on length mismatch; compare lengths separately so
  // the result is still a boolean rather than an exception.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Boot guard. Call once during startup, BEFORE the server listens.
 *
 * Throws if `DEV_LOGIN_PASSWORD` is set in production. The variable being
 * present in a production environment is by definition a mistake, and the
 * only safe response is to refuse to start rather than to start with a
 * password bypass that merely happens to be unreachable today.
 */
export function assertDevLoginSafeAtBoot(): void {
  if (isProduction()) {
    if (process.env.DEV_LOGIN_PASSWORD?.trim()) {
      throw new Error(
        "DEV_LOGIN_PASSWORD is set while NODE_ENV=production. This variable is a " +
          "local-development login bypass and must never be present in a deployed " +
          "environment. Refusing to start — unset it.",
      );
    }
    return;
  }
  if (devLoginSecret()) {
    log.warn(
      "DEV LOGIN ENABLED: DEV_LOGIN_PASSWORD works as the password for any " +
        "local user, on loopback requests only. Never set this outside local development.",
    );
  }
}
