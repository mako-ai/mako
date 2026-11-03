/**
 * Share links on the app's own origin (apps.md §31): with APPS_ORIGIN_BASE
 * set, `GET /api/share/<t>/content` hands out the app on
 * `<appId>.<apps domain>` under a published token the SHARE minted.
 *
 * Pinned here, against the real share, token and host-gate code and real
 * Mongo:
 * - flag off, /content is byte-for-byte what it was (no `appUrl`);
 * - the token names the share's app and published commit, no viewer, and
 *   is one string for a whole window (cache hits across visits);
 * - disabled, rotated, unpublished and still-locked shares get no token; a
 *   password share gets one after unlock, never outliving the unlock;
 * - the host gate serves a share token on its own app's host only;
 * - a share token's refresh follows the SHARE's rules (enabled, current,
 *   allowLiveQueries, cooldown), not a member's.
 */
import bcrypt from "bcrypt";
import { Hono } from "hono";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const served = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  refreshes: [] as Array<Record<string, unknown>>,
}));

vi.mock("./deployment.service", () => ({
  contentTypeFor: () => "text/html; charset=utf-8",
  serveDeploymentFile: async (input: Record<string, unknown>) => {
    served.calls.push(input);
    return new Response("<!doctype html><title>app</title>", {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-cache",
      },
    });
  },
}));

vi.mock("./binding-refresh", async importOriginal => ({
  ...(await importOriginal<typeof import("./binding-refresh")>()),
  refreshBindingHttp: async (input: Record<string, unknown>) => {
    served.refreshes.push(input);
    return { status: 200, body: { success: true }, headers: {} };
  },
}));

import { appsHostGate } from "../middleware/apps-host-gate";
import { appsPreviewRoutes } from "../routes/apps-preview";
import { publicShareRoutes } from "../routes/public-share";
import { AppProject, type IAppProject } from "../database/workspace-schema";
import {
  mintPublishedGrant,
  resolvePreviewGrant,
  shareFingerprint,
} from "./preview.service";

const SHA = "38ce8e7b28e8ace0c1d83bdacb95e28df3d5175b";
const OPEN = "open-share";
const LOCKED = "locked-share";
const DRAFT = "draft-share";
const HOUR = 60 * 60 * 1000;

function server() {
  const app = new Hono();
  app.use("*", appsHostGate);
  app.route("/api/share", publicShareRoutes);
  app.route("/api/apps-preview", appsPreviewRoutes);
  return app;
}

let mongo: MongoMemoryServer;
let open: IAppProject;
let locked: IAppProject;
let other: IAppProject;

beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "share-app-origin-test-secret");
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  vi.stubEnv("CLIENT_URL", "https://app.mako.ai");
  vi.stubEnv("APPS_ORIGIN_BASE", "https://makoapps.dev");
  served.calls.length = 0;
  served.refreshes.length = 0;
  await AppProject.deleteMany({});
  const passwordHash = await bcrypt.hash("pw", 4);
  const base = {
    workspaceId: new Types.ObjectId(),
    access: "workspace",
    owner_id: "owner",
    createdBy: "owner",
    publishedSha: SHA,
  };
  [open, locked, other] = await AppProject.create([
    {
      ...base,
      title: "Open",
      slug: "open",
      publicShare: { enabled: true, token: OPEN },
    },
    {
      ...base,
      title: "Locked",
      slug: "locked",
      publicShare: { enabled: true, token: LOCKED, passwordHash },
    },
    { ...base, title: "Other", slug: "other" },
  ]);
  await AppProject.create({
    ...base,
    publishedSha: undefined,
    title: "Draft",
    slug: "draft",
    publicShare: { enabled: true, token: DRAFT },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.stubEnv("APPS_ORIGIN_BASE", "https://makoapps.dev");
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  vi.unstubAllEnvs();
});

