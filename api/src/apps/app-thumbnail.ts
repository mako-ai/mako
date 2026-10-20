/**
 * App thumbnails — the builder's own picture, not a screenshot.
 *
 * Convention: an image at the app's root, `thumbnail.png` (also .webp, .jpg,
 * .jpeg, .svg — first match wins, see APP_THUMBNAIL_FILES), ideally 1200×750
 * (16:10). The apps index records the file and its blob oid on every push,
 * so the Apps home knows which cards have one without asking, and serving
 * is one `git cat-file` of an immutable, content-addressed blob: cacheable
 * forever under `?v=<oid>`. No screenshot job, no box, no bucket.
 *
 * SVG is the one format that can carry script. It is only ever meant for an
 * <img> (where browsers never run script), and the response says so to
 * anyone who opens the URL directly: a CSP that allows no script and
 * sandboxes the document, plus nosniff.
 *
 * `?w=` asks for a card-sized WebP instead of the original (see
 * image-variants.ts): a 1200×750 PNG poster is 300–460 KB, its 640-wide WebP
 * a tenth of that. SVG is already resolution-free and passes through.
 */
import { runGitBuffer } from "./git";
import type { AppThumbnailRef } from "./app-index.service";
import { cachedVariant, thumbnailWidth, toWebpVariant } from "./image-variants";

/** Larger than any sensible card image; refuse rather than stream a video. */
export const MAX_THUMBNAIL_BYTES = 3 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
};

export function thumbnailContentType(file: string): string | null {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? null;
}

/** Response headers for a thumbnail: immutable by oid, inert if opened. */
export function thumbnailHeaders(
  file: string,
  size: number,
  opts: { contentType?: string; cacheControl?: string; etag?: string } = {},
): Record<string, string> {
  return {
    "Content-Type":
      opts.contentType ??
      thumbnailContentType(file) ??
      "application/octet-stream",
    "Content-Length": String(size),
    // The URL carries the blob oid, so the bytes behind it never change.
    "Cache-Control": opts.cacheControl ?? IMMUTABLE_PRIVATE,
    ...(opts.etag ? { ETag: opts.etag } : {}),
    "X-Content-Type-Options": "nosniff",
    // Matters for SVG opened as a document: no script, no fetches, no
    // same-origin powers. Harmless for raster formats.
    "Content-Security-Policy":
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    "Content-Disposition": "inline",
  };
}

/** The thumbnail's bytes, by blob oid; null when gone or oversized. */
export async function readThumbnailBlob(
  repoDir: string,
  thumbnail: AppThumbnailRef,
): Promise<Buffer | null> {
  try {
    const bytes = await runGitBuffer(
      ["-C", repoDir, "cat-file", "blob", thumbnail.oid],
      { timeoutMs: 15_000, maxBufferBytes: MAX_THUMBNAIL_BYTES + 1 },
    );
    return bytes.length > MAX_THUMBNAIL_BYTES ? null : bytes;
  } catch {
    // A blob over the buffer cap, or one a re-bound repo no longer has.
    return null;
  }
}

/**
 * Behind a session, so `private` either way: a shared cache (Cloudflare, a
 * corporate proxy) must never hand one workspace's picture to another.
 */
const IMMUTABLE_PRIVATE = "private, max-age=31536000, immutable";
/** No (or a stale) `v`: the URL is not content-addressed — revalidate. */
const REVALIDATE_PRIVATE = "private, no-cache";

/** `v` names this blob: the full oid or a prefix of at least 7 chars. */
function versionMatches(v: string | null | undefined, oid: string): boolean {
  return !!v && v.length >= 7 && oid.startsWith(v.toLowerCase());
}

function etagMatches(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header
    .split(",")
    .map(t => t.trim().replace(/^W\//, ""))
    .includes(etag);
}

/**
 * The HTTP answer for a thumbnail the caller is already allowed to see:
 * the original (no `w`, or SVG) or a WebP at the nearest allowed width,
 * cached per process by (oid, width). Null when the blob cannot be read.
 * `read` is only called on a cache miss.
 */
export async function thumbnailResponse(opts: {
  thumbnail: AppThumbnailRef;
  read: () => Promise<Buffer | null>;
  v?: string | null;
  w?: string | null;
  ifNoneMatch?: string | null;
}): Promise<Response | null> {
  const { thumbnail } = opts;
  const isSvg = thumbnailContentType(thumbnail.file) === "image/svg+xml";
  const width = isSvg ? null : thumbnailWidth(opts.w);
  const etag = width ? `"${thumbnail.oid}-w${width}"` : `"${thumbnail.oid}"`;
  const cacheControl = versionMatches(opts.v, thumbnail.oid)
    ? IMMUTABLE_PRIVATE
    : REVALIDATE_PRIVATE;
  if (etagMatches(opts.ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": cacheControl },
    });
  }

  if (!width) {
    const bytes = await opts.read();
    if (!bytes) return null;
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: thumbnailHeaders(thumbnail.file, bytes.length, {
        cacheControl,
        etag,
      }),
    });
  }

  const variant = await cachedVariant(
    `${thumbnail.oid}:w${width}`,
    async () => {
      const source = await opts.read();
      if (!source) return null;
      return (
        (await toWebpVariant(source, width)) ?? {
          // The resizer failed: the original, still correct, just heavier.
          bytes: source,
          contentType: thumbnailContentType(thumbnail.file) ?? "image/png",
          transformed: false,
        }
      );
    },
  );
  if (!variant) return null;
  return new Response(new Uint8Array(variant.bytes), {
    status: 200,
    headers: thumbnailHeaders(thumbnail.file, variant.bytes.length, {
      contentType: variant.contentType,
      cacheControl,
      // An untransformed fallback is the original's bytes: its own ETag.
      etag: variant.transformed ? etag : `"${thumbnail.oid}"`,
    }),
  });
}
