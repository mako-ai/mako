/**
 * Thumbnail variants: width snapping, the WebP resize, the byte-bounded
 * cache, the HTTP answer (cache headers, ETags, 304, SVG passthrough,
 * fallback to the original) and the Open Graph size cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { thumbnailResponse } from "./app-thumbnail";
import {
  ByteLru,
  OG_MAX_BYTES,
  THUMBNAIL_WIDTHS,
  thumbnailWidth,
  toOgJpeg,
  toWebpVariant,
  variantCache,
} from "./image-variants";

const OID = "0123456789abcdef0123456789abcdef01234567";

/** A poster-like PNG: flat colour plus enough noise to weigh something. */
async function poster(width = 1200, height = 750, sigma = 30) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#3a6ea5",
      noise: { type: "gaussian", mean: 128, sigma },
    },
  })
    .png()
    .toBuffer();
}

beforeEach(() => variantCache.clear());

describe("thumbnailWidth", () => {
  it("snaps to the nearest allowed width, ties going up", () => {
    expect(thumbnailWidth("640")).toBe(640);
    expect(thumbnailWidth("1")).toBe(320);
    expect(thumbnailWidth("400")).toBe(480); // 80 from both: up
    expect(thumbnailWidth("700")).toBe(640);
    expect(thumbnailWidth("5000")).toBe(1200);
    expect(thumbnailWidth("639.5")).toBe(640);
  });

  it("means the original for absent, junk or non-positive values", () => {
    for (const raw of [undefined, null, "", "abc", "0", "-320", "Infinity"]) {
      expect(thumbnailWidth(raw)).toBeNull();
    }
  });

  it("only ever produces an allowed width", () => {
    for (let n = 1; n < 3000; n += 37) {
      expect(THUMBNAIL_WIDTHS).toContain(thumbnailWidth(String(n)));
    }
  });
});

describe("toWebpVariant", () => {
  it("resizes a 1200×750 PNG to a much smaller WebP of the asked width", async () => {
    const png = await poster();
    const out = await toWebpVariant(png, 640);
    expect(out?.contentType).toBe("image/webp");
    expect(out?.width).toBe(640);
    expect(out?.height).toBe(400);
    expect(out!.bytes.length).toBeLessThan(png.length / 3);
    const meta = await sharp(out!.bytes).metadata();
    expect(meta.format).toBe("webp");
  });

  it("never upscales", async () => {
    const out = await toWebpVariant(await poster(400, 250), 1200);
    expect(out?.width).toBe(400);
  });

  it("returns null for bytes it cannot decode", async () => {
    expect(await toWebpVariant(Buffer.from("not an image"), 320)).toBeNull();
  });
});

describe("ByteLru", () => {
  const entry = (n: number) => ({ bytes: Buffer.alloc(n) });

  it("evicts least-recently-used entries past its byte budget", () => {
    const lru = new ByteLru<{ bytes: Buffer }>(100);
    lru.set("a", entry(20));
    lru.set("b", entry(20));
    lru.set("c", entry(20));
    lru.get("a"); // a is now the freshest
    lru.set("d", entry(20));
    lru.set("e", entry(20));
    lru.set("f", entry(20)); // 120 > 100: the oldest (b) goes
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBeDefined();
    expect(lru.bytes).toBeLessThanOrEqual(100);
  });

  it("refuses an entry bigger than a quarter of the budget", () => {
    const lru = new ByteLru<{ bytes: Buffer }>(100);
    lru.set("big", entry(26));
    expect(lru.size).toBe(0);
  });
});

