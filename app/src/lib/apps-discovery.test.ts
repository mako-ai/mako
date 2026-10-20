import { describe, expect, it } from "vitest";
import {
  attentionReasons,
  discoveryFromMeta,
  isMyApp,
  provisionalFeed,
  newApps,
  ownerHandle,
  placeholderFor,
  popularApps,
  recentlyViewedApps,
  relativeTime,
  visitSummary,
  type AppUsageStats,
  type DiscoveryApp,
} from "./apps-discovery";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const app = (
  id: string,
  overrides: Partial<DiscoveryApp> = {},
): DiscoveryApp => ({
  id,
  slug: id,
  path: `apps/${id}`,
  scope: "workspace",
  title: id.toUpperCase(),
  access: "workspace",
  verified: false,
  thumbnail: null,
  scheduled: false,
  tables: [],
  dataRefreshedAt: null,
  health: { bindingErrors: [] },
  ...overrides,
});

const stats = (appId: string, score: number): AppUsageStats => ({
  appId,
  viewers: 1,
  nonAuthorViewers: 1,
  viewerDays: 1,
  opens: 1,
  activeSeconds: 60,
  lastOpenedAt: null,
  lastNonAuthorOpenedAt: null,
  score,
});

describe("shelves", () => {
  it("popular ranks by score and leaves out apps nobody else opened", () => {
    const apps = [app("a"), app("b"), app("c")];
    const usage = { a: stats("a", 1.5), b: stats("b", 4), c: stats("c", 0) };
    expect(popularApps(apps, usage, 5).map(a => a.id)).toEqual(["b", "a"]);
    expect(popularApps(apps, usage, 1).map(a => a.id)).toEqual(["b"]);
  });

  it("new is the last week, newest first, undated apps excluded", () => {
    const apps = [
      app("old", { createdAt: new Date(NOW - 30 * DAY).toISOString() }),
      app("mid", { createdAt: new Date(NOW - 3 * DAY).toISOString() }),
      app("new", { createdAt: new Date(NOW - DAY).toISOString() }),
      app("undated"),
    ];
    expect(newApps(apps, 7, NOW).map(a => a.id)).toEqual(["new", "mid"]);
  });

  it("recently viewed keeps the server's order and drops invisible apps", () => {
    const apps = [app("a"), app("b")];
    expect(
      recentlyViewedApps(
        apps,
        [
          { appId: "b", lastOpenedAt: "x" },
          { appId: "hidden", lastOpenedAt: "x" },
          { appId: "a", lastOpenedAt: "x" },
        ],
        5,
      ).map(a => a.id),
    ).toEqual(["b", "a"]);
  });
});

