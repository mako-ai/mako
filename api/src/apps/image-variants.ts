/**
 * Resized / re-encoded variants of app thumbnails (sharp / libvips).
 *
 * A builder's poster is typically a 1200×750 PNG of 300–460 KB, while an
 * Apps home card renders it ~300 px wide. Variants are derived from an
 * immutable, content-addressed blob, so a variant keyed by (oid, recipe)
 * never changes either: it is computed once per process and kept in a
 * byte-bounded LRU, and browsers keep it forever under `?v=<oid>`.
 *
 * sharp is loaded lazily and any failure (no prebuilt binary for the
 * platform, an image libvips cannot decode) degrades to serving the original
 * bytes — a thumbnail must never break because the resizer did.
 */
import type SharpDefault from "sharp";
import { loggers } from "../logging";

const logger = loggers.api("apps-image-variants");

// The default export is the sharp function under both CommonJS (this
// package) and ESM resolution (the app's tsc, which type-checks api files it
// reaches transitively); `typeof import("sharp")` is not.
type Sharp = typeof SharpDefault;

let sharpLoad: Promise<Sharp | null> | undefined;

/** sharp, or null when it cannot load on this machine (logged once). */
export function loadSharp(): Promise<Sharp | null> {
  sharpLoad ??= import("sharp")
    .then(mod => {
      const loaded = mod as unknown as { default?: Sharp };
      const sharp = (loaded.default ?? mod) as unknown as Sharp;
      // Our own LRU holds the outputs; libvips' operation cache would only
      // keep decoded inputs we never ask for twice.
      sharp.cache(false);
      return sharp;
    })
    .catch((error: unknown) => {
      logger.warn("sharp unavailable; serving original thumbnails", {
        error,
      });
      return null;
    });
  return sharpLoad;
}

/** Widths a card may ask for; anything else is clamped to the nearest. */
export const THUMBNAIL_WIDTHS = [320, 480, 640, 960, 1200] as const;

/**
 * `?w=` → an allowed width, or null for "the original". Non-numeric or
 * non-positive values mean the original; any positive number snaps to the
 * nearest allowed width (ties go up — never serve blurrier than asked).
 */
export function thumbnailWidth(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  let best: number = THUMBNAIL_WIDTHS[0];
  for (const w of THUMBNAIL_WIDTHS) {
    if (Math.abs(w - n) <= Math.abs(best - n)) best = w;
  }
  return best;
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

export interface ImageVariant {
  bytes: Buffer;
  contentType: string;
  width?: number;
  height?: number;
  /** False when the encoder failed and these are the source's own bytes. */
  transformed: boolean;
}

/** A WebP at most `width` wide (never upscaled), quality 80. */
export async function toWebpVariant(
  source: Buffer,
  width: number,
): Promise<ImageVariant | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const { data, info } = await sharp(source, { animated: false })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 80, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: data,
      contentType: "image/webp",
      width: info.width,
      height: info.height,
      transformed: true,
    };
  } catch (error) {
    logger.warn("thumbnail resize failed; serving original", { error });
    return null;
  }
}

/**
 * Link-preview budget. WhatsApp drops the large preview (or the image
 * entirely) above roughly 300 KB; LinkedIn/Slack/X are far more generous.
 */
export const OG_MAX_BYTES = 300 * 1024;
export const OG_WIDTH = 1200;
const OG_RECIPES: Array<[width: number, quality: number]> = [
  [OG_WIDTH, 85],
  [OG_WIDTH, 75],
  [OG_WIDTH, 65],
  [960, 65],
  [800, 60],
];

/**
 * The Open Graph picture: a baseline JPEG at most 1200 wide and, where
 * quality allows, under OG_MAX_BYTES. Crawlers get JPEG, not WebP — several
 * (older WhatsApp, some email clients) still ignore WebP og:images.
 * Transparency is flattened onto white (JPEG has no alpha).
 */
export async function toOgJpeg(source: Buffer): Promise<ImageVariant | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    let last: { data: Buffer; info: { width: number; height: number } } | null =
      null;
    // Quality first; only a pathological (photographic, noisy) poster has
    // to give up width as well.
    for (const [width, quality] of OG_RECIPES) {
      last = await sharp(source, { animated: false })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      if (last.data.length <= OG_MAX_BYTES) break;
    }
    if (!last) return null;
    return {
      bytes: last.data,
      contentType: "image/jpeg",
      width: last.info.width,
      height: last.info.height,
      transformed: true,
    };
  } catch (error) {
    logger.warn("og image re-encode failed; serving original", { error });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache: byte-bounded LRU + in-flight coalescing
// ---------------------------------------------------------------------------

/** A Map-ordered LRU bounded by the total size of its buffers. */
export class ByteLru<V extends { bytes: Buffer }> {
  private readonly map = new Map<string, V>();
  private total = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (hit) {
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: V): void {
    const prev = this.map.get(key);
    if (prev) {
      this.total -= prev.bytes.length;
      this.map.delete(key);
    }
    // One entry larger than a quarter of the budget would evict a screenful.
    if (value.bytes.length > this.maxBytes / 4) return;
    this.map.set(key, value);
    this.total += value.bytes.length;
    for (const [k, v] of this.map) {
      if (this.total <= this.maxBytes) break;
      this.map.delete(k);
      this.total -= v.bytes.length;
    }
  }

  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}

/** Card-sized WebPs are ~20–60 KB: 48 MB holds well over a thousand. */
const VARIANT_CACHE_BYTES = 48 * 1024 * 1024;
export const variantCache = new ByteLru<ImageVariant>(VARIANT_CACHE_BYTES);
const inflight = new Map<string, Promise<ImageVariant | null>>();

/**
 * The variant under `key`, produced at most once per process at a time.
 * A null result (blob gone) is not cached.
 */
export async function cachedVariant(
  key: string,
  produce: () => Promise<ImageVariant | null>,
): Promise<ImageVariant | null> {
  const hit = variantCache.get(key);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = (async () => {
    try {
      const out = await produce();
      if (out) variantCache.set(key, out);
      return out;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}
