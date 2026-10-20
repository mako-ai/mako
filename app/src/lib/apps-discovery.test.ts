import { describe, expect, it } from "vitest";
import {
  attentionReasons,
  isMyApp,
  newApps,
  placeholderFor,
  popularApps,
  recentlyViewedApps,
  relativeTime,
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
});
