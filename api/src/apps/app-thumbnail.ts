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
 */
import { runGitBuffer } from "./git";
import type { AppThumbnailRef } from "./app-index.service";

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
): Record<string, string> {
  return {
    "Content-Type": thumbnailContentType(file) ?? "application/octet-stream",
    "Content-Length": String(size),
    // The URL carries the blob oid, so the bytes behind it never change.
    "Cache-Control": "private, max-age=31536000, immutable",
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
