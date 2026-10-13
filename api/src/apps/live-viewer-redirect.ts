/**
 * Where a person who OPENS an app's live link lands: Mako's app viewer
 * (`/view/<workspace>/<app>`), which shows the same published app full-screen
 * with a chat beside it.
 *
 * Only a browser's top-level navigation to the app's page is redirected. The
 * bundle's own requests (assets, `__data/`), API clients and embeds are served
 * as before, and `?raw=1` opts out. The viewer page loads the app from a
 * view-token URL, never from `/live/`, so the redirect cannot loop.
 */
export function liveViewerRedirect(input: {
  /** `Sec-Fetch-Dest` / `Sec-Fetch-Mode` request headers. */
  fetchDest: string | undefined;
  fetchMode: string | undefined;
  workspaceId: string | undefined;
  /** The app reference exactly as the caller wrote it in the path. */
  ref: string | undefined;
  /** Request path, e.g. /api/workspaces/w/apps/sales/live/ */
  path: string;
  /** Full request URL (for the query string). */
  url: string;
}): string | null {
  if (input.fetchDest !== "document" || input.fetchMode !== "navigate") {
    return null;
  }
  const { workspaceId, ref } = input;
  if (!workspaceId || !ref) return null;
  const marker = `/apps/${ref}/live`;
  const at = input.path.indexOf(marker);
  if (at === -1) return null;
  const rest = input.path.slice(at + marker.length);
  if (rest !== "" && rest !== "/" && rest !== "/index.html") return null;
  const url = new URL(input.url);
  if (url.searchParams.has("raw")) return null;
  return `/view/${encodeURIComponent(workspaceId)}/${encodeURIComponent(ref)}${url.search}`;
}
