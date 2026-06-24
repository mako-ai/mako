/**
 * App runtime location <-> host URL projection.
 *
 * A Mako app runs inside a sandboxed `srcdoc` iframe (an opaque origin with no
 * `allow-same-origin`), so it cannot read or write the real browser URL itself
 * — inside the frame `window.location` is `about:srcdoc`. Instead the app
 * reports its desired location over the `postMessage` bridge and the host
 * projects that location onto its own shareable URL (`/a/:appId` in the Mako
 * shell, `/share/:token` in the public viewer), then seeds it back into the
 * iframe on load. This module is the single source of truth for that mapping,
 * so the embedded and public hosts stay in lockstep.
 *
 * The app "location" is a normal relative URL — a pathname (always starting
 * with "/") plus an optional query string, e.g. `/customers/123?tab=open`.
 *
 * Projection keeps the app's *query params as real, editable params* on the
 * address bar and stows the app's *pathname* in a single reserved param
 * (`_path`), so a shared link round-trips exactly:
 *
 *   app    /customers/123?tab=open&c=ES
 *   host   /a/<id>?tab=open&c=ES&_path=%2Fcustomers%2F123
 *
 * The host's own path (`/a/:appId`, `/share/:token`) is left untouched, so
 * this never collides with Mako's deep-link route patterns (which are
 * exhaustive over tab kinds — see `tab-routing.ts`).
 */

/**
 * Reserved host query param that carries the app's pathname. Apps should avoid
 * using a top-level query param with this exact name (it is stripped on the way
 * in and re-applied on the way out).
 */
export const RESERVED_PATH_PARAM = "_path";

/** A dummy absolute base so we can reuse the platform URL parser for relatives. */
const DUMMY_ORIGIN = "http://mako.app.local";

export interface AppLocation {
  /** Always starts with "/". */
  pathname: string;
  /** Empty string or a value beginning with "?". */
  search: string;
}

/** Split a relative URL string into its pathname + search parts (hash dropped). */
export function parseAppLocation(
  relativeUrl: string | null | undefined,
): AppLocation {
  const raw = relativeUrl && relativeUrl.length > 0 ? relativeUrl : "/";
  try {
    const url = new URL(raw, DUMMY_ORIGIN);
    return { pathname: url.pathname || "/", search: url.search };
  } catch {
    return { pathname: "/", search: "" };
  }
}

/** Serialize an {@link AppLocation} back to a relative URL string. */
export function formatAppLocation(loc: AppLocation): string {
  const pathname = loc.pathname.startsWith("/")
    ? loc.pathname
    : `/${loc.pathname}`;
  return `${pathname}${loc.search || ""}`;
}

/**
 * Resolve a (possibly relative) navigation target against the current app
 * location and return a normalized relative URL string. Supports absolute
 * paths ("/x"), relative paths ("x", "./x", "../x") and query-only ("?q=1").
 */
export function resolveAppLocation(current: string, to: string): string {
  try {
    const base = new URL(
      formatAppLocation(parseAppLocation(current)),
      DUMMY_ORIGIN,
    );
    const next = new URL(to, base);
    return formatAppLocation({
      pathname: next.pathname || "/",
      search: next.search,
    });
  } catch {
    return formatAppLocation(parseAppLocation(current));
  }
}

/**
 * Encode an app location into a host query string. Returns the string with a
 * leading "?", or "" when the app is at its root with no query.
 */
export function appLocationToHostSearch(
  relativeUrl: string | null | undefined,
): string {
  const { pathname, search } = parseAppLocation(relativeUrl);
  const out = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) {
    if (key === RESERVED_PATH_PARAM) continue; // reserved by the host
    out.append(key, value);
  }
  if (pathname && pathname !== "/") out.set(RESERVED_PATH_PARAM, pathname);
  const qs = out.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Decode an app location (a relative URL string) out of a host query string.
 * The inverse of {@link appLocationToHostSearch}; always returns a value that
 * starts with "/".
 */
export function appLocationFromHostSearch(hostSearch: string): string {
  const params = new URLSearchParams(hostSearch || "");
  const rawPath = params.get(RESERVED_PATH_PARAM) || "/";
  const pathname = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const appParams = new URLSearchParams();
  for (const [key, value] of params) {
    if (key === RESERVED_PATH_PARAM) continue;
    appParams.append(key, value);
  }
  const qs = appParams.toString();
  return formatAppLocation({ pathname, search: qs ? `?${qs}` : "" });
}
