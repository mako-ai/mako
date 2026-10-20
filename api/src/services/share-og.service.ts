/**
 * Link previews (Open Graph / Twitter cards) for public app shares.
 *
 * Crawlers — WhatsApp, LinkedIn, Slack, iMessage, Teams, X — do not run
 * JavaScript, so the tags must be in the HTML the server sends for
 * `/share/<token>` (and `/share/<workspace>/<token>`). The SPA's index.html
 * is rewritten on the way out with per-app tags.
 *
 * Privacy is the whole design: only a share that anyone could open — enabled
 * and WITHOUT a password — describes its app (title, description, picture).
 * A password-protected or unknown share gets generic Mako tags, identical for
 * every such link, so a preview never reveals more than the link itself.
 * Authenticated in-app URLs get nothing.
 *
 * The image must be raster (crawlers ignore SVG): the app's own
 * `thumbnail.png`/`.jpg`/`.webp`, re-encoded to a JPEG at most 1200 wide
 * and ~300 KB (WhatsApp drops the large card above that; see
 * image-variants.ts) and served from /api/share/<token>/og-image; an app
 * with only an SVG thumbnail (or none) uses the static generic
 * `/og-default.png`.
 */
import { timed } from "../middleware/server-timing";
import { Types } from "mongoose";
import {
  AppIndexEntry,
  AppProject,
  Workspace,
  type IAppProject,
} from "../database/workspace-schema";
import {
  resolveAppRef,
  resolveIndexedAppRef,
  type AppIndexRow,
  type AppThumbnailRef,
} from "../apps/app-index.service";
import { getThumbnailVariant } from "../apps/thumbnail-variants.service";

/** The share URL shapes the SPA serves (see app/src/App.tsx). */
const SHARE_PATH = /^\/share\/(?:[^/]+\/)?([A-Za-z0-9_-]{3,128})\/?$/;

export function shareTokenFromPath(pathname: string): string | null {
  return SHARE_PATH.exec(pathname)?.[1] ?? null;
}

/** An enabled share by its token; null when unknown or disabled. */
export async function findShareByToken(
  token: string,
): Promise<IAppProject | null> {
  if (!token || token.length < 3 || token.length > 128) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) return null;
  return AppProject.findOne({
    "publicShare.token": token,
    "publicShare.enabled": true,
  });
}

/** A share anyone with the link can open: enabled and not password-gated. */
export function isOpenShare(app: IAppProject | null): app is IAppProject {
  return !!app?.publicShare?.enabled && !app.publicShare.passwordHash;
}

// ---------------------------------------------------------------------------
// The image
// ---------------------------------------------------------------------------

