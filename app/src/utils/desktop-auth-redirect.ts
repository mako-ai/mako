/**
 * Desktop auth resume utilities.
 *
 * When the system browser lands on /desktop-auth while the user is signed
 * out, the PKCE challenge from the desktop app is stashed in sessionStorage
 * so the handoff can resume after login — including across the full-page
 * OAuth redirect round trip (same tab, so sessionStorage survives).
 *
 * Mirrors the invite-redirect.ts pattern.
 */

const DESKTOP_AUTH_CHALLENGE_KEY = "desktopAuthChallenge";

/** Accept base64url strings (S256 output is 43 chars); reject garbage. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;

/** True when `value` looks like a valid PKCE challenge. */
export function isValidDesktopAuthChallenge(
  value: string | null | undefined,
): value is string {
  return typeof value === "string" && CHALLENGE_PATTERN.test(value);
}

/** Store a pending desktop auth challenge. Invalid values are ignored. */
export function setPendingDesktopAuthChallenge(challenge: string): void {
  if (!isValidDesktopAuthChallenge(challenge)) return;
  try {
    sessionStorage.setItem(DESKTOP_AUTH_CHALLENGE_KEY, challenge);
  } catch {
    // sessionStorage not available
  }
}

/** Get the pending desktop auth challenge, if any (does not clear it). */
export function getPendingDesktopAuthChallenge(): string | null {
  try {
    const challenge = sessionStorage.getItem(DESKTOP_AUTH_CHALLENGE_KEY);
    return isValidDesktopAuthChallenge(challenge) ? challenge : null;
  } catch {
    return null;
  }
}

/** Clear the pending desktop auth challenge. */
export function clearPendingDesktopAuthChallenge(): void {
  try {
    sessionStorage.removeItem(DESKTOP_AUTH_CHALLENGE_KEY);
  } catch {
    // sessionStorage not available
  }
}

/** True when a desktop auth handoff is waiting to resume. */
export function hasPendingDesktopAuth(): boolean {
  return getPendingDesktopAuthChallenge() !== null;
}