async function content(token: string, cookie?: string) {
  const res = await server().request(`/api/share/${token}/content`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  const json = (await res.json().catch(() => null)) as {
    data?: Record<string, unknown>;
  } | null;
  return { res, data: json?.data ?? null };
}

async function unlock(token: string): Promise<string> {
  const res = await server().request(`/api/share/${token}/unlock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "pw" }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

/** The token inside an app-origin URL. */
function tokenOf(appUrl: unknown): string {
  const match = /\/api\/apps-preview\/([^/]+)\/$/.exec(String(appUrl));
  expect(match).toBeTruthy();
  return decodeURIComponent(match?.[1] ?? "");
}

const onHost = (host: string, path: string, init: RequestInit = {}) =>
  server().request(path, {
    ...init,
    headers: { host, ...(init.headers ?? {}) },
  });

describe("flag off", () => {
  it("answers /content exactly as master: no appUrl, navigate to entry", async () => {
    vi.stubEnv("APPS_ORIGIN_BASE", "");
    const { res, data } = await content(OPEN);
    expect(res.status).toBe(200);
    expect(data).toEqual({
      kind: "app",
      title: "Open",
      published: true,
      entry: `/api/share/${OPEN}/app/`,
    });
    // No open is recorded here: the /app/ document load still counts it.
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("the token a share mints", () => {
  it("names the share's app and published commit, no viewer, on the app's host", async () => {
    const { res, data } = await content(OPEN);
    expect(res.status).toBe(200);
    expect(data?.entry).toBe(`/api/share/${OPEN}/app/`);
    expect(String(data?.appUrl)).toMatch(
      new RegExp(
        `^https://${open._id}\\.makoapps\\.dev/api/apps-preview/pub\\.`,
      ),
    );
    const grant = resolvePreviewGrant(tokenOf(data?.appUrl));
    expect(grant).toMatchObject({
      projectId: open._id.toString(),
      workspaceId: open.workspaceId.toString(),
      publishedSha: SHA,
      share: shareFingerprint(OPEN),
    });
    expect(grant?.viewer).toBeUndefined();
    // The fingerprint does not reveal the share token.
    expect(tokenOf(data?.appUrl)).not.toContain(OPEN);
    expect(
      Buffer.from(tokenOf(data?.appUrl).split(".")[1], "base64url").toString(),
    ).not.toContain(OPEN);
    // This call is the view now: the anonymous id cookie is set here.
    expect(res.headers.get("set-cookie")).toContain("mako_viewer=");
  });

  it("is one string for a whole window, so repeat visits are cache hits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T10:00:01Z"));
    const first = (await content(OPEN)).data?.appUrl;
    vi.setSystemTime(new Date("2026-10-22T10:59:59Z"));
    expect((await content(OPEN)).data?.appUrl).toBe(first);
    vi.setSystemTime(new Date("2026-10-22T11:00:01Z"));
    expect((await content(OPEN)).data?.appUrl).not.toBe(first);
    // An already-minted token lives on until its window ends + 30 min,
    // then stops working whatever happens to the share.
    const grant = resolvePreviewGrant(tokenOf(first));
    expect(grant?.expiresAt).toBe(Date.parse("2026-10-22T11:30:00Z"));
    vi.setSystemTime(new Date("2026-10-22T11:30:01Z"));
    expect(resolvePreviewGrant(tokenOf(first))).toBeNull();
  });

  it("is refused for a disabled, rotated or unpublished share", async () => {
    await AppProject.updateOne(
      { _id: open._id },
      { $set: { "publicShare.enabled": false } },
    );
    expect((await content(OPEN)).res.status).toBe(404);
    await AppProject.updateOne(
      { _id: open._id },
      { $set: { "publicShare.enabled": true, "publicShare.token": "rotated" } },
    );
    expect((await content(OPEN)).res.status).toBe(404);
    const draft = await content(DRAFT);
    expect(draft.res.status).toBe(200);
    expect(draft.data?.published).toBe(false);
    expect(draft.data?.appUrl).toBeUndefined();
  });
});

