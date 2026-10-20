/**
 * The Apps home feed: the ranking formula, the shelves, the cursor, and
 * paging that never repeats, skips or leaks an app.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  AppFeedSnapshot,
  AppProject,
  AppUsageDaily,
  AppUsageEvent,
} from "../database/workspace-schema";
import type { DiscoveryApp } from "./app-discovery.service";
import {
  buildFeedOrder,
  coUsageScores,
  decodeFeedCursor,
  encodeFeedCursor,
  FEED_WEIGHTS,
  folderOf,
  pickShelves,
  rankRecommended,
  seededUnit,
  type FeedSignals,
} from "./app-feed";
import {
  defaultFeedDeps,
  FeedCursorError,
  getFeedPage,
  loadFeedSignals,
  type FeedDeps,
  type StoredFeedSnapshot,
} from "./app-feed.service";
import { canSeeIndexedApp } from "./app-authorization";
import { recordAppUsage, resetUsageThrottle } from "./app-usage.service";

const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();
const ME = { id: "me", email: "me@example.com" };

let seq = 0;
function app(overrides: Partial<DiscoveryApp> = {}): DiscoveryApp {
  seq += 1;
  const id = overrides.id ?? `app${String(seq).padStart(3, "0")}`;
  return {
    id,
    slug: id,
    path: `apps/${id}`,
    scope: "workspace",
    title: overrides.title ?? `App ${id}`,
    access: "workspace",
    // Old, published, no extras: a neutral baseline.
    createdAt: daysAgo(400),
    publishedAt: daysAgo(400),
    publishedSha: "abc",
    verified: false,
    thumbnail: null,
    scheduled: false,
    tables: [],
    dataRefreshedAt: null,
    health: { bindingErrors: [] },
    ...overrides,
  };
}

const signals = (s: Partial<FeedSignals> = {}): FeedSignals => ({
  popularity: new Map(),
  mine: new Map(),
  coUsage: new Map(),
  ...s,
});

/** Rank with the exploration jitter's effect visible but bounded. */
const order = (
  apps: DiscoveryApp[],
  sig: FeedSignals,
  viewer = ME,
  now = NOW,
) => rankRecommended(apps, sig, viewer, now).map(r => r.id);

const termsOf = (apps: DiscoveryApp[], sig: FeedSignals, id: string) => {
  const hit = rankRecommended(apps, sig, ME, NOW).find(r => r.id === id);
  if (!hit) throw new Error(`no ${id}`);
  return hit;
};

