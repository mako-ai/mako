/**
 * Signed short-TTL tokens for headless draft-app previews.
 *
 * A preview token lets a browser (human tab or headless Chromium driven by
 * an external agent) render one app's DRAFT and execute that draft's stored
 * bindings — without a session cookie or API key ever touching the page.
 * Authorization lives entirely in the token: HMAC-SHA256 over
 * `{appId, workspaceId, exp}` with the server's session secret, minutes-scale
 * TTL, read/execute-only (no mutation endpoint accepts it).
 *
 * Format: `mpt_<base64url(payload)>.<base64url(hmac)>` — stateless, so
 * tokens survive server restarts and need no storage or cleanup.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const APP_PREVIEW_TOKEN_PREFIX = "mpt_";

/** Default 10 minutes; capped at 30 so a leaked URL goes stale fast. */
export const DEFAULT_PREVIEW_TTL_SECONDS = 600;
export const MAX_PREVIEW_TTL_SECONDS = 1800;

interface PreviewTokenPayload {
  a: string; // appId
  w: string; // workspaceId
  exp: number; // unix seconds
}

export interface AppPreviewGrant {
  appId: string;
  workspaceId: string;
  expiresAt: Date;
}

function getSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "Missing HMAC secret for preview tokens: set SESSION_SECRET or ENCRYPTION_KEY",
    );
  }
  return secret;
}

function sign(payload: string): Buffer {
  return createHmac("sha256", getSecret()).update(payload).digest();
}

export function mintAppPreviewToken(input: {
  appId: string;
  workspaceId: string;
  ttlSeconds?: number;
}): { token: string; expiresAt: Date } {
  const ttl = Math.min(
    Math.max(Math.floor(input.ttlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS), 60),
    MAX_PREVIEW_TTL_SECONDS,
  );
  const payload: PreviewTokenPayload = {
    a: input.appId,
    w: input.workspaceId,
    exp: Math.floor(Date.now() / 1000) + ttl,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encoded).toString("base64url");
  return {
    token: `${APP_PREVIEW_TOKEN_PREFIX}${encoded}.${signature}`,
    expiresAt: new Date(payload.exp * 1000),
  };
}

/** Returns the grant when the token is well-formed, untampered and unexpired. */
export function verifyAppPreviewToken(token: string): AppPreviewGrant | null {
  if (!token.startsWith(APP_PREVIEW_TOKEN_PREFIX)) return null;
  const body = token.slice(APP_PREVIEW_TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0) return null;
  const encoded = body.slice(0, dot);
  const signature = body.slice(dot + 1);

  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  const expected = sign(encoded);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  let payload: PreviewTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof payload.a !== "string" ||
    typeof payload.w !== "string" ||
    typeof payload.exp !== "number" ||
    payload.exp * 1000 <= Date.now()
  ) {
    return null;
  }
  return {
    appId: payload.a,
    workspaceId: payload.w,
    expiresAt: new Date(payload.exp * 1000),
  };
}
