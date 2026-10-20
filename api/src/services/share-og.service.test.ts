/**
 * Link previews for public shares: which shares describe their app, the
 * tags in the served HTML, and the preview image endpoint.
 *
 * A real bare repo (the app folder carries thumbnail.png) and in-memory
 * Mongo, the same harness as the apps index suite.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import sharp from "sharp";
import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
  Workspace,
} from "../database/workspace-schema";
import { initRepo, repoDirFor } from "../apps/repository.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../apps/bind-test-workspace-repo";
import { invalidateAppsIndexCache } from "../apps/app-index.service";
import { anonymousViewerRedirect } from "../apps/live-viewer-redirect";
import { publicShareRoutes } from "../routes/public-share";
import { ogRoutes } from "../routes/og";
import { OG_MAX_BYTES } from "../apps/image-variants";
import {
  GENERIC_SHARE_TITLE,
  appLinkFromPath,
  imageSize,
  injectOgTags,
  ogTagsForPath,
  ogTagsForShare,
  publicOrigin,
  shareTokenFromPath,
} from "./share-og.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;
/** A real 1600×1000 PNG: the OG image re-encodes and caps it. */
let posterPng: Buffer;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "share-og-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.SESSION_SECRET ||= "test-secret";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  // Coarse noise, blown up: a ~650 KB PNG (under the 3 MB blob cap) whose
  // straight q85 JPEG would still be ~450 KB, so the cap has to bite.
  const grain = await sharp({
    create: {
      width: 533,
      height: 333,
      channels: 3,
      background: "#3a6ea5",
      noise: { type: "gaussian", mean: 128, sigma: 60 },
    },
  })
    .png()
    .toBuffer();
  posterPng = await sharp(grain)
    .resize({ width: 1600, height: 1000, kernel: "nearest" })
    .png({ compressionLevel: 9 })
    .toBuffer();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const WS = new Types.ObjectId().toString();
const OPEN = new Types.ObjectId();
const LOCKED = new Types.ObjectId();
const SVG_ONLY = new Types.ObjectId();
const PLAIN = new Types.ObjectId();
const RESTRICTED = new Types.ObjectId();
const PERSONAL = new Types.ObjectId();
const ORIGIN = "https://app.mako.ai";

const manifest = (id: Types.ObjectId, title: string, description?: string) =>
  JSON.stringify({
    id: id.toHexString(),
    schemaVersion: 1,
    title,
    ...(description ? { description } : {}),
  });

beforeEach(async () => {
  await AppIndexEntry.deleteMany({});
  await AppIndexHead.deleteMany({});
  await AppProject.deleteMany({});
  await unbindTestWorkspaceRepo(WS);
  invalidateAppsIndexCache();
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await initRepo(repoDirFor(WS), {
    "apps/open/mako.json": manifest(
      OPEN,
      'Leads "by" canton',
      "Daily inbound leads",
    ),
    "apps/open/thumbnail.png": posterPng,
    "apps/locked/mako.json": manifest(LOCKED, "Secret board", "Do not leak"),
    "apps/locked/thumbnail.png": "SECRET-PNG",
    "apps/svg/mako.json": manifest(
      SVG_ONLY,
      "Vector only",
      `A very long description ${"word ".repeat(80)}end`,
    ),
    "apps/svg/thumbnail.svg": "<svg/>",
    // In-app links: a workspace app with no state row, a restricted one,
    // and one in a personal tree.
    "apps/plain/mako.json": manifest(PLAIN, "Team board", "Weekly numbers"),
    "apps/plain/thumbnail.png": "PLAIN-PNG",
    "apps/restricted/mako.json": manifest(RESTRICTED, "Board pack"),
    "apps/restricted/thumbnail.png": "RESTRICTED-PNG",
    "users/alice/apps/mine/mako.json": manifest(PERSONAL, "Alice's notes"),
    "users/alice/apps/mine/thumbnail.png": "PERSONAL-PNG",
  });
  await bindTestWorkspaceRepo(WS);
  await Workspace.updateOne(
    { _id: new Types.ObjectId(WS) },
    { $unset: { "settings.linkPreviews": 1 } },
  );
  const base = {
    workspaceId: new Types.ObjectId(WS),
    access: "workspace" as const,
    createdBy: "",
    defaultBranch: "main",
  };
  await AppProject.create([
    {
      ...base,
      _id: OPEN,
      title: "Leads",
      slug: "open",
      path: "apps/open",
      publicShare: { enabled: true, token: "open-share" },
    },
    {
      ...base,
      _id: LOCKED,
      title: "Secret board",
      slug: "locked",
      path: "apps/locked",
      publicShare: { enabled: true, token: "locked-share", passwordHash: "x" },
    },
    {
      ...base,
      _id: SVG_ONLY,
      title: "Vector only",
      slug: "svg",
      path: "apps/svg",
      publicShare: { enabled: true, token: "svg-share" },
    },
    {
      ...base,
      _id: RESTRICTED,
      title: "Board pack",
      slug: "restricted",
      path: "apps/restricted",
      access: "private",
      owner_id: new Types.ObjectId().toString(),
    },
  ]);
});

