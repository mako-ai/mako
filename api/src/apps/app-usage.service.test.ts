/**
 * App usage: the daily rollup, the popularity math, who counts as an author,
 * and who may see which app's numbers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  AppProject,
  AppUsageDaily,
  AppUsageEvent,
} from "../database/workspace-schema";
import {
  acceptUsageBeat,
  anonIdFromCookie,
  classifyReferrer,
  classifyUserAgent,
  computeAppUsageStats,
  getAppUsageStats,
  getRecentlyViewedApps,
  parseCommitAuthors,
  recencyWeight,
  recordAppUsage,
  recordServedOpen,
  resetUsageThrottle,
  servedOpenSource,
  type AppUsageRollup,
} from "./app-usage.service";
import { canSeeIndexedApp } from "./app-authorization";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();
const APP = new Types.ObjectId().toString();
const OTHER_APP = new Types.ObjectId().toString();
const NOW = new Date("2026-10-20T12:00:00Z");
const at = (iso: string) => new Date(iso);
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("expected a value");
  return value;
};

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await AppUsageDaily.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await AppUsageDaily.deleteMany({});
  await AppUsageEvent.deleteMany({});
  await AppProject.deleteMany({});
  resetUsageThrottle();
});

describe("recordAppUsage", () => {
  it("rolls a day of opens and heartbeats into one row", async () => {
    const base = { workspaceId: WS, appId: APP, userId: "u1" } as const;
    await recordAppUsage({
      ...base,
      kind: "open",
      source: "app",
      at: at("2026-10-20T09:00:00Z"),
    });
    await recordAppUsage({
      ...base,
      kind: "heartbeat",
      source: "app",
      at: at("2026-10-20T09:01:00Z"),
    });
    await recordAppUsage({
      ...base,
      kind: "heartbeat",
      source: "app",
      at: at("2026-10-20T09:02:00Z"),
    });
    await recordAppUsage({
      ...base,
      kind: "open",
      source: "embed",
      at: at("2026-10-20T15:00:00Z"),
    });
    const rows = await AppUsageDaily.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: "2026-10-20",
      opens: 2,
      activeSeconds: 120,
      sources: { app: 1, embed: 1 },
    });
    expect(rows[0].firstAt.toISOString()).toBe("2026-10-20T09:00:00.000Z");
    expect(rows[0].lastAt.toISOString()).toBe("2026-10-20T15:00:00.000Z");
  });

  it("starts a new row on a new UTC day, and per viewer", async () => {
    const base = {
      workspaceId: WS,
      appId: APP,
      kind: "open",
      source: "app",
    } as const;
    await recordAppUsage({
      ...base,
      userId: "u1",
      at: at("2026-10-19T23:59:00Z"),
    });
    await recordAppUsage({
      ...base,
      userId: "u1",
      at: at("2026-10-20T00:01:00Z"),
    });
    await recordAppUsage({
      ...base,
      userId: "u2",
      at: at("2026-10-20T00:01:00Z"),
    });
    expect(await AppUsageDaily.countDocuments({})).toBe(3);
  });

  it("collapses anonymous share viewers into one row per app per day", async () => {
    const base = {
      workspaceId: WS,
      appId: APP,
      userId: null,
      kind: "open",
      source: "share",
    } as const;
    await recordAppUsage({ ...base, at: at("2026-10-20T08:00:00Z") });
    await recordAppUsage({ ...base, at: at("2026-10-20T09:00:00Z") });
    const rows = await AppUsageDaily.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: null,
      opens: 2,
      sources: { share: 2 },
    });
  });
});

describe("popularity score", () => {
  const rollup = (
    userId: string | null,
    days: string[],
    appId = APP,
  ): AppUsageRollup => ({
    appId,
    userId,
    days,
    opens: days.length,
    activeSeconds: 0,
    lastAt: new Date(`${[...days].sort().at(-1)}T10:00:00Z`),
  });
  const lastDays = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      new Date(NOW.getTime() - i * 86_400_000).toISOString().slice(0, 10),
    );

  it("halves a day's weight every 14 days", () => {
    expect(recencyWeight("2026-10-20", "2026-10-20")).toBe(1);
    expect(recencyWeight("2026-10-06", "2026-10-20")).toBeCloseTo(0.5);
    expect(recencyWeight("2026-09-22", "2026-10-20")).toBeCloseTo(0.25);
  });

  it("ranks daily-by-many over daily-by-one over once-by-many", () => {
    const daily = lastDays(10);
    const many = ["a", "b", "c", "d", "e"];
    const stats = computeAppUsageStats(
      [
        ...many.map(u => rollup(u, daily, "daily-many")),
        rollup("a", daily, "daily-one"),
        ...many.map(u => rollup(u, [daily[0]], "once-many")),
      ],
      new Map(),
      NOW,
    );
    const score = (id: string) => must(stats.get(id)).score;
    expect(score("daily-many")).toBeGreaterThan(score("daily-one"));
    expect(score("daily-one")).toBeGreaterThan(score("once-many"));
    expect(stats.get("daily-many")).toMatchObject({
      viewers: 5,
      nonAuthorViewers: 5,
      viewerDays: 50,
    });
  });

  it("leaves authors out of the score but not out of last-opened", () => {
    const stats = must(
      computeAppUsageStats(
        [rollup("author", lastDays(20)), rollup("fan", ["2026-10-01"])],
        new Map([[APP, new Set(["author"])]]),
        NOW,
      ).get(APP),
    );
    expect(stats.viewers).toBe(2);
    expect(stats.nonAuthorViewers).toBe(1);
    expect(stats.viewerDays).toBe(1);
    expect(stats.score).toBeCloseTo(
      recencyWeight("2026-10-01", "2026-10-20"),
      3,
    );
    expect(stats.lastOpenedAt).toBe("2026-10-20T10:00:00.000Z");
    expect(stats.lastNonAuthorOpenedAt).toBe("2026-10-01T10:00:00.000Z");
  });

  it("counts anonymous views as activity, never as viewers or score", () => {
    const stats = must(
      computeAppUsageStats([rollup(null, lastDays(5))], new Map(), NOW).get(
        APP,
      ),
    );
    expect(stats).toMatchObject({
      viewers: 0,
      nonAuthorViewers: 0,
      score: 0,
      opens: 5,
    });
    expect(stats.lastNonAuthorOpenedAt).not.toBeNull();
  });
});

describe("getAppUsageStats", () => {
  it("excludes the app's owner and reads only the window", async () => {
    await AppProject.create({
      _id: new Types.ObjectId(APP),
      workspaceId: new Types.ObjectId(WS),
      title: "Sales",
      slug: "sales",
      access: "workspace",
      createdBy: "owner",
      owner_id: "owner",
    });
    const open = (userId: string, iso: string, appId = APP) =>
      recordAppUsage({
        workspaceId: WS,
        appId,
        userId,
        kind: "open",
        source: "app",
        at: at(iso),
      });
    await open("owner", "2026-10-20T08:00:00Z");
    await open("owner", "2026-10-19T08:00:00Z");
    await open("viewer", "2026-10-18T08:00:00Z");
    await open("viewer", "2026-08-01T08:00:00Z"); // outside 28 days
    await open("viewer", "2026-10-20T08:00:00Z", OTHER_APP);

    const stats = await getAppUsageStats(WS, { now: NOW });
    expect(stats.get(APP)).toMatchObject({
      viewers: 2,
      nonAuthorViewers: 1,
      viewerDays: 1,
      opens: 3,
      lastNonAuthorOpenedAt: "2026-10-18T08:00:00.000Z",
    });
    expect(must(stats.get(APP)).score).toBeCloseTo(
      recencyWeight("2026-10-18", "2026-10-20"),
      3,
    );
    expect(stats.get(OTHER_APP)).toMatchObject({
      nonAuthorViewers: 1,
      score: 1,
    });

    const wide = await getAppUsageStats(WS, { now: NOW, days: 90 });
    expect(must(wide.get(APP)).viewerDays).toBe(2);
  });

  it("never mixes workspaces", async () => {
    await recordAppUsage({
      workspaceId: new Types.ObjectId().toString(),
      appId: APP,
      userId: "u",
      kind: "open",
      source: "app",
      at: NOW,
    });
    expect((await getAppUsageStats(WS, { now: NOW })).size).toBe(0);
  });
});

describe("getRecentlyViewedApps", () => {
  it("lists the caller's apps, newest first", async () => {
    const open = (userId: string, appId: string, iso: string) =>
      recordAppUsage({
        workspaceId: WS,
        appId,
        userId,
        kind: "open",
        source: "app",
        at: at(iso),
      });
    await open("me", APP, "2026-10-18T08:00:00Z");
    await open("me", OTHER_APP, "2026-10-19T08:00:00Z");
    await open("me", APP, "2026-10-20T08:00:00Z");
    await open("someone", OTHER_APP, "2026-10-20T11:00:00Z");
    expect(await getRecentlyViewedApps(WS, "me", { now: NOW })).toEqual([
      { appId: APP, lastOpenedAt: "2026-10-20T08:00:00.000Z" },
      { appId: OTHER_APP, lastOpenedAt: "2026-10-19T08:00:00.000Z" },
    ]);
    expect(
      await getRecentlyViewedApps(WS, "me", { now: NOW, limit: 1 }),
    ).toHaveLength(1);
  });
});

describe("parseCommitAuthors", () => {
  const apps = [
    { appId: "a1", path: "apps/sales/report" },
    { appId: "a2", path: "apps/hr" },
    { appId: "a3", path: "users/u1/apps/scratch" },
    { appId: "a4", path: "apps/ops" },
    { appId: "a5", path: "apps/fin" },
  ];

  it("maps committers to the apps whose folders they touched", () => {
    const log = [
      "\0Jonas@Acme.com\n\napps/sales/report/src/App.tsx\napps/sales/report/mako.json",
      "\0vadim@acme.com\n\nusers/u1/apps/scratch/index.html\napps/hr/x.ts",
      "\0bot@mako.ai\n\nAGENTS.md",
    ].join("\n");
    const out = parseCommitAuthors(log, apps);
    expect([...must(out.get("a1"))]).toEqual(["jonas@acme.com"]);
    expect([...must(out.get("a2"))]).toEqual(["vadim@acme.com"]);
    expect([...must(out.get("a3"))]).toEqual(["vadim@acme.com"]);
    expect(out.has("a4")).toBe(false);
  });

  it("does not make a sweeping commit's author an author of every app", () => {
    const log =
      "\0sweeper@acme.com\n\n" +
      apps.map(a => `${a.path}/package.json`).join("\n");
    expect(parseCommitAuthors(log, apps).size).toBe(0);
  });

  it("does not confuse sibling folders sharing a prefix", () => {
    const out = parseCommitAuthors("\0x@acme.com\n\napps/hr-old/a.ts", apps);
    expect(out.size).toBe(0);
  });
});

describe("who sees an app's numbers", () => {
  it("follows the app list: ACL when there is a row, the tree otherwise", () => {
    const personal = { scope: "private", ownerId: "u1" };
    const shared = { scope: "workspace" };
    expect(canSeeIndexedApp(personal, null, "u1", "member")).toBe(true);
    expect(canSeeIndexedApp(personal, null, "u2", "admin")).toBe(false);
    expect(canSeeIndexedApp(shared, null, "u2", "viewer")).toBe(true);
    const privateRow = {
      access: "private" as const,
      owner_id: "u1",
      createdBy: "u1",
    };
    expect(canSeeIndexedApp(shared, privateRow, "u1", "member")).toBe(true);
    expect(canSeeIndexedApp(shared, privateRow, "u2", "admin")).toBe(false);
    expect(
      canSeeIndexedApp(
        shared,
        {
          ...privateRow,
          sharedWith: [{ userId: "u2", role: "viewer" as const }],
        },
        "u2",
        "member",
      ),
    ).toBe(true);
  });
});

describe("throttle and served opens", () => {
  it("accepts one open per 10 s and one heartbeat per 30 s", () => {
    expect(acceptUsageBeat("k", "open", 0)).toBe(true);
    expect(acceptUsageBeat("k", "open", 5_000)).toBe(false);
    expect(acceptUsageBeat("k", "open", 10_000)).toBe(true);
    expect(acceptUsageBeat("k", "heartbeat", 0)).toBe(true);
    expect(acceptUsageBeat("k", "heartbeat", 20_000)).toBe(false);
    expect(acceptUsageBeat("k", "heartbeat", 60_000)).toBe(true);
  });

  it("counts only the HTML entry loaded as a page or a frame", () => {
    expect(
      servedOpenSource("document", "text/html; charset=utf-8", "share"),
    ).toBe("share");
    expect(servedOpenSource("iframe", "text/html", "share")).toBe("embed");
    expect(servedOpenSource("document", "text/html", "app")).toBe("app");
    expect(servedOpenSource("script", "text/javascript", "share")).toBeNull();
    expect(servedOpenSource("empty", "text/html", "share")).toBeNull();
    expect(servedOpenSource(undefined, "text/html", "share")).toBeNull();
  });
});

describe("raw event log", () => {
  it("keeps every event, with what ranking needs later", async () => {
    await recordAppUsage({
      workspaceId: WS,
      appId: APP,
      userId: "u1",
      kind: "open",
      source: "app",
      sessionId: "s1",
      referrerKind: "external",
      uaClass: "desktop",
      at: at("2026-10-20T09:00:00Z"),
    });
    await recordAppUsage({
      workspaceId: WS,
      appId: APP,
      userId: "u1",
      kind: "heartbeat",
      source: "app",
      sessionId: "s1",
      uaClass: "desktop",
      at: at("2026-10-20T09:01:00Z"),
    });
    const events = await AppUsageEvent.find({}).sort({ at: 1 }).lean();
    expect(events.map(e => e.kind)).toEqual(["open", "heartbeat"]);
    expect(events[0]).toMatchObject({
      userId: "u1",
      anonId: null,
      sessionId: "s1",
      referrerKind: "external",
      uaClass: "desktop",
    });
    expect(events.every(e => !e.throttled)).toBe(true);
  });

  it("logs a throttled open flagged, and leaves it out of the rollup", async () => {
    const base = {
      workspaceId: WS,
      appId: APP,
      userId: "u1",
      kind: "open",
      source: "app",
    } as const;
    await recordAppUsage({ ...base, at: NOW });
    await recordAppUsage({ ...base, at: NOW, throttled: true });
    const events = await AppUsageEvent.find({}).lean();
    expect(events).toHaveLength(2);
    expect(events.filter(e => e.throttled)).toHaveLength(1);
    const [row] = await AppUsageDaily.find({}).lean();
    expect(row.opens).toBe(1);
  });

  it("logs bots but never counts them", async () => {
    await recordAppUsage({
      workspaceId: WS,
      appId: APP,
      userId: null,
      anonId: anonIdFromCookie("abcdefghijklmnopqrstuv"),
      kind: "open",
      source: "share",
      uaClass: "bot",
      at: NOW,
    });
    expect(await AppUsageEvent.countDocuments({ uaClass: "bot" })).toBe(1);
    expect(await AppUsageDaily.countDocuments({})).toBe(0);
  });

  it("expires events after about 13 months", async () => {
    await AppUsageEvent.syncIndexes();
    const ttl = (await AppUsageEvent.collection.indexes()).find(
      i => i.expireAfterSeconds !== undefined,
    );
    expect(ttl?.key).toEqual({ at: 1 });
    expect(ttl?.expireAfterSeconds).toBe(400 * 24 * 60 * 60);
  });
});

describe("anonymous viewers", () => {
  const anonA = anonIdFromCookie("cookie-a-0123456789abcdef");
  const anonB = anonIdFromCookie("cookie-b-0123456789abcdef");

  it("hashes the cookie under an anon: prefix, never storing it", () => {
    expect(anonA).toMatch(/^anon:[A-Za-z0-9_-]{22}$/);
    expect(anonA).not.toContain("cookie-a");
    expect(anonIdFromCookie("cookie-a-0123456789abcdef")).toBe(anonA);
    expect(anonB).not.toBe(anonA);
  });

  it("are counted apart from people, and never in the score", async () => {
    const open = (anonId: string | null, iso: string) =>
      recordAppUsage({
        workspaceId: WS,
        appId: APP,
        userId: null,
        anonId,
        kind: "open",
        source: "share",
        at: at(iso),
      });
    await open(anonA, "2026-10-19T08:00:00Z");
    await open(anonA, "2026-10-20T08:00:00Z");
    await open(anonB, "2026-10-20T09:00:00Z");
    await open(null, "2026-10-20T10:00:00Z");
    await recordAppUsage({
      workspaceId: WS,
      appId: APP,
      userId: "u1",
      kind: "open",
      source: "app",
      at: at("2026-10-20T11:00:00Z"),
    });
    const stats = must((await getAppUsageStats(WS, { now: NOW })).get(APP));
    expect(stats).toMatchObject({
      viewers: 1,
      nonAuthorViewers: 1,
      viewerDays: 1,
      allViewerDays: 1,
      anonViewers: 2,
      anonViewerDays: 3,
      opens: 5,
      score: 1,
    });
    expect(stats.lastNonAuthorOpenedAt).toBe("2026-10-20T11:00:00.000Z");
  });

  it("include the authors' own days in allViewerDays only", () => {
    const stats = must(
      computeAppUsageStats(
        [
          {
            appId: APP,
            userId: "author",
            days: ["2026-10-19", "2026-10-20"],
            opens: 2,
            activeSeconds: 0,
            lastAt: NOW,
          },
        ],
        new Map([[APP, new Set(["author"])]]),
        NOW,
      ).get(APP),
    );
    expect(stats).toMatchObject({
      viewers: 1,
      allViewerDays: 2,
      viewerDays: 0,
    });
  });
});

describe("served opens", () => {
  it("records a share page load with its anon id, referrer and client", async () => {
    const anonId = anonIdFromCookie("served-cookie-0123456789");
    const served = {
      workspaceId: WS,
      appId: APP,
      userId: null,
      anonId,
      viewerKey: "anon:served-cookie",
      fetchDest: "document",
      contentType: "text/html",
      pageSource: "share",
    } as const;
    const counted = recordServedOpen({
      ...served,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148",
      referer: "https://app.slack.com/client/T1/C1",
      host: "app.mako.ai",
    });
    expect(counted).toBe(true);
    await expect
      .poll(() => AppUsageEvent.countDocuments({}), { timeout: 2000 })
      .toBe(1);
    const event = await AppUsageEvent.findOne({}).lean();
    expect(event).toMatchObject({
      source: "share",
      userId: null,
      anonId,
      uaClass: "mobile",
      referrerKind: "external",
    });
    expect(event?.sessionId).toBeTruthy();
    // A reload a second later is logged, flagged, and not double counted.
    recordServedOpen(served);
    await expect
      .poll(() => AppUsageEvent.countDocuments({ throttled: true }), {
        timeout: 2000,
      })
      .toBe(1);
    const row = await AppUsageDaily.findOne({}).lean();
    expect(row?.opens).toBe(1);
    expect(row?.userId).toBe(anonId);
  });

  it("ignores the bundle's own requests", () => {
    expect(
      recordServedOpen({
        workspaceId: WS,
        appId: APP,
        userId: null,
        viewerKey: "x",
        fetchDest: "script",
        contentType: "text/javascript",
        pageSource: "share",
      }),
    ).toBe(false);
  });
});

describe("classifiers", () => {
  it("tells bots, phones and desktops apart", () => {
    expect(
      classifyUserAgent(
        "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      ),
    ).toBe("bot");
    expect(classifyUserAgent("facebookexternalhit/1.1")).toBe("bot");
    expect(classifyUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(
      "bot",
    );
    expect(classifyUserAgent("curl/8.4.0")).toBe("bot");
    expect(
      classifyUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36",
      ),
    ).toBe("mobile");
    expect(
      classifyUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36",
      ),
    ).toBe("desktop");
    expect(classifyUserAgent(undefined)).toBe("unknown");
  });

  it("tells our own pages from other sites and from nothing", () => {
    expect(classifyReferrer(undefined, "app.mako.ai")).toBe("direct");
    expect(classifyReferrer("https://app.mako.ai/share/x", "app.mako.ai")).toBe(
      "internal",
    );
    expect(classifyReferrer("https://pr-12.mako.ai/view/w/a", "run.app")).toBe(
      "internal",
    );
    expect(classifyReferrer("https://www.notion.so/page", "app.mako.ai")).toBe(
      "external",
    );
    expect(classifyReferrer("not a url", "app.mako.ai")).toBe("direct");
  });
});