const RASTER_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export function rasterTypeOf(file: string): string | null {
  return RASTER_TYPES[file.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

export { imageSize } from "../apps/image-variants";

export interface ShareImage {
  bytes: Buffer;
  contentType: string;
  oid: string;
  /** Quoted; distinguishes the re-encoded JPEG from the original bytes. */
  etag: string;
  width?: number;
  height?: number;
}

/** The raster thumbnail of an open share's app, or null (use the default). */
export async function shareImageFor(
  app: IAppProject,
): Promise<ShareImage | null> {
  const workspaceId = app.workspaceId.toString();
  const appId = app._id.toString();
  const row =
    (await resolveIndexedAppRef(workspaceId, appId)) ??
    (await resolveAppRef(workspaceId, appId));
  return rasterThumbnail(workspaceId, row?.thumbnail);
}

/**
 * An app's link-preview picture by its index ref; null for SVG or none.
 * The OG variant (a JPEG ≤1200 wide, ≤300 KB) from the shared store, so a
 * fresh instance answers without touching git; the original bytes only
 * when the encoder cannot read the image.
 */
export async function rasterThumbnail(
  workspaceId: string,
  thumb: AppThumbnailRef | undefined,
): Promise<ShareImage | null> {
  const contentType = thumb ? rasterTypeOf(thumb.file) : null;
  if (!thumb || !contentType) return null;
  const image = await getThumbnailVariant(workspaceId, thumb, { kind: "og" });
  if (!image) return null;
  return {
    bytes: image.bytes,
    contentType: image.contentType,
    oid: thumb.oid,
    etag: image.transformed ? `"${thumb.oid}-og"` : `"${thumb.oid}"`,
    ...(image.width && image.height
      ? { width: image.width, height: image.height }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// The tags
// ---------------------------------------------------------------------------

export const GENERIC_SHARE_TITLE = "Mako";
export const GENERIC_SHARE_DESCRIPTION = "A data app shared on Mako.";

export interface OgTags {
  title: string;
  description: string;
  url: string;
  image: string;
  imageType: string;
  imageWidth?: number;
  imageHeight?: number;
}

/** Previews show ~2 lines; a mako.json description can be a paragraph. */
function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Tags for a share URL: the app's for an open share, generic otherwise. */
export async function ogTagsForShare(
  token: string,
  origin: string,
  pathname: string,
): Promise<OgTags> {
  const generic = genericTags(origin, pathname);
  const app = await findShareByToken(token);
  if (!isOpenShare(app)) return generic;
  const row = await resolveAppRef(
    app.workspaceId.toString(),
    app._id.toString(),
  ).catch(() => null);
  const image = await shareImageFor(app).catch(() => null);
  return {
    title: row?.title || app.title || GENERIC_SHARE_TITLE,
    description: clip(row?.description || GENERIC_SHARE_DESCRIPTION, 200),
    url: `${origin}${pathname}`,
    ...(image
      ? {
          image: `${origin}/api/share/${encodeURIComponent(token)}/og-image?v=${image.oid.slice(0, 12)}`,
          imageType: image.contentType,
          imageWidth: image.width,
          imageHeight: image.height,
        }
      : {
          image: generic.image,
          imageType: generic.imageType,
          imageWidth: generic.imageWidth,
          imageHeight: generic.imageHeight,
        }),
  };
}

// ---------------------------------------------------------------------------
// In-app links (/view/<workspace>/<app>)
// ---------------------------------------------------------------------------

/**
 * The in-app viewer URL (`/view/<workspaceId>/<appRef>`), the page every
 * copied workspace link lands on. `/apps/<ref>` tab URLs carry no workspace,
 * so they cannot be resolved without a session and stay generic.
 */
const VIEW_PATH = /^\/view\/([0-9a-fA-F]{24})\/([^/?#]+)\/?$/;

export function appLinkFromPath(
  pathname: string,
): { workspaceId: string; ref: string } | null {
  const m = VIEW_PATH.exec(pathname);
  if (!m) return null;
  let ref: string;
  try {
    ref = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  return { workspaceId: m[1].toLowerCase(), ref };
}

/**
 * The app behind an in-app link, when its preview may name it: the crawler
 * is anonymous, so only what every member of the workspace can already see
 * qualifies. That is a WORKSPACE-tree app (`apps/…`, never a personal tree)
 * whose state row, if any, is workspace-wide access — and only while the
 * workspace has not turned link previews off (`settings.linkPreviews`).
 * Anything else, including an unknown workspace or app, is null (generic).
 */
export async function previewableWorkspaceApp(
  workspaceId: string,
  ref: string,
): Promise<AppIndexRow | null> {
  if (!Types.ObjectId.isValid(workspaceId)) return null;
  const ws = new Types.ObjectId(workspaceId);
  const workspace = await Workspace.findById(ws)
    .select("settings.linkPreviews")
    .lean();
  if (!workspace || workspace.settings?.linkPreviews === false) return null;
  // Persisted rows first (no git: a crawler must not wait on a clone).
  const row =
    (await resolveIndexedAppRef(workspaceId, ref).catch(() => null)) ??
    (await resolveAppRef(workspaceId, ref).catch(() => null));
  if (!row || row.scope !== "workspace") return null;
  if (Types.ObjectId.isValid(row.appId)) {
    const state = await AppProject.findOne({
      _id: new Types.ObjectId(row.appId),
      workspaceId: ws,
    })
      .select("access")
      .lean();
    if (state && state.access !== "workspace") return null;
  }
  return row;
}

/** The public image URL of a previewable app, by id. */
export function appLinkImagePath(
  workspaceId: string,
  appId: string,
  oid: string,
): string {
  return `/api/og/app-image/${workspaceId}/${appId}?v=${oid.slice(0, 12)}`;
}

/** Tags for an in-app link: the app's when previewable, generic otherwise. */
export async function ogTagsForAppLink(
  workspaceId: string,
  ref: string,
  origin: string,
  pathname: string,
): Promise<OgTags> {
  const generic = genericTags(origin, pathname);
  const row = await previewableWorkspaceApp(workspaceId, ref);
  if (!row) return generic;
  const image = await rasterThumbnail(workspaceId, row.thumbnail).catch(
    () => null,
  );
  return {
    title: row.title || GENERIC_SHARE_TITLE,
    description: clip(row.description || GENERIC_SHARE_DESCRIPTION, 200),
    url: `${origin}${pathname}`,
    ...(image
      ? {
          image: `${origin}${appLinkImagePath(workspaceId, row.appId, image.oid)}`,
          imageType: image.contentType,
          imageWidth: image.width,
          imageHeight: image.height,
        }
      : {
          image: generic.image,
          imageType: generic.imageType,
          imageWidth: generic.imageWidth,
          imageHeight: generic.imageHeight,
        }),
  };
}

function genericTags(origin: string, pathname: string): OgTags {
  return {
    title: GENERIC_SHARE_TITLE,
    description: GENERIC_SHARE_DESCRIPTION,
    url: `${origin}${pathname}`,
    image: `${origin}/og-default.png`,
    imageType: "image/png",
    imageWidth: 1200,
    imageHeight: 630,
  };
}

/** Tags for any URL the SPA serves that has a preview; null otherwise. */
export async function ogTagsForPath(
  pathname: string,
  origin: string,
): Promise<OgTags | null> {
  const token = shareTokenFromPath(pathname);
  if (token) return ogTagsForShare(token, origin, pathname);
  const link = appLinkFromPath(pathname);
  if (link) {
    return ogTagsForAppLink(link.workspaceId, link.ref, origin, pathname);
  }
  const tabRef = appTabRefFromPath(pathname);
  if (tabRef !== null) {
    // Index rows only — no git on a crawler's request.
    const found = await timed("og.tabref", () => workspaceAppForTabRef(tabRef));
    return found
      ? ogTagsForAppLink(found.workspaceId, found.appId, origin, pathname)
      : genericTags(origin, pathname);
  }
  return null;
}

// ---------------------------------------------------------------------------
// App tab URLs (/apps/<id> or /apps/<slug>) — no workspace in the URL
// ---------------------------------------------------------------------------

/** The SPA's app tab URL (see TAB_DEEP_LINK_PATTERNS.app): one segment. */
const APP_TAB_PATH = /^\/apps\/([^/?#]+)\/?$/;

export function appTabRefFromPath(pathname: string): string | null {
  const m = APP_TAB_PATH.exec(pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

const tabRefCache = new Map<
  string,
  { at: number; value: { workspaceId: string; appId: string } | null }
>();
const TAB_REF_TTL_MS = 60_000;

/**
 * Which workspace app an `/apps/<ref>` link names, without a session. An id
 * is global, so it names its own workspace. A slug (a folder name) is only
 * taken when exactly ONE workspace-tree app, in a workspace that allows
 * link previews, carries it — several (in one workspace or across them) is
 * ambiguous and stays generic: never guess. One indexed query against the
 * apps index, no repo reads; cached for a minute. The caller still applies
 * the full disclosure rule (previewableWorkspaceApp).
 */
export async function workspaceAppForTabRef(
  ref: string,
): Promise<{ workspaceId: string; appId: string } | null> {
  const key = ref.toLowerCase();
  const hit = tabRefCache.get(key);
  if (hit && Date.now() - hit.at < TAB_REF_TTL_MS) return hit.value;
  const value = await lookupTabRef(ref);
  if (tabRefCache.size > 2_000) tabRefCache.clear();
  tabRefCache.set(key, { at: Date.now(), value });
  return value;
}

async function lookupTabRef(
  ref: string,
): Promise<{ workspaceId: string; appId: string } | null> {
  if (/^[0-9a-f]{24}$/i.test(ref)) {
    const row = await AppIndexEntry.findOne({ appId: ref.toLowerCase() })
      .select("workspaceId appId")
      .lean();
    return row
      ? { workspaceId: row.workspaceId.toString(), appId: row.appId }
      : null;
  }
  const rows = await AppIndexEntry.find({ slug: ref, scope: "workspace" })
    .select("workspaceId appId")
    .limit(20)
    .lean();
  if (rows.length === 0) return null;
  const workspaces = await Workspace.find({
    _id: { $in: [...new Set(rows.map(r => r.workspaceId.toString()))] },
    "settings.linkPreviews": { $ne: false },
  })
    .select("_id")
    .lean();
  const allowed = new Set(workspaces.map(w => w._id.toString()));
  const candidates = rows.filter(r => allowed.has(r.workspaceId.toString()));
  if (candidates.length !== 1) return null;
  return {
    workspaceId: candidates[0].workspaceId.toString(),
    appId: candidates[0].appId,
  };
}

/** Tests: forget cached tab-ref lookups. */
export function clearTabRefCache(): void {
  tabRefCache.clear();
}

const escapeAttr = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** The tags as HTML, every value attribute-escaped. */
export function renderOgTags(tags: OgTags): string {
  const meta = (
    attr: "property" | "name",
    key: string,
    value?: string | number,
  ) =>
    value === undefined || value === ""
      ? ""
      : `    <meta ${attr}="${key}" content="${escapeAttr(String(value))}" />\n`;
  return (
    meta("property", "og:site_name", "Mako") +
    meta("property", "og:type", "website") +
    meta("property", "og:title", tags.title) +
    meta("property", "og:description", tags.description) +
    meta("property", "og:url", tags.url) +
    meta("property", "og:image", tags.image) +
    meta("property", "og:image:type", tags.imageType) +
    meta("property", "og:image:width", tags.imageWidth) +
    meta("property", "og:image:height", tags.imageHeight) +
    meta("name", "twitter:card", "summary_large_image") +
    meta("name", "twitter:title", tags.title) +
    meta("name", "twitter:description", tags.description) +
    meta("name", "twitter:image", tags.image) +
    meta("name", "description", tags.description)
  );
}

/** index.html with the tags in <head> and the page title set. */
export function injectOgTags(html: string, tags: OgTags): string {
  const withTitle = html.replace(
    /<title>[^<]*<\/title>/,
    `<title>${escapeAttr(tags.title)}</title>`,
  );
  return withTitle.replace("</head>", `${renderOgTags(tags)}  </head>`);
}

/**
 * A tiny HTML page for a link-preview crawler that hit a URL which, for a
 * browser, redirects to `viewerPath` (an app's raw `/live/` link). Some
 * crawlers — WhatsApp's among them — do not follow redirects when building
 * a preview, so they get the viewer page's tags here, with the viewer URL as
 * og:url and canonical, and a refresh in case anything renders it.
 */
export async function crawlerPreviewPage(
  viewerPath: string,
  origin: string,
): Promise<string> {
  const pathname = viewerPath.split("?")[0];
  const tags =
    (await ogTagsForPath(pathname, origin)) ?? genericTags(origin, pathname);
  const href = escapeAttr(`${origin}${viewerPath}`);
  return injectOgTags(
    `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>Mako</title>\n    <link rel="canonical" href="${href}" />\n    <meta http-equiv="refresh" content="0;url=${href}" />\n  </head>\n  <body><a href="${href}">Open in Mako</a></body>\n</html>\n`,
    tags,
  );
}

/**
 * The public origin links are built on: CLIENT_URL (where the SPA lives),
 * else the request's own host. Crawlers want absolute https URLs.
 */
export function publicOrigin(requestUrl: string, forwardedProto?: string) {
  const configured = process.env.CLIENT_URL || process.env.PUBLIC_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const url = new URL(requestUrl);
  const local = /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  const proto =
    forwardedProto?.split(",")[0]?.trim() ||
    (local ? url.protocol.slice(0, -1) : "https");
  return `${proto}://${url.host}`;
}
