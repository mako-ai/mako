/**
 * Durable thumbnail variants: generated once, stored under an oid-derived
 * key, then served from the store by any instance — without git. Plus the
 * main-moved pre-warm and the persisted-index lookup the hot paths use.
 *
 * Real bare repo + in-memory Mongo + the filesystem artifact store.
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
import { initRepo, repoDirFor } from "./repository.service";
import {
  bindTestWorkspaceRepo,
  unbindTestWorkspaceRepo,
} from "./bind-test-workspace-repo";
import {
  invalidateAppsIndexCache,
  loadAppsIndex,
  resolveIndexedAppRef,
} from "./app-index.service";
import { variantCache } from "./image-variants";
import {
  getThumbnailVariant,
  resolveThumbnailVariant,
  resetThumbnailWarmState,
  variantStoreKey,
  warmThumbnailVariants,
} from "./thumbnail-variants.service";
import { getArtifactStore } from "../services/artifact-store.service";
import { backfillThumbnailVariants } from "./thumbnail-warm-boot";
import { ogRoutes } from "../routes/og";
import { RequestTimings, runWithTimings } from "../middleware/server-timing";

let mongo: MongoMemoryServer;
let tmpRoot: string;
let poster: Buffer;

const WS = new Types.ObjectId().toString();
const BOARD = new Types.ObjectId();
const VECTOR = new Types.ObjectId();
const BROKEN = new Types.ObjectId();
const MINE = new Types.ObjectId();

const manifest = (id: Types.ObjectId, title: string) =>
  JSON.stringify({ id: id.toHexString(), schemaVersion: 1, title });

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "thumb-variants-test-"));
  process.env.APPS_GIT_ROOT = path.join(tmpRoot, "repos");
  process.env.APPS_SESSIONS_ROOT = path.join(tmpRoot, "sessions");
  process.env.APPS_SANDBOX_PROVIDER = "local";
  process.env.DASHBOARD_ARTIFACT_DIR = path.join(tmpRoot, "artifacts");
  process.env.SESSION_SECRET ||= "test-secret";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  poster = await sharp({
    create: {
      width: 1200,
      height: 750,
      channels: 3,
      background: "#3a6ea5",
      noise: { type: "gaussian", mean: 128, sigma: 8 },
    },
  })
    .png()
    .toBuffer();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await AppIndexEntry.deleteMany({});
  await AppIndexHead.deleteMany({});
  await AppProject.deleteMany({});
  await unbindTestWorkspaceRepo(WS);
  invalidateAppsIndexCache();
  variantCache.clear();
  resetThumbnailWarmState();
  await fs.rm(path.join(tmpRoot, "repos"), { recursive: true, force: true });
  await fs.rm(path.join(tmpRoot, "artifacts"), {
    recursive: true,
    force: true,
  });
  await initRepo(repoDirFor(WS), {
    "apps/board/mako.json": manifest(BOARD, "Board"),
    "apps/board/thumbnail.png": poster,
    "apps/vector/mako.json": manifest(VECTOR, "Vector"),
    "apps/vector/thumbnail.svg": "<svg/>",
    "apps/broken/mako.json": manifest(BROKEN, "Broken"),
    "apps/broken/thumbnail.png": "NOT-A-PNG",
    "users/alice/apps/mine/mako.json": manifest(MINE, "Mine"),
    "users/alice/apps/mine/thumbnail.png": poster,
  });
  await bindTestWorkspaceRepo(WS);
  await Workspace.updateOne(
    { _id: new Types.ObjectId(WS) },
    { $unset: { "settings.linkPreviews": 1 } },
  );
});

/** Index synced (rows persisted in Mongo), as any instance would leave it. */
async function indexed() {
  const snapshot = await loadAppsIndex(WS);
  const row = (id: Types.ObjectId) =>
    snapshot.apps.find(a => a.appId === id.toHexString())!;
  return { snapshot, row };
}

