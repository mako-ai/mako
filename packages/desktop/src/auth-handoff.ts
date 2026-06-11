/**
 * Browser-based sign-in handoff helpers (pure logic, no Electron imports).
 *
 * Mako Desktop never renders third-party login pages in its own window.
 * Instead it opens the system browser at /desktop-auth with a PKCE challenge;
 * the browser hands a one-time code back via a mako://auth?code=... deep
 * link, and the app redeems code+verifier at /api/auth/desktop/complete,
 * which sets the session cookie inside the app window.
 *
 * Kept free of Electron dependencies so the logic can be exercised with
 * plain Node (see scripts/test-auth-handoff.js usage in development).
 */
import { createHash, randomBytes } from "crypto";

export const DEEP_LINK_SCHEME = "mako";

/** How long a generated verifier stays redeemable (browser round trip time). */
export const VERIFIER_TTL_MS = 10 * 60 * 1000;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** Generate a PKCE pair: verifier (secret) + S256 challenge (shareable). */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** URL the system browser is opened at to start (or resume) sign-in. */
export function buildDesktopAuthUrl(appUrl: string, challenge: string): string {
  const url = new URL("/desktop-auth", appUrl);
  url.searchParams.set("challenge", challenge);
  return url.toString();
}

/** URL loaded inside the app window to redeem the code and set the cookie. */
export function buildCompleteUrl(
  appUrl: string,
  code: string,
  verifier: string,
): string {
  const url = new URL("/api/auth/desktop/complete", appUrl);
  url.searchParams.set("code", code);
  url.searchParams.set("verifier", verifier);
  return url.toString();
}

/**
 * Extract the one-time auth code from a mako://auth?code=... deep link.
 * Returns null for anything that is not a well-formed auth deep link.
 */
export function parseDeepLinkAuthCode(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) return null;

  // Accept mako://auth?code=... (host form) and mako:auth?code=... /
  // mako:///auth?code=... (path forms) — OSes and browsers vary here.
  const target = url.host || url.pathname.replace(/^\/+/, "");
  if (target !== "auth") return null;

  const code = url.searchParams.get("code");
  if (!code || !BASE64URL_PATTERN.test(code)) return null;
  return code;
}

/** Find the first mako:// deep link among process argv entries, if any. */
export function findDeepLinkInArgv(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith(`${DEEP_LINK_SCHEME}://`)) return arg;
  }
  return null;
}

/**
 * True when `rawUrl` is an in-window OAuth initiation on the app origin
 * (e.g. https://app.mako.ai/api/auth/google). Used as a will-navigate
 * safety net: such navigation must be redirected to the system browser.
 */
export function isOAuthInitiationUrl(rawUrl: string, appUrl: string): boolean {
  try {
    const target = new URL(rawUrl);
    const app = new URL(appUrl);
    if (target.origin !== app.origin) return false;
    return (
      target.pathname === "/api/auth/google" ||
      target.pathname === "/api/auth/github"
    );
  } catch {
    return false;
  }
}