describe("rankRecommended", () => {
  it("log-damps popularity so giants do not flatten the rest", () => {
    const apps = [
      app({ id: "giant" }),
      app({ id: "mid" }),
      app({ id: "none" }),
    ];
    const sig = signals({
      popularity: new Map([
        ["giant", 100],
        ["mid", 10],
      ]),
    });
    const giant = termsOf(apps, sig, "giant").terms.popularity ?? 0;
    const mid = termsOf(apps, sig, "mid").terms.popularity ?? 0;
    expect(giant).toBeCloseTo(FEED_WEIGHTS.popularity, 6);
    // Linear would be 0.1; log(11)/log(101) ≈ 0.52.
    expect(mid / giant).toBeGreaterThan(0.5);
    expect(termsOf(apps, sig, "none").terms.popularity).toBeUndefined();
    expect(order(apps, sig).slice(0, 2)).toEqual(["giant", "mid"]);
  });

  it("boosts fresh publishes and brand-new apps", () => {
    const apps = [
      app({ id: "old" }),
      app({ id: "republished", publishedAt: daysAgo(1) }),
      app({ id: "brandnew", createdAt: daysAgo(1), publishedAt: daysAgo(1) }),
    ];
    const ranked = rankRecommended(apps, signals(), ME, NOW);
    const by = new Map(ranked.map(r => [r.id, r]));
    expect(by.get("brandnew")?.terms.newBoost).toBeGreaterThan(0.35);
    expect(by.get("republished")?.terms.newBoost).toBeUndefined();
    expect(by.get("republished")?.terms.recency ?? 0).toBeGreaterThan(
      by.get("old")?.terms.recency ?? 0,
    );
    expect(order(apps, signals())).toEqual(["brandnew", "republished", "old"]);
  });

  it("rewards apps I return to, but demotes one I opened today", () => {
    const apps = [
      app({ id: "daily" }),
      app({ id: "once" }),
      app({ id: "justnow" }),
      app({ id: "never" }),
    ];
    const sig = signals({
      mine: new Map([
        ["daily", { days: 12, lastAt: daysAgo(3) }],
        ["once", { days: 1, lastAt: daysAgo(3) }],
        ["justnow", { days: 12, lastAt: daysAgo(0.1) }],
      ]),
    });
    const ranked = order(apps, sig);
    expect(ranked.indexOf("daily")).toBeLessThan(ranked.indexOf("once"));
    expect(ranked.indexOf("once")).toBeLessThan(ranked.indexOf("never"));
    // Opened two hours ago: below what I have never seen.
    expect(ranked.at(-1)).toBe("justnow");
    expect(termsOf(apps, sig, "daily").terms.myReturns).toBeCloseTo(
      FEED_WEIGHTS.myReturns,
      6,
    );
  });

  it("finds apps that read the same tables as the apps I use", () => {
    const apps = [
      app({ id: "used", tables: ["close.leads", "close.opps"] }),
      app({ id: "sibling", tables: ["close.leads", "stripe.charges"] }),
      app({ id: "stranger", tables: ["stripe.charges"] }),
    ];
    const sig = signals({
      mine: new Map([["used", { days: 1, lastAt: daysAgo(5) }]]),
    });
    expect(termsOf(apps, sig, "sibling").terms.sharedTables).toBeCloseTo(
      FEED_WEIGHTS.sharedTables / 2,
      6,
    );
    expect(termsOf(apps, sig, "stranger").terms.sharedTables).toBeUndefined();
    // An app does not share tables with itself.
    expect(termsOf(apps, sig, "used").terms.sharedTables).toBeUndefined();
  });

  it("likes the folders and owners of apps I use, never my own", () => {
    const apps = [
      app({ id: "used", path: "apps/Sales/used", ownerId: "alice" }),
      app({ id: "folder", path: "apps/Sales/folder" }),
      app({ id: "owner", ownerId: "alice" }),
      app({ id: "root" }),
      app({ id: "myused", ownerId: "me", path: "apps/Ops/mine" }),
      app({ id: "mine2", ownerId: "me" }),
    ];
    const sig = signals({
      mine: new Map([
        ["used", { days: 2, lastAt: daysAgo(5) }],
        ["myused", { days: 2, lastAt: daysAgo(5) }],
      ]),
    });
    expect(termsOf(apps, sig, "folder").terms.sameFolder).toBe(
      FEED_WEIGHTS.sameFolder,
    );
    expect(termsOf(apps, sig, "owner").terms.sameOwner).toBe(
      FEED_WEIGHTS.sameOwner,
    );
    // The `apps` root is not a folder anyone chose.
    expect(termsOf(apps, sig, "root").terms.sameFolder).toBeUndefined();
    expect(termsOf(apps, sig, "mine2").terms.sameOwner).toBeUndefined();
    expect(folderOf("apps/x")).toBeNull();
    expect(folderOf("users/joan/apps/x")).toBeNull();
    expect(folderOf("users/joan/apps/Sales/x")).toBe("users/joan/apps/Sales");
  });

  it("scores quality: custom thumbnail, description, verified, health", () => {
    const apps = [
      app({ id: "polished", thumbnail: { file: "thumbnail.png", oid: "1" } }),
      app({
        id: "placeholder",
        thumbnail: { file: "thumbnail.svg", oid: "2" },
      }),
      app({ id: "bare" }),
      app({ id: "broken", health: { bindingErrors: ["kpis"] } }),
      app({ id: "draft", publishedSha: undefined, publishedAt: undefined }),
      app({ id: "verified", verified: true, description: "Weekly KPIs" }),
    ];
    const ranked = rankRecommended(apps, signals(), ME, NOW);
    const t = new Map(ranked.map(r => [r.id, r.terms]));
    expect(t.get("polished")?.customThumbnail).toBe(
      FEED_WEIGHTS.customThumbnail,
    );
    expect(t.get("placeholder")?.placeholderThumbnail).toBe(
      FEED_WEIGHTS.placeholderThumbnail,
    );
    expect(t.get("broken")?.unhealthy).toBe(FEED_WEIGHTS.unhealthy);
    expect(t.get("draft")?.unpublished).toBe(FEED_WEIGHTS.unpublished);
    expect(t.get("verified")?.verified).toBe(FEED_WEIGHTS.verified);
    expect(t.get("verified")?.description).toBe(FEED_WEIGHTS.description);
    const ids = ranked.map(r => r.id);
    expect(ids.slice(0, 2).sort()).toEqual(["polished", "verified"]);
    expect(ids.slice(-2).sort()).toEqual(["broken", "draft"]);
  });

  it("boosts what people who use my apps also use", () => {
    const apps = [app({ id: "theirs" }), app({ id: "other" })];
    const sig = signals({ coUsage: new Map([["theirs", 2]]) });
    expect(termsOf(apps, sig, "theirs").terms.coUsage).toBe(
      FEED_WEIGHTS.coUsage,
    );
    expect(order(apps, sig)[0]).toBe("theirs");
  });

  it("jitters per viewer per day, deterministically and within its weight", () => {
    const apps = Array.from({ length: 40 }, () => app());
    const a = order(apps, signals());
    expect(order(apps, signals())).toEqual(a);
    expect(order(apps, signals(), { id: "you", email: "y@x" })).not.toEqual(a);
    expect(
      order(apps, signals(), ME, new Date(NOW.getTime() + DAY)),
    ).not.toEqual(a);
    for (const r of rankRecommended(apps, signals(), ME, NOW)) {
      expect(r.terms.exploration ?? 0).toBeLessThan(FEED_WEIGHTS.exploration);
      expect(r.terms.exploration ?? 0).toBeGreaterThanOrEqual(0);
    }
    const u = seededUnit("x");
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
  });

  it("returns every app exactly once", () => {
    const apps = Array.from({ length: 30 }, () => app());
    const ids = order(apps, signals());
    expect(new Set(ids).size).toBe(30);
    expect([...ids].sort()).toEqual(apps.map(a => a.id).sort());
  });
});