describe("share link previews", () => {
  it("recognises both share URL shapes and nothing else", () => {
    expect(shareTokenFromPath("/share/open-share")).toBe("open-share");
    expect(shareTokenFromPath("/share/realadvisor/open-share/")).toBe(
      "open-share",
    );
    expect(shareTokenFromPath("/apps/open")).toBeNull();
    expect(shareTokenFromPath("/share/a/b/c")).toBeNull();
  });

  it("describes an open share with the app's title, description and raster thumbnail", async () => {
    const tags = await ogTagsForShare(
      "open-share",
      ORIGIN,
      "/share/open-share",
    );
    expect(tags.title).toBe('Leads "by" canton');
    expect(tags.description).toBe("Daily inbound leads");
    expect(tags.url).toBe(`${ORIGIN}/share/open-share`);
    expect(tags.image).toMatch(
      /^https:\/\/app\.mako\.ai\/api\/share\/open-share\/og-image\?v=[0-9a-f]{12}$/,
    );
    // Re-encoded for crawlers: a JPEG at most 1200 wide.
    expect(tags.imageType).toBe("image/jpeg");
    expect(tags.imageWidth).toBe(1200);
    expect(tags.imageHeight).toBe(750);

    const html = injectOgTags(
      "<html><head><title>Mako</title></head><body></body></html>",
      tags,
    );
    expect(html).toContain("<title>Leads &quot;by&quot; canton</title>");
    expect(html).toContain(
      '<meta property="og:title" content="Leads &quot;by&quot; canton" />',
    );
    expect(html).toContain('<meta property="og:site_name" content="Mako" />');
    expect(html).toContain(
      '<meta name="twitter:card" content="summary_large_image" />',
    );
    expect(html.indexOf("og:image")).toBeLessThan(html.indexOf("</head>"));
  });

  it("reveals nothing about a password-protected or unknown share", async () => {
    for (const token of ["locked-share", "no-such-share"]) {
      const tags = await ogTagsForShare(token, ORIGIN, `/share/${token}`);
      expect(tags.title).toBe(GENERIC_SHARE_TITLE);
      expect(tags.image).toBe(`${ORIGIN}/og-default.png`);
      expect(JSON.stringify(tags)).not.toContain("Secret");
      expect(JSON.stringify(tags)).not.toContain("leak");
    }
  });

  it("falls back to the generic raster image when the app only has an SVG", async () => {
    const tags = await ogTagsForShare("svg-share", ORIGIN, "/share/svg-share");
    expect(tags.title).toBe("Vector only");
    // A paragraph-long description is clipped for the preview card.
    expect(tags.description.length).toBeLessThanOrEqual(200);
    expect(tags.description.endsWith("…")).toBe(true);
    expect(tags.image).toBe(`${ORIGIN}/og-default.png`);
    expect(tags.imageWidth).toBe(1200);
    expect(tags.imageHeight).toBe(630);
  });

  it("serves the open share's image publicly and 404s every other share", async () => {
    const ok = await publicShareRoutes.request("/open-share/og-image");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect(ok.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(ok.headers.get("etag")).toMatch(/^"[0-9a-f]{40}-og"$/);
    const body = Buffer.from(await ok.arrayBuffer());
    expect(posterPng.length).toBeGreaterThan(OG_MAX_BYTES);
    expect(body.length).toBeLessThanOrEqual(OG_MAX_BYTES);
    expect(Number(ok.headers.get("content-length"))).toBe(body.length);
    const meta = await sharp(body).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1200);

    for (const token of ["locked-share", "svg-share", "no-such-share"]) {
      const res = await publicShareRoutes.request(`/${token}/og-image`);
      expect(res.status).toBe(404);
    }
  });
});