describe("password shares", () => {
  it("get no token before unlock", async () => {
    const { res, data } = await content(LOCKED);
    expect(res.status).toBe(401);
    expect(data).toBeNull();
  });

  it("get one after unlock, scoped to the app", async () => {
    const cookie = await unlock(LOCKED);
    const { res, data } = await content(LOCKED, cookie);
    expect(res.status).toBe(200);
    const grant = resolvePreviewGrant(tokenOf(data?.appUrl));
    expect(grant?.projectId).toBe(locked._id.toString());
    expect(grant?.share).toBe(shareFingerprint(LOCKED));
  });

  it("never outlive the 12 h unlock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const unlockedAt = Date.parse("2026-10-22T00:10:00Z");
    vi.setSystemTime(unlockedAt);
    const cookie = await unlock(LOCKED);
    const unlockEnds = unlockedAt + 12 * HOUR;
    // Early on, the usual window bound applies (identical URLs per window).
    const early = resolvePreviewGrant(
      tokenOf((await content(LOCKED, cookie)).data?.appUrl),
    );
    expect(early?.expiresAt).toBe(
      Date.parse("2026-10-22T01:00:00Z") + 30 * 60 * 1000,
    );
    // Near the end of the unlock, the unlock is the bound.
    vi.setSystemTime(unlockEnds - 10 * 60 * 1000);
    const late = resolvePreviewGrant(
      tokenOf((await content(LOCKED, cookie)).data?.appUrl),
    );
    expect(late?.expiresAt).toBe(unlockEnds);
    // Past it: no content, so no token.
    vi.setSystemTime(unlockEnds + 1);
    expect((await content(LOCKED, cookie)).res.status).toBe(401);
  });
});

describe("the app host gate", () => {
  it("serves a share token on its own app's host, cacheable, anonymous", async () => {
    const appUrl = (await content(OPEN)).data?.appUrl;
    const url = new URL(String(appUrl));
    served.calls.length = 0;
    const res = await onHost(url.host, url.pathname);
    expect(res.status).toBe(200);
    expect(served.calls[0]).toMatchObject({
      projectId: open._id.toString(),
      sha: SHA,
      viewer: null,
    });
    expect(served.calls[0]?.immutableUntil).toBeGreaterThan(Date.now());
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors https://app.mako.ai",
    );
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("refuses a share token on another app's host", async () => {
    const url = new URL(String((await content(OPEN)).data?.appUrl));
    served.calls.length = 0;
    const res = await onHost(`${other._id}.makoapps.dev`, url.pathname);
    expect(res.status).toBe(404);
    expect(served.calls).toHaveLength(0);
  });

  it("does not answer the share routes on an app host", async () => {
    const host = `${open._id}.makoapps.dev`;
    for (const path of [
      `/api/share/${OPEN}`,
      `/api/share/${OPEN}/content`,
      `/api/share/${OPEN}/app/`,
    ]) {
      expect((await onHost(host, path)).status).toBe(404);
    }
  });
});

describe("refresh under a share token", () => {
  async function refresh(token: string, host = `${open._id}.makoapps.dev`) {
    return onHost(host, `/api/apps-preview/${token}/__data/rows/refresh`, {
      method: "POST",
    });
  }
  async function openToken() {
    return tokenOf((await content(OPEN)).data?.appUrl);
  }

  it("is refused while the owner has not allowed live queries", async () => {
    const res = await refresh(await openToken());
    expect(res.status).toBe(403);
    expect(served.refreshes).toHaveLength(0);
  });

  it("runs throttled, as nobody, at the token's commit, once allowed", async () => {
    await AppProject.updateOne(
      { _id: open._id },
      { $set: { "publicShare.allowLiveQueries": true } },
    );
    const res = await refresh(await openToken());
    expect(res.status).toBe(200);
    expect(served.refreshes[0]).toMatchObject({
      name: "rows",
      actorId: "",
      at: SHA,
      cooldownMs: 5 * 60 * 1000,
    });
  });

  it("stops at once when the share is disabled or rotated", async () => {
    await AppProject.updateOne(
      { _id: open._id },
      { $set: { "publicShare.allowLiveQueries": true } },
    );
    const token = await openToken();
    await AppProject.updateOne(
      { _id: open._id },
      { $set: { "publicShare.enabled": false } },
    );
    expect((await refresh(token)).status).toBe(404);
    await AppProject.updateOne(
      { _id: open._id },
      { $set: { "publicShare.enabled": true, "publicShare.token": "rotated" } },
    );
    expect((await refresh(token)).status).toBe(404);
    expect(served.refreshes).toHaveLength(0);
  });

  it("leaves a member's view token on the member path (no share cooldown)", async () => {
    const member = mintPublishedGrant({
      workspaceId: open.workspaceId.toString(),
      projectId: open._id.toString(),
      sha: SHA,
      viewer: { id: "u1", email: "sam@acme.com" },
      stableWindowMs: HOUR,
    });
    const res = await refresh(member.token);
    expect(res.status).toBe(200);
    expect(served.refreshes[0]?.cooldownMs).toBeUndefined();
  });
});