describe("coUsageScores", () => {
  it("sums the cosine similarity of people who overlap with me", () => {
    const rows = [
      { appId: "a", userId: "me" },
      { appId: "b", userId: "me" },
      // Same two apps plus c: similarity 2/√(2·3).
      { appId: "a", userId: "twin" },
      { appId: "b", userId: "twin" },
      { appId: "c", userId: "twin" },
      // One overlap, also uses c and d: 1/√(2·3).
      { appId: "a", userId: "loose" },
      { appId: "c", userId: "loose" },
      { appId: "d", userId: "loose" },
      // No overlap: contributes nothing.
      { appId: "e", userId: "far" },
      // Anonymous share viewers are not people in the workspace.
      { appId: "a", userId: "anon:x" },
      { appId: "f", userId: "anon:x" },
      { appId: "f", userId: null },
    ];
    const s = coUsageScores(rows, "me");
    expect(s.get("c")).toBeCloseTo(3 / Math.sqrt(6), 6);
    expect(s.get("d")).toBeCloseTo(1 / Math.sqrt(6), 6);
    // What I already use, and what nobody like me uses, score nothing.
    expect(s.has("a")).toBe(false);
    expect(s.has("e")).toBe(false);
    expect(s.has("f")).toBe(false);
    expect(coUsageScores(rows, undefined).size).toBe(0);
  });
});

