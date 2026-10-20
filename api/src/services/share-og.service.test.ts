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
import {
  AppIndexEntry,
  AppIndexHead,
  AppProject,
} from "../database/workspace-schema";
import { initRepo, repoDirFor } from "../apps/repository.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "../apps/bind-test-workspace-repo";
import { invalidateAppsIndexCache } from "../apps/app-index.service";
import { publicShareRoutes } from "../routes/public-share";
import {
  GENERIC_SHARE_TITLE,
  imageSize,
  injectOgTags,
  ogTagsForShare,
  publicOrigin,
  shareTokenFromPath,
} from "./share-og.service";

let mongo: MongoMemoryServer;
let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "share-og-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.SESSION_SECRET ||= "test-secret";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
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
    "apps/open/thumbnail.png": "PNG-BYTES",
    "apps/locked/mako.json": manifest(LOCKED, "Secret board", "Do not leak"),
    "apps/locked/thumbnail.png": "SECRET-PNG",
    "apps/svg/mako.json": manifest(
      SVG_ONLY,
      "Vector only",
      `A very long description ${"word ".repeat(80)}end`,
    ),
    "apps/svg/thumbnail.svg": "<svg/>",
  });
  await bindTestWorkspaceRepo(WS);
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
    expect(tags.imageType).toBe("image/png");

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
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(ok.headers.get("etag")).toMatch(/^"[0-9a-f]{40}"$/);
    expect(await ok.text()).toBe("PNG-BYTES");

    for (const token of ["locked-share", "svg-share", "no-such-share"]) {
      const res = await publicShareRoutes.request(`/${token}/og-image`);
      expect(res.status).toBe(404);
    }
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
