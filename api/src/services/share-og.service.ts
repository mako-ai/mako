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
 * `thumbnail.png`/`.jpg`/`.webp`, served unchanged from
 * /api/share/<token>/og-image; an app with only an SVG thumbnail (or none)
 * uses the static generic `/og-default.png` (no server-side rasterizer is
 * available, and adding a native image stack for this is not worth it).
 */
import { AppProject, type IAppProject } from "../database/workspace-schema";
import { resolveAppRef, type AppThumbnailRef } from "../apps/app-index.service";
import { readThumbnailBlob } from "../apps/app-thumbnail";
import { boundRepoDirIfExists } from "../apps/workspace-repo-required";

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

/**
 * Width × height from the header of a PNG, JPEG or WebP, without decoding —
 * og:image:width/height let crawlers lay the card out before fetching.
 */
export function imageSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: signature, then IHDR width/height (big-endian) at 16/20.
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  // JPEG: walk markers to the first SOFn.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X.
  if (
    b.length >= 30 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8X") {
      return {
        width: 1 + b.readUIntLE(24, 3),
        height: 1 + b.readUIntLE(27, 3),
      };
    }
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >> 14) & 0x3fff),
      };
    }
    if (chunk === "VP8 ") {
      return {
        width: b.readUInt16LE(26) & 0x3fff,
        height: b.readUInt16LE(28) & 0x3fff,
      };
    }
  }
  return null;
}

export interface ShareImage {
  bytes: Buffer;
  contentType: string;
  oid: string;
  width?: number;
  height?: number;
}

/** Per-process memo by blob oid: a blob never changes. */
const imageCache = new Map<string, ShareImage>();

/** The raster thumbnail of an open share's app, or null (use the default). */
export async function shareImageFor(
  app: IAppProject,
): Promise<ShareImage | null> {
  const workspaceId = app.workspaceId.toString();
  const row = await resolveAppRef(workspaceId, app._id.toString());
  const thumb: AppThumbnailRef | undefined = row?.thumbnail;
  const contentType = thumb ? rasterTypeOf(thumb.file) : null;
  if (!thumb || !contentType) return null;
  const hit = imageCache.get(thumb.oid);
  if (hit) return hit;
  const repoDir = await boundRepoDirIfExists(workspaceId);
  const bytes = repoDir ? await readThumbnailBlob(repoDir, thumb) : null;
  if (!bytes) return null;
  const size = imageSize(bytes);
  const image: ShareImage = {
    bytes,
    contentType,
    oid: thumb.oid,
    ...(size ?? {}),
  };
  if (imageCache.size > 200) imageCache.clear();
  imageCache.set(thumb.oid, image);
  return image;
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
  const generic: OgTags = {
    title: GENERIC_SHARE_TITLE,
    description: GENERIC_SHARE_DESCRIPTION,
    url: `${origin}${pathname}`,
    image: `${origin}/og-default.png`,
    imageType: "image/png",
    imageWidth: 1200,
    imageHeight: 630,
  };
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