describe("shelves", () => {
  it("Popular by score, New by age, never the same app twice", () => {
    const apps = [
      app({ id: "hit", createdAt: daysAgo(2) }),
      app({ id: "hot" }),
      app({ id: "fresh", createdAt: daysAgo(1) }),
      app({ id: "week", createdAt: daysAgo(6) }),
      app({ id: "old" }),
    ];
    const popularity = new Map([
      ["hit", 9],
      ["hot", 3],
    ]);
    expect(pickShelves(apps, popularity, NOW)).toEqual({
      popular: ["hit", "hot"],
      fresh: ["fresh", "week"],
    });
    const feed = buildFeedOrder(apps, signals({ popularity }), ME, NOW);
    expect(feed.recommended).toEqual(["old"]);
  });

  it("caps each shelf and partitions every app", () => {
    const apps = Array.from({ length: 50 }, (_, i) =>
      app({ createdAt: daysAgo(i % 10) }),
    );
    const popularity = new Map(apps.slice(0, 20).map((a, i) => [a.id, i + 1]));
    const feed = buildFeedOrder(apps, signals({ popularity }), ME, NOW);
    expect(feed.popular).toHaveLength(10);
    expect(feed.fresh.length).toBeLessThanOrEqual(10);
    const all = [...feed.popular, ...feed.fresh, ...feed.recommended];
    expect(all).toHaveLength(50);
    expect(new Set(all).size).toBe(50);
  });
});

