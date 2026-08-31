/**
 * "Send me back where I was going" after signing in.
 *
 * The API redirects an unauthenticated page navigation to
 * `/login?returnTo=<path>` (api/src/auth/login-redirect.ts). Signing in with a
 * password keeps that parameter in the URL, so the login screen can read it
 * straight back. An OAuth sign-in cannot: it is a full-page round trip through
 * the provider that lands on "/", and the parameter is gone by then — so it is
 * stashed first, the same way invite redirects already survive that trip.
 *
 * Only same-origin relative paths are ever honoured, so neither route can be
 * used to bounce someone off-site.
 */

const RETURN_TO_KEY = "postLoginReturnTo";

/** A relative path is safe; "//evil.com" and absolute URLs are not. */
export function safePath(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.startsWith("/") && !value.startsWith("//") ? value : null;
}

/** Read `?returnTo=` off a query string (defaults to the current URL). */
export function readReturnTo(search?: string): string | null {
  const query =
    search ?? (typeof window === "undefined" ? "" : window.location.search);
  return safePath(new URLSearchParams(query).get("returnTo"));
}

/** Keep the destination across a full-page OAuth round trip. */
export function stashReturnTo(path: string | null): void {
  if (!safePath(path)) return;
  try {
    sessionStorage.setItem(RETURN_TO_KEY, path as string);
  } catch {
    // sessionStorage unavailable (private browsing) — the visitor just lands
    // on the workspace home instead, which is where they were going anyway.
  }
}

/** Read and clear the stashed destination. */
export function takeReturnTo(): string | null {
  try {
    const stored = sessionStorage.getItem(RETURN_TO_KEY);
    if (stored) {
      sessionStorage.removeItem(RETURN_TO_KEY);
      return safePath(stored);
    }
  } catch {
    // see above
  }
  return null;
}
