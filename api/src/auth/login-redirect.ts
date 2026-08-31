/**
 * Login gate for API-served PAGES.
 *
 * Some URLs under /api are things a person opens in a tab, not endpoints a
 * script calls: a published app (`/api/workspaces/<ws>/apps/<id>/live/`), the
 * assets it pulls in, a share link. Signed out, those used to answer
 * `{"error":"Unauthorized"}` — a browser showing raw JSON to someone who was
 * simply sent a link, with no way forward.
 *
 * So an unauthenticated **document navigation** is redirected to the login
 * page instead, carrying `returnTo` — the parameter the login screen already
 * honours (see `safeReturnTo` in app/src/App.tsx), which sends the visitor
 * back to the URL they clicked once they are signed in.
 *
 * Everything else keeps the JSON 401 it expects. `fetch`/XHR callers parse
 * that body, and a 302 would hand them a login page instead of an error; the
 * published app's own binding requests are exactly that case.
 */

const HTML = /\btext\/html\b/i;

export interface RequestShape {
  method: string;
  path: string;
  /** raw query string, with or without the leading "?" */
  query?: string;
  /** Accept header, if any */
  accept?: string;
  /** Sec-Fetch-Dest header, if any */
  secFetchDest?: string;
}

/**
 * True when this unauthenticated request is a person navigating to a page.
 *
 * `Sec-Fetch-Dest` is the reliable signal and every current browser sends it:
 * "document" is a top-level navigation, while a `fetch()` is "empty" and a
 * framed load is "iframe" — neither should be bounced (a login screen inside
 * the app's sandboxed viewer iframe helps nobody). Only when the header is
 * absent do we fall back to Accept.
 */
export function shouldRedirectToLogin(req: RequestShape): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  // Never bounce the auth surface itself — that is how a redirect loop starts.
  if (req.path.startsWith("/api/auth")) return false;
  const dest = req.secFetchDest?.toLowerCase();
  if (dest) return dest === "document";
  return HTML.test(req.accept ?? "");
}

/** `/login?returnTo=<the URL they clicked>` — path + query, same origin. */
export function loginRedirectUrl(path: string, query?: string): string {
  const q = (query ?? "").replace(/^\?/, "");
  const returnTo = q ? `${path}?${q}` : path;
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}