async function stored(key: string): Promise<boolean> {
  // The upload is fire-and-forget; give it a moment.
  for (let i = 0; i < 50; i++) {
    if (await getArtifactStore().exists(key)) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
}

describe("getThumbnailVariant", () => {
  it("generates once, stores under the oid key, then serves from the store without git", async () => {
    const { row } = await indexed();
    const thumb = row(BOARD).thumbnail!;
    const first = await resolveThumbnailVariant(WS, thumb, { kind: "og" });
    expect(first?.source).toBe("generated");
    const og = first!.variant;
    expect(og.contentType).toBe("image/jpeg");
    expect(og.width).toBe(1200);
    const key = variantStoreKey(WS, thumb.oid, { kind: "og" });
    expect(key).toContain(`/app-thumbnails/${WS}/${thumb.oid}/og.jpg`);
    expect(await stored(key)).toBe(true);

    const lru = await resolveThumbnailVariant(WS, thumb, { kind: "og" });
    expect(lru?.source).toBe("lru");

    // A fresh instance: empty LRU, and no repo to read (unbound). Timed
    // the way the routes are (the shared Server-Timing helper).
    variantCache.clear();
    await unbindTestWorkspaceRepo(WS);
    const timings = new RequestTimings();
    const fresh = await runWithTimings(timings, () =>
      resolveThumbnailVariant(WS, thumb, { kind: "og" }),
    );
    expect(fresh?.source).toBe("store");
    expect([...timings.spans.keys()]).toEqual(["thumb.store"]);
    expect(timings.notes.get("thumb.src")).toBe("store");
    expect(fresh?.variant.bytes.equals(og.bytes)).toBe(true);
    expect(fresh?.variant.width).toBe(1200);
    expect(fresh?.variant.height).toBe(750);
    expect(timings.header(1, 0)).toMatch(
      /thumb\.store;dur=[\d.]+, thumb\.src;desc="store"/,
    );
  });

  it("stores card widths as WebP", async () => {
    const { row } = await indexed();
    const thumb = row(BOARD).thumbnail!;
    const out = await getThumbnailVariant(WS, thumb, {
      kind: "width",
      width: 640,
    });
    expect(out?.contentType).toBe("image/webp");
    expect(out?.width).toBe(640);
    expect(
      await stored(
        variantStoreKey(WS, thumb.oid, { kind: "width", width: 640 }),
      ),
    ).toBe(true);
  });

  it("serves the original for an undecodable image and stores nothing", async () => {
    const { row } = await indexed();
    const thumb = row(BROKEN).thumbnail!;
    const out = await resolveThumbnailVariant(WS, thumb, { kind: "og" });
    expect(out?.source).toBe("fallback");
    expect(out?.variant.transformed).toBe(false);
    expect(out?.variant.bytes.toString()).toBe("NOT-A-PNG");
    await new Promise(r => setTimeout(r, 100));
    expect(
      await getArtifactStore().exists(
        variantStoreKey(WS, thumb.oid, { kind: "og" }),
      ),
    ).toBe(false);
  });
});

describe("warmThumbnailVariants", () => {
  it("pre-generates OG + 640w for workspace apps, 640w for personal ones, skips SVG", async () => {
    const { snapshot, row } = await indexed();
    const first = await warmThumbnailVariants(WS, snapshot.apps);
    // board: og + card; broken: og + card attempted (fallbacks, not stored);
    // mine (personal): card only; vector (svg): nothing.
    expect(first.checked).toBe(5);
    expect(first.generated).toBe(2); // board og + w640 (mine shares its oid)
    const board = row(BOARD).thumbnail!;
    expect(await stored(variantStoreKey(WS, board.oid, { kind: "og" }))).toBe(
      true,
    );
    expect(
      await stored(
        variantStoreKey(WS, board.oid, { kind: "width", width: 640 }),
      ),
    ).toBe(true);

    // Second pass on a fresh process: everything is a store hit.
    variantCache.clear();
    const second = await warmThumbnailVariants(WS, snapshot.apps);
    expect(second.generated).toBe(0);
  });
});

describe("backfillThumbnailVariants (on boot)", () => {
  it("fills missing variants from the persisted index, then finds nothing to do", async () => {
    const { row } = await indexed();
    invalidateAppsIndexCache();
    const first = await backfillThumbnailVariants();
    expect(first.workspaces).toBe(1);
    expect(first.generated).toBe(2);
    const oid = row(BOARD).thumbnail!.oid;
    expect(await stored(variantStoreKey(WS, oid, { kind: "og" }))).toBe(true);
    expect(
      await stored(variantStoreKey(WS, oid, { kind: "width", width: 640 })),
    ).toBe(true);
    variantCache.clear();
    const second = await backfillThumbnailVariants();
    expect(second.generated).toBe(0);
    expect(second.checked).toBe(first.checked);
  });
});

describe("persisted-index lookup", () => {
  it("resolves by id and slug from Mongo rows, with no repo bound", async () => {
    await indexed();
    await unbindTestWorkspaceRepo(WS);
    invalidateAppsIndexCache();
    expect((await resolveIndexedAppRef(WS, BOARD.toHexString()))?.slug).toBe(
      "board",
    );
    expect((await resolveIndexedAppRef(WS, "board"))?.appId).toBe(
      BOARD.toHexString(),
    );
    expect(await resolveIndexedAppRef(WS, "nope")).toBeNull();
    expect(await resolveIndexedAppRef("not-an-id", "board")).toBeNull();
  });

  it("serves the OG image on a 'fresh instance' from store + Mongo alone", async () => {
    const { snapshot } = await indexed();
    await warmThumbnailVariants(WS, snapshot.apps);
    await stored(
      variantStoreKey(
        WS,
        snapshot.apps.find(a => a.slug === "board")!.thumbnail!.oid,
        { kind: "og" },
      ),
    );
    variantCache.clear();
    invalidateAppsIndexCache();
    await unbindTestWorkspaceRepo(WS);
    const res = await ogRoutes.request(
      `/app-image/${WS}/${BOARD.toHexString()}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    // One Server-Timing, from the shared middleware.
    const timing = res.headers.get("server-timing") ?? "";
    expect(timing).toContain('thumb.src;desc="store"');
    expect(timing).toContain("app.lookup;dur=");
    expect(timing.match(/total;dur=/g)).toHaveLength(1);
    expect(res.headers.get("etag")).toMatch(/-og"$/);
  });
});
