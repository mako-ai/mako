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

/**
 * Link-preview crawlers (WhatsApp, Slack, LinkedIn, Facebook/iMessage,
 * Teams, X, Discord, Telegram). They are never signed in, and many send
 * `Accept: *` rather than text/html.
 */
const PREVIEW_CRAWLER =
  /WhatsApp|facebookexternalhit|Facebot|Slackbot|LinkedInBot|Twitterbot|TelegramBot|Discordbot|SkypeUriPreview|Teams|redditbot|Pinterest|Embedly|Applebot/i;

export function isPreviewCrawler(userAgent: string | undefined): boolean {
  return !!userAgent && PREVIEW_CRAWLER.test(userAgent);
}

/**
 * Where an UNAUTHENTICATED open of an app's live link goes: the viewer page,
 * whose HTML signs people in and carries the app's link-preview tags. Only
 * the app's top-level page, only with no credentials at all, and only for a
 * browser (asks for HTML) or a preview crawler — an API client keeps its 401.
 */
export function anonymousViewerRedirect(input: {
  hasCredentials: boolean;
  accept: string | undefined;
  userAgent: string | undefined;
  workspaceId: string | undefined;
  ref: string | undefined;
  path: string;
  url: string;
}): string | null {
  if (input.hasCredentials) return null;
  const wantsHtml = (input.accept ?? "").includes("text/html");
  if (!wantsHtml && !isPreviewCrawler(input.userAgent)) return null;
  return liveViewerRedirect({
    fetchDest: "document",
    fetchMode: "navigate",
    workspaceId: input.workspaceId,
    ref: input.ref,
    path: input.path,
    url: input.url,
  });
}