describe("ownership and attention", () => {
  it("is mine by owner id, else by the first committer's email", () => {
    expect(isMyApp(app("a", { ownerId: "u1" }), { id: "u1" })).toBe(true);
    expect(isMyApp(app("a", { ownerId: "u2" }), { id: "u1" })).toBe(false);
    expect(
      isMyApp(app("a", { authorEmail: "Joan@x.com" }), {
        id: "u1",
        email: "joan@x.com",
      }),
    ).toBe(true);
    // An owned app is the owner's, whoever committed it first.
    expect(
      isMyApp(app("a", { ownerId: "u2", authorEmail: "joan@x.com" }), {
        id: "u1",
        email: "joan@x.com",
      }),
    ).toBe(false);
  });

  it("is mine when the server resolved the author to me", () => {
    const resolved = app("a", {
      authorEmail: "rodriguezjoan@gmail.com",
      owner: { userId: "u1", name: "joan", handle: "joan" },
    });
    expect(isMyApp(resolved, { id: "u1", email: "joan@x.com" })).toBe(true);
    expect(isMyApp(resolved, { id: "u2", email: "x@x.com" })).toBe(false);
  });

  it("labels the owner by the resolved name, never a noreply id", () => {
    expect(
      ownerHandle(
        app("a", {
          authorEmail: "wieseljonas@users.noreply.github.com",
          owner: { userId: "u1", name: "jonas", handle: "jonas" },
        }),
      ),
    ).toBe("jonas");
    // An older payload without `owner`: still no `165400805+`.
    expect(
      ownerHandle(
        app("a", { authorEmail: "165400805+t-m-v@users.noreply.github.com" }),
      ),
    ).toBe("t-m-v");
    expect(ownerHandle(app("a", { ownerHandle: "maria" }))).toBe("maria");
    expect(ownerHandle(app("a"))).toBeNull();
  });

  it("flags failed deploys, failing bindings and stale scheduled data", () => {
    expect(attentionReasons(app("ok"), NOW)).toEqual([]);
    const broken = app("b", {
      publishedSha: "s",
      scheduled: true,
      dataRefreshedAt: new Date(NOW - 5 * DAY).toISOString(),
      health: {
        deployError: { stage: "build", at: "x" },
        bindingErrors: ["leads"],
      },
    });
    expect(attentionReasons(broken, NOW).map(r => r.kind)).toEqual([
      "deploy",
      "binding",
      "stale",
    ]);
    // Fresh scheduled data, or an unscheduled app, is not stale.
    expect(
      attentionReasons(
        app("f", {
          publishedSha: "s",
          scheduled: true,
          dataRefreshedAt: new Date(NOW - DAY).toISOString(),
        }),
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("presentation", () => {
  it("derives stable initials and hue", () => {
    expect(
      placeholderFor({ id: "abc", title: "Leads dashboard" }).initials,
    ).toBe("LD");
    expect(placeholderFor({ id: "abc", title: "quotas" }).initials).toBe("QU");
    expect(placeholderFor({ id: "abc", title: "x" }).hue).toBe(
      placeholderFor({ id: "abc", title: "y" }).hue,
    );
  });

  it("says when, coarsely", () => {
    expect(relativeTime(null, NOW)).toBeNull();
    expect(relativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe(
      "just now",
    );
    expect(relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe(
      "3 h ago",
    );
    expect(relativeTime(new Date(NOW - DAY).toISOString(), NOW)).toBe(
      "yesterday",
    );
  });

  it("counts visit-days, authors included, with anonymous viewers aside", () => {
    expect(visitSummary(undefined)).toBeNull();
    expect(
      visitSummary({
        ...stats("a", 0),
        viewers: 0,
        viewerDays: 0,
        allViewerDays: 0,
      }),
    ).toBeNull();
    expect(
      visitSummary({
        ...stats("a", 3),
        viewers: 14,
        viewerDays: 40,
        allViewerDays: 52,
        anonViewers: 3,
      }),
    ).toEqual({
      count: 52,
      tooltip:
        "52 visit-days by 14 people in the last 28 days, authors included (+3 anonymous viewers via share links)",
    });
    // An older API without allViewerDays still shows something sensible.
    expect(
      visitSummary({ ...stats("a", 1), viewers: 1, viewerDays: 1 }),
    ).toEqual({
      count: 1,
      tooltip: "1 visit-day by 1 person in the last 28 days, authors included",
    });
  });
});

describe("progressive paint", () => {
  it("turns an explorer list entry into a placeholder card", () => {
    const card = discoveryFromMeta({
      id: "x",
      title: "Report",
      path: "apps/Sales/report",
    });
    expect(card).toMatchObject({
      id: "x",
      title: "Report",
      slug: "report",
      thumbnail: null,
      health: { bindingErrors: [] },
    });
  });

  it("fills Popular, New and a first page, each app once", () => {
    const stats = (score: number) =>
      ({ appId: "", score }) as unknown as AppUsageStats;
    const apps = [
      app("hit"),
      app("new", { createdAt: new Date(NOW - DAY).toISOString() }),
      app("b"),
      app("a"),
    ];
    const feed = provisionalFeed(
      apps,
      { hit: stats(5), b: stats(1) },
      { shelf: 10, page: 24 },
      NOW,
    );
    expect(feed.popular.map(a => a.id)).toEqual(["hit", "b"]);
    expect(feed.fresh.map(a => a.id)).toEqual(["new"]);
    expect(feed.items.map(a => a.id)).toEqual(["a"]);
  });
});
