import { createHmac, timingSafeEqual } from "crypto";
import type { Context } from "hono";
import { loggers } from "../logging";

const logger = loggers.auth();

const TRUSTED_DOMAIN_SUFFIXES = [".mako.co", ".mako.ai"];

/**
 * Get the production URL. All OAuth callbacks route through production since
 * only production's callback URLs are registered with OAuth providers.
 */
export function getProductionUrl(): string {
  return process.env.PRODUCTION_URL || process.env.BASE_URL || "";
}

/**
 * Derive the origin of the current request using forwarded headers
 * (as set by reverse proxies like Vercel, Cloudflare, etc.).
 */
export function getRequestOrigin(c: Context): string {
  const forwarded = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const proto =
    c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  if (forwarded) return new URL(`${proto}://${forwarded}`).origin;
  const host = c.req.header("host");
  if (host) {
    const scheme =
      host.startsWith("localhost") || host.startsWith("127.0.0.1")
        ? "http"
        : proto;
    return new URL(`${scheme}://${host}`).origin;
  }
  return new URL(c.req.url).origin;
}

/**
 * Returns true when the running server IS the production instance.
 * Compares the request origin with PRODUCTION_URL; when PRODUCTION_URL
 * is unset the server is assumed to be production (backward compatible).
 */
export function isProduction(c: Context): boolean {
  const productionUrl = process.env.PRODUCTION_URL;
  if (!productionUrl) return true;
  try {
    return getRequestOrigin(c) === new URL(productionUrl).origin;
  } catch {
    return false;
  }
}

function getHmacSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "Missing HMAC secret: set SESSION_SECRET or ENCRYPTION_KEY",
    );
  }
  return secret;
}

function parseTrustedOrigins(): string[] {
  const raw = process.env.TRUSTED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(",")
    .map(o => o.trim())
    .filter(Boolean);
}

/**
 * Validate that an origin is trusted for OAuth redirect targets.
 * Allows: localhost (any port), TRUSTED_DOMAIN_SUFFIXES (HTTPS),
 * and origins listed in the TRUSTED_ORIGINS env var.
 */
export function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      return url.protocol === "http:" || url.protocol === "https:";
    }
    const productionUrl = getProductionUrl();
    if (productionUrl && url.origin === new URL(productionUrl).origin) {
      return true;
    }
    if (url.protocol !== "https:") return false;
    if (
      TRUSTED_DOMAIN_SUFFIXES.some(
        suffix =>
          url.hostname === suffix.slice(1) || url.hostname.endsWith(suffix),
      )
    ) {
      return true;
    }
    return parseTrustedOrigins().includes(url.origin);
  } catch {
    return false;
  }
}

/**
 * Encode OAuth state as HMAC-signed base64url JSON containing the CSRF
 * nonce and the caller's origin. The signature prevents tampering with the
 * origin in the state parameter.
 */
export function encodeOAuthState(nonce: string, origin: string): string {
  const payload = Buffer.from(JSON.stringify({ nonce, origin })).toString(
    "base64url",
  );
  const signature = createHmac("sha256", getHmacSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

/**
 * Decode and verify an HMAC-signed OAuth state parameter.
 * Returns null if the signature is invalid or the payload is malformed.
 */
export function decodeOAuthState(
  state: string,
): { nonce: string; origin: string } | null {
  try {
    const dotIndex = state.lastIndexOf(".");
    if (dotIndex === -1) return null;
    const payload = state.slice(0, dotIndex);
    const signature = state.slice(dotIndex + 1);
    if (!payload || !signature) return null;

    const expectedSig = createHmac("sha256", getHmacSecret())
      .update(payload)
      .digest("base64url");
    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSig);
    if (
      sigBuf.length !== expectedBuf.length ||
      !timingSafeEqual(sigBuf, expectedBuf)
    ) {
      logger.warn("OAuth state signature mismatch");
      return null;
    }

    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (
      typeof decoded.nonce !== "string" ||
      typeof decoded.origin !== "string"
    ) {
      return null;
    }
    return { nonce: decoded.nonce, origin: decoded.origin };
  } catch {
    return null;
  }
}

/**
 * Create a short-lived HMAC-signed transfer token wrapping a session ID.
 * Used to securely transmit session credentials from the production
 * OAuth callback to a non-production environment's /oauth-receive endpoint.
 */
export function createTransferToken(sessionId: string): string {
  const data = Buffer.from(
    JSON.stringify({ sid: sessionId, exp: Date.now() + 60_000 }),
  ).toString("base64url");
  const signature = createHmac("sha256", getHmacSecret())
    .update(data)
    .digest("base64url");
  return `${data}.${signature}`;
}

/**
 * Verify and decode a transfer token. Returns the session ID if the
 * signature is valid and the token has not expired; null otherwise.
 */
export function verifyTransferToken(token: string): string | null {
  try {
    const dotIndex = token.lastIndexOf(".");
    if (dotIndex === -1) return null;
    const data = token.slice(0, dotIndex);
    const signature = token.slice(dotIndex + 1);
    if (!data || !signature) return null;

    const expectedSig = createHmac("sha256", getHmacSecret())
      .update(data)
      .digest("base64url");
    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSig);
    if (
      sigBuf.length !== expectedBuf.length ||
      !timingSafeEqual(sigBuf, expectedBuf)
    ) {
      logger.warn("Transfer token signature mismatch");
      return null;
    }

    const payload = JSON.parse(Buffer.from(data, "base64url").toString());
    if (typeof payload.sid !== "string" || typeof payload.exp !== "number") {
      return null;
    }
    if (payload.exp < Date.now()) {
      logger.warn("Transfer token expired");
      return null;
    }
    return payload.sid;
  } catch {
    return null;
  }
}
