/**
 * Desktop auth code helpers (browser → desktop app session handoff).
 *
 * Flow:
 * 1. Mako Desktop generates a PKCE-style verifier, derives
 *    challenge = base64url(SHA-256(verifier)) and opens the system browser at
 *    `${CLIENT_URL}/desktop-auth?challenge=<challenge>`.
 * 2. The (browser-authenticated) user mints a one-time code bound to that
 *    challenge via POST /api/auth/desktop/code.
 * 3. The browser triggers `mako://auth?code=<code>`; the desktop app redeems
 *    the code together with its verifier at GET /api/auth/desktop/complete,
 *    which sets a fresh session cookie inside the desktop window.
 *
 * Security properties:
 * - Codes are single-use (atomic findOneAndDelete), expire after 60 seconds,
 *   and only their SHA-256 hash is persisted.
 * - The challenge is mandatory: a malicious app squatting the `mako://`
 *   scheme can intercept a code but cannot redeem it without the verifier,
 *   which never leaves the legitimate desktop app.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { DesktopAuthCode } from "../database/schema";
import { loggers } from "../logging";

const logger = loggers.auth();

/** Lifetime of a minted desktop auth code. */
export const DESKTOP_AUTH_CODE_TTL_MS = 60_000;

/**
 * base64url output of SHA-256 is always 43 characters; the verifier and code
 * (32 random bytes, base64url) are 43 characters too. Accept a small range to
 * stay robust against future length tweaks while rejecting garbage.
 */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;

export function isValidChallenge(challenge: unknown): challenge is string {
  return typeof challenge === "string" && BASE64URL_PATTERN.test(challenge);
}

function sha256Base64url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/**
 * Mint a one-time desktop auth code for a user, bound to a PKCE challenge.
 * Returns the raw code (the only place it ever exists in plaintext).
 */
export async function createDesktopAuthCode(
  userId: string,
  challenge: string,
): Promise<string> {
  if (!isValidChallenge(challenge)) {
    throw new Error("Invalid challenge");
  }

  const code = randomBytes(32).toString("base64url");

  await DesktopAuthCode.create({
    _id: sha256Base64url(code),
    userId,
    challenge,
    expiresAt: new Date(Date.now() + DESKTOP_AUTH_CODE_TTL_MS),
  });

  logger.info("Desktop auth code created", { userId });
  return code;
}

/**
 * Redeem a desktop auth code. Consumes the code atomically (single use) and
 * verifies expiry plus the PKCE verifier against the stored challenge.
 * Returns the bound userId on success, null on any failure.
 */
export async function redeemDesktopAuthCode(
  code: unknown,
  verifier: unknown,
): Promise<string | null> {
  if (
    typeof code !== "string" ||
    typeof verifier !== "string" ||
    !BASE64URL_PATTERN.test(code) ||
    !BASE64URL_PATTERN.test(verifier)
  ) {
    logger.warn("Desktop auth redemption rejected: malformed params");
    return null;
  }

  // Atomic single-use: whoever deletes the doc first wins; replays find nothing.
  const doc = await DesktopAuthCode.findOneAndDelete({
    _id: sha256Base64url(code),
  }).lean();

  if (!doc) {
    logger.warn("Desktop auth redemption rejected: unknown or reused code");
    return null;
  }

  if (doc.expiresAt.getTime() < Date.now()) {
    logger.warn("Desktop auth redemption rejected: expired code", {
      userId: doc.userId,
    });
    return null;
  }

  const expected = Buffer.from(doc.challenge);
  const actual = Buffer.from(sha256Base64url(verifier));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    logger.warn("Desktop auth redemption rejected: verifier mismatch", {
      userId: doc.userId,
    });
    return null;
  }

  logger.info("Desktop auth code redeemed", { userId: doc.userId });
  return doc.userId;
}