describe("cursor", () => {
  it("round-trips and refuses anything else", () => {
    const id = new Types.ObjectId().toString();
    const raw = encodeFeedCursor({ snapshotId: id, offset: 48 });
    expect(decodeFeedCursor(raw)).toEqual({ snapshotId: id, offset: 48 });
    expect(decodeFeedCursor("garbage")).toBeNull();
    expect(
      decodeFeedCursor(
        Buffer.from(JSON.stringify({ v: 1, s: id, o: -1 })).toString(
          "base64url",
        ),
      ),
    ).toBeNull();
    expect(
      decodeFeedCursor(
        Buffer.from(JSON.stringify({ v: 1, s: "x", o: 0 })).toString(
          "base64url",
        ),
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Paging (in-memory snapshots; the visibility rule is the real one)
// ---------------------------------------------------------------------------

interface IndexedFixture {
  app: DiscoveryApp;
  ownerId?: string;
  state?: {
    access: "private" | "workspace";
    owner_id: string;
    sharedWith?: Array<{ userId: string; access: "viewer" }>;
  };
}

function fakeDeps(fixtures: IndexedFixture[], sig: FeedSignals = signals()) {
  const snapshots = new Map<string, StoredFeedSnapshot>();
  let loadSignalsCalls = 0;
  const deps: FeedDeps = {
    listApps: async (_ws, userId, role) =>
      fixtures
        .filter(f =>
          canSeeIndexedApp(
            { scope: f.app.scope, ownerId: f.ownerId },
            f.state as never,
            userId,
            role,
          ),
        )
        .map(f => f.app),
    loadViewer: async userId => ({ id: userId }),
    loadSignals: async () => {
      loadSignalsCalls += 1;
      return sig;
    },
    saveSnapshot: async snapshot => {
      const id = new Types.ObjectId().toString();
      snapshots.set(id, structuredClone(snapshot));
      return id;
    },
    loadSnapshot: async id => snapshots.get(id) ?? null,
  };
  return { deps, snapshots, signalsCalls: () => loadSignalsCalls };
}

const WS = new Types.ObjectId().toString();

async function scrollAll(
  deps: FeedDeps,
  userId: string,
  limit: number,
  between?: (page: number) => void,
) {
  const first = await getFeedPage(WS, userId, "member", { limit }, deps, NOW);
  const seen = [
    ...(first.popular ?? []),
    ...(first.fresh ?? []),
    ...first.apps,
  ].map(a => a.id);
  let cursor = first.nextCursor;
  let pages = 1;
  while (cursor) {
    between?.(pages);
    const next = await getFeedPage(
      WS,
      userId,
      "member",
      { cursor, limit },
      deps,
      NOW,
    );
    expect(next.popular).toBeUndefined();
    seen.push(...next.apps.map(a => a.id));
    cursor = next.nextCursor;
    pages += 1;
  }
  return { first, seen, pages };
}

describe("getFeedPage", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      app: app({ createdAt: daysAgo(i % 9) }),
    }));

  it("shows every visible app exactly once across shelves and pages", async () => {
    const fixtures = many(103);
    const popularity = new Map(
      fixtures.slice(0, 15).map((f, i) => [f.app.id, 15 - i]),
    );
    const { deps } = fakeDeps(fixtures, signals({ popularity }));
    const { first, seen, pages } = await scrollAll(deps, "me", 24);
    expect(first.popular).toHaveLength(10);
    expect(first.total).toBe(103);
    expect(seen).toHaveLength(103);
    expect(new Set(seen).size).toBe(103);
    expect(pages).toBe(Math.ceil(first.recommendedTotal / 24));
  });

  it("keeps the frozen order when signals move mid-scroll", async () => {
    const fixtures = many(60);
    const sig = signals();
    const { deps, signalsCalls } = fakeDeps(fixtures, sig);
    const { seen } = await scrollAll(deps, "me", 7, page => {
      // Opening apps from the feed changes my own reads; the snapshot holds.
      (sig.mine as Map<string, { days: number; lastAt: string }>).set(
        fixtures[page].app.id,
        { days: 5, lastAt: NOW.toISOString() },
      );
      (sig.popularity as Map<string, number>).set(fixtures[59].app.id, 99);
    });
    expect(signalsCalls()).toBe(1);
    expect(new Set(seen).size).toBe(60);
    expect(seen).toHaveLength(60);
  });

  it("never shows another person's private app, nor one hidden mid-scroll", async () => {
    const shared = many(30);
    const secret = {
      app: app({ id: "secret", scope: "private", access: "private" }),
      ownerId: "alice",
    };
    const sharedRow = {
      app: app({ id: "sharedrow", access: "private" }),
      state: {
        access: "private" as const,
        owner_id: "alice",
        sharedWith: [] as Array<{ userId: string; access: "viewer" }>,
      },
    };
    const fixtures: IndexedFixture[] = [...shared, secret, sharedRow];
    // Even if usage points at them (alice's reads), they cannot surface.
    const { deps } = fakeDeps(
      fixtures,
      signals({
        popularity: new Map([
          ["secret", 50],
          ["sharedrow", 40],
        ]),
        coUsage: new Map([["secret", 3]]),
      }),
    );
    const mine = await scrollAll(deps, "me", 10);
    expect(mine.seen).not.toContain("secret");
    expect(mine.seen).not.toContain("sharedrow");
    expect(mine.seen).toHaveLength(30);

    const alice = await scrollAll(deps, "alice", 10);
    expect(alice.seen).toContain("secret");
    expect(alice.seen).toContain("sharedrow");

    // Hidden after the snapshot: the next pages drop it, nothing else moves.
    const { deps: d2, snapshots } = fakeDeps(fixtures);
    let victim = "";
    const { seen } = await scrollAll(d2, "me", 5, page => {
      if (page !== 1) return;
      victim = [...snapshots.values()][0].recommended.at(-1) ?? "";
      const f = fixtures.find(x => x.app.id === victim);
      if (f) f.state = { access: "private", owner_id: "alice", sharedWith: [] };
    });
    expect(victim).not.toBe("");
    expect(seen).not.toContain(victim);
    expect(seen).toHaveLength(29);
    expect(new Set(seen).size).toBe(29);
  });

  it("refuses cursors that are not this person's, or expired", async () => {
    const { deps, snapshots } = fakeDeps(many(40));
    const first = await getFeedPage(WS, "me", "member", { limit: 5 }, deps);
    const cursor = first.nextCursor;
    expect(cursor).toBeTruthy();
    if (!cursor) return;
    const status = async (p: Promise<unknown>) =>
      p.then(
        () => 200,
        (e: unknown) => (e instanceof FeedCursorError ? e.status : 500),
      );
    expect(
      await status(getFeedPage(WS, "you", "member", { cursor }, deps)),
    ).toBe(400);
    expect(
      await status(
        getFeedPage(
          new Types.ObjectId().toString(),
          "me",
          "member",
          { cursor },
          deps,
        ),
      ),
    ).toBe(400);
    expect(
      await status(getFeedPage(WS, "me", "member", { cursor: "nope" }, deps)),
    ).toBe(400);
    snapshots.clear();
    expect(
      await status(getFeedPage(WS, "me", "member", { cursor }, deps)),
    ).toBe(410);
  });
});

// ---------------------------------------------------------------------------
// The real stores: snapshots and usage signals in Mongo
// ---------------------------------------------------------------------------

describe("Mongo-backed feed state", () => {
  let mongo: MongoMemoryServer;
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
    await Promise.all([
      AppUsageDaily.deleteMany({}),
      AppUsageEvent.deleteMany({}),
      AppProject.deleteMany({}),
      AppFeedSnapshot.deleteMany({}),
    ]);
    resetUsageThrottle();
  });

  it("stores and reads back a snapshot", async () => {
    const id = await defaultFeedDeps.saveSnapshot(
      {
        workspaceId: WS,
        userId: "me",
        popular: ["a"],
        fresh: ["b"],
        recommended: ["c", "d"],
      },
      NOW,
    );
    expect(await defaultFeedDeps.loadSnapshot(id)).toEqual({
      workspaceId: WS,
      userId: "me",
      popular: ["a"],
      fresh: ["b"],
      recommended: ["c", "d"],
    });
    expect(
      await defaultFeedDeps.loadSnapshot(new Types.ObjectId().toString()),
    ).toBeNull();
  });

  it("derives popularity, my reads and co-usage from the rollup", async () => {
    const open = (userId: string, appId: string, iso: string) =>
      recordAppUsage({
        workspaceId: WS,
        appId,
        userId,
        kind: "open",
        source: "app",
        at: new Date(iso),
      });
    await open("me", "a", "2026-10-10T08:00:00Z");
    await open("me", "a", "2026-10-20T08:00:00Z");
    await open("me", "old", "2026-08-01T08:00:00Z"); // 80 days: affinity only
    await open("peer", "a", "2026-10-19T08:00:00Z");
    await open("peer", "c", "2026-10-19T09:00:00Z");
    const sig = await loadFeedSignals(WS, { id: "me" }, NOW);
    expect(sig.mine.get("a")).toEqual({
      days: 2,
      lastAt: "2026-10-20T08:00:00.000Z",
    });
    expect(sig.mine.get("old")?.days).toBe(1);
    // Outside the 28-day popularity window.
    expect(sig.popularity.get("old") ?? 0).toBe(0);
    expect(sig.popularity.get("a") ?? 0).toBeGreaterThan(0);
    expect(sig.coUsage.get("c") ?? 0).toBeGreaterThan(0);
    expect(sig.coUsage.has("a")).toBe(false);
  });

  it("records where on the home an app was opened from", async () => {
    await recordAppUsage({
      workspaceId: WS,
      appId: "a",
      userId: "me",
      kind: "open",
      source: "app",
      at: NOW,
      placement: { surface: "home", shelf: "recommended", position: 31 },
    });
    await recordAppUsage({
      workspaceId: WS,
      appId: "a",
      userId: "me",
      kind: "heartbeat",
      source: "app",
      at: NOW,
      placement: { surface: "home", shelf: "recommended", position: 31 },
    });
    const events = await AppUsageEvent.find({}).sort({ kind: -1 }).lean();
    expect(events.map(e => [e.kind, e.placement])).toEqual([
      ["open", { surface: "home", shelf: "recommended", position: 31 }],
      ["heartbeat", undefined],
    ]);
  });
});