describe("thumbnailResponse", () => {
  const png = { file: "thumbnail.png", oid: OID };

  it("serves the original without w, privately immutable when v matches", async () => {
    const bytes = Buffer.from("ORIGINAL");
    const res = await thumbnailResponse({
      thumbnail: png,
      v: OID,
      read: async () => bytes,
    });
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("image/png");
    expect(res?.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(res?.headers.get("etag")).toBe(`"${OID}"`);
    expect(await res?.text()).toBe("ORIGINAL");
  });

  it("revalidates (still private) when v is missing or stale", async () => {
    for (const v of [undefined, "ffffffffff", "0123"]) {
      const res = await thumbnailResponse({
        thumbnail: png,
        v,
        read: async () => Buffer.from("X"),
      });
      expect(res?.headers.get("cache-control")).toBe("private, no-cache");
    }
    // A 12-char prefix (the OG URLs' form) counts as the version.
    const prefixed = await thumbnailResponse({
      thumbnail: png,
      v: OID.slice(0, 12),
      read: async () => Buffer.from("X"),
    });
    expect(prefixed?.headers.get("cache-control")).toContain("immutable");
  });

  it("serves a WebP at the snapped width, computed once per (oid, width)", async () => {
    const source = await poster();
    const read = vi.fn(async () => source);
    const first = await thumbnailResponse({
      thumbnail: png,
      v: OID,
      w: "700",
      read,
    });
    expect(first?.headers.get("content-type")).toBe("image/webp");
    expect(first?.headers.get("etag")).toBe(`"${OID}-w640"`);
    expect(first?.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    const body = Buffer.from(await first!.arrayBuffer());
    expect(Number(first?.headers.get("content-length"))).toBe(body.length);
    expect((await sharp(body).metadata()).width).toBe(640);

    const again = await thumbnailResponse({
      thumbnail: png,
      v: OID,
      w: "640",
      read,
    });
    expect(Buffer.from(await again!.arrayBuffer()).equals(body)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);

    // Concurrent first requests for a new width share one encode.
    await Promise.all(
      [1, 2, 3].map(() =>
        thumbnailResponse({ thumbnail: png, v: OID, w: "320", read }),
      ),
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("answers 304 to a matching If-None-Match without reading the blob", async () => {
    const read = vi.fn(async () => Buffer.from("X"));
    const res = await thumbnailResponse({
      thumbnail: png,
      v: OID,
      w: "640",
      ifNoneMatch: `W/"${OID}-w640"`,
      read,
    });
    expect(res?.status).toBe(304);
    expect(res?.headers.get("etag")).toBe(`"${OID}-w640"`);
    expect(read).not.toHaveBeenCalled();
  });

  it("passes SVG through untouched, whatever w says", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const res = await thumbnailResponse({
      thumbnail: { file: "thumbnail.svg", oid: OID },
      v: OID,
      w: "320",
      read: async () => svg,
    });
    expect(res?.headers.get("content-type")).toBe("image/svg+xml");
    expect(res?.headers.get("etag")).toBe(`"${OID}"`);
    expect(res?.headers.get("content-security-policy")).toContain("sandbox");
    expect(await res?.text()).toBe(svg.toString());
  });

  it("falls back to the original bytes when the image cannot be decoded", async () => {
    const res = await thumbnailResponse({
      thumbnail: png,
      v: OID,
      w: "640",
      read: async () => Buffer.from("NOT-A-PNG"),
    });
    expect(res?.status).toBe(200);
    expect(res?.headers.get("content-type")).toBe("image/png");
    expect(res?.headers.get("etag")).toBe(`"${OID}"`);
    expect(await res?.text()).toBe("NOT-A-PNG");
  });

  it("is null when the blob is gone", async () => {
    for (const w of [undefined, "640"]) {
      expect(
        await thumbnailResponse({ thumbnail: png, w, read: async () => null }),
      ).toBeNull();
    }
  });
});

describe("toOgJpeg", () => {
  it("re-encodes a poster to a JPEG at most 1200 wide", async () => {
    const out = await toOgJpeg(await poster(1600, 1000, 10));
    expect(out?.contentType).toBe("image/jpeg");
    expect(out?.width).toBe(1200);
    expect(out?.height).toBe(750);
    expect((await sharp(out!.bytes).metadata()).format).toBe("jpeg");
  });

  it("stays under the WhatsApp budget even for a noisy photo-like image", async () => {
    // Pure noise is the worst case for JPEG; quality, then width, give way.
    const out = await toOgJpeg(await poster(1600, 1000, 90));
    expect(out!.bytes.length).toBeLessThanOrEqual(OG_MAX_BYTES);
    expect(out!.width).toBeGreaterThanOrEqual(800);
  });

  it("flattens transparency (JPEG has no alpha)", async () => {
    const rgba = await sharp({
      create: {
        width: 600,
        height: 375,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const out = await toOgJpeg(rgba);
    const meta = await sharp(out!.bytes).metadata();
    expect(meta.hasAlpha).toBe(false);
    expect(meta.width).toBe(600);
  });
});