describe("in-app link previews", () => {
  const view = (id: Types.ObjectId | string) =>
    `/view/${WS}/${encodeURIComponent(typeof id === "string" ? id : id.toHexString())}`;

  it("parses the viewer URL and nothing else", () => {
    expect(appLinkFromPath(view(PLAIN))).toEqual({
      workspaceId: WS,
      ref: PLAIN.toHexString(),
    });
    expect(appLinkFromPath(`/view/${WS}/team%20board/`)?.ref).toBe(
      "team board",
    );
    expect(appLinkFromPath("/apps/plain")).toBeNull();
    expect(appLinkFromPath(`/view/not-an-id/${PLAIN}`)).toBeNull();
  });

  it("names a workspace-wide app, by id or by slug, with its raster thumbnail", async () => {
    for (const ref of [PLAIN.toHexString(), "plain"]) {
      const tags = await ogTagsForPath(view(ref), ORIGIN);
      expect(tags?.title).toBe("Team board");
      expect(tags?.description).toBe("Weekly numbers");
      expect(tags?.url).toBe(`${ORIGIN}${view(ref)}`);
      expect(tags?.image).toMatch(
        new RegExp(
          `^${ORIGIN}/api/og/app-image/${WS}/${PLAIN.toHexString()}\\?v=[0-9a-f]{12}$`,
        ),
      );
    }
  });

  it("stays generic for restricted, personal, unknown apps and opted-out workspaces", async () => {
    for (const ref of [
      RESTRICTED.toHexString(),
      PERSONAL.toHexString(),
      "users/alice/apps/mine",
      "no-such-app",
    ]) {
      const tags = await ogTagsForPath(view(ref), ORIGIN);
      expect(tags?.title).toBe(GENERIC_SHARE_TITLE);
      expect(tags?.image).toBe(`${ORIGIN}/og-default.png`);
      expect(JSON.stringify(tags)).not.toMatch(/Board pack|Alice/);
    }
    await Workspace.updateOne(
      { _id: new Types.ObjectId(WS) },
      { $set: { "settings.linkPreviews": false } },
    );
    const tags = await ogTagsForPath(view(PLAIN), ORIGIN);
    expect(tags?.title).toBe(GENERIC_SHARE_TITLE);
  });

  it("serves the image under the same rule", async () => {
    const ok = await ogRoutes.request(
      `/app-image/${WS}/${PLAIN.toHexString()}`,
    );
    expect(ok.status).toBe(200);
    // Bytes the encoder cannot decode are served as they are.
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(ok.headers.get("etag")).toMatch(/^"[0-9a-f]{40}"$/);
    expect(await ok.text()).toBe("PLAIN-PNG");
    for (const id of [RESTRICTED, PERSONAL, SVG_ONLY]) {
      const res = await ogRoutes.request(
        `/app-image/${WS}/${id.toHexString()}`,
      );
      expect(res.status).toBe(404);
    }
    await Workspace.updateOne(
      { _id: new Types.ObjectId(WS) },
      { $set: { "settings.linkPreviews": false } },
    );
    const off = await ogRoutes.request(
      `/app-image/${WS}/${PLAIN.toHexString()}`,
    );
    expect(off.status).toBe(404);
  });

  it("sends an anonymous browser or crawler from a live link to the viewer page", () => {
    const base = {
      workspaceId: WS,
      ref: "plain",
      path: `/api/workspaces/${WS}/apps/plain/live/`,
      url: `https://app.mako.ai/api/workspaces/${WS}/apps/plain/live/?q=1`,
    };
    expect(
      anonymousViewerRedirect({
        ...base,
        hasCredentials: false,
        accept: "*/*",
        userAgent: "WhatsApp/2.23.20.0",
      }),
    ).toBe(`/view/${WS}/plain?q=1`);
    expect(
      anonymousViewerRedirect({
        ...base,
        hasCredentials: false,
        accept: "text/html,application/xhtml+xml",
        userAgent: "Mozilla/5.0",
      }),
    ).toBe(`/view/${WS}/plain?q=1`);
    // An API client keeps its 401; a signed-in request is served as before.
    expect(
      anonymousViewerRedirect({
        ...base,
        hasCredentials: false,
        accept: "application/json",
        userAgent: "curl/8",
      }),
    ).toBeNull();
    expect(
      anonymousViewerRedirect({
        ...base,
        hasCredentials: true,
        accept: "text/html",
        userAgent: "WhatsApp/2.23",
      }),
    ).toBeNull();
    // Only the app's page: its assets are not redirected.
    expect(
      anonymousViewerRedirect({
        ...base,
        path: `/api/workspaces/${WS}/apps/plain/live/assets/x.js`,
        hasCredentials: false,
        accept: "*/*",
        userAgent: "WhatsApp/2.23",
      }),
    ).toBeNull();
  });
});

describe("helpers", () => {
  it("reads PNG, JPEG and WebP dimensions from headers", () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(1200, 16);
    png.writeUInt32BE(750, 20);
    expect(imageSize(png)).toEqual({ width: 1200, height: 750 });

    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
      0x08, 0x02, 0x76, 0x04, 0xb0, 0x03,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 1200, height: 630 });

    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "ascii");
    webp.write("WEBP", 8, "ascii");
    webp.write("VP8X", 12, "ascii");
    webp.writeUIntLE(1199, 24, 3);
    webp.writeUIntLE(629, 27, 3);
    expect(imageSize(webp)).toEqual({ width: 1200, height: 630 });

    expect(imageSize(Buffer.from("not an image"))).toBeNull();
  });

  it("builds absolute https origins", () => {
    const saved = { c: process.env.CLIENT_URL, p: process.env.PUBLIC_URL };
    delete process.env.CLIENT_URL;
    delete process.env.PUBLIC_URL;
    try {
      expect(publicOrigin("http://pr-1.mako.ai/share/x")).toBe(
        "https://pr-1.mako.ai",
      );
      expect(publicOrigin("http://localhost:8080/share/x")).toBe(
        "http://localhost:8080",
      );
      process.env.CLIENT_URL = "https://app.mako.ai/";
      expect(publicOrigin("http://internal:8080/share/x")).toBe(
        "https://app.mako.ai",
      );
    } finally {
      if (saved.c === undefined) delete process.env.CLIENT_URL;
      else process.env.CLIENT_URL = saved.c;
      if (saved.p === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = saved.p;
    }
  });
});
