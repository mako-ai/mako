/**
 * Reconstructing app usage from history: the burst and re-open rules, the
 * rollup rows, idempotent writes, and reading the repo's history for app
 * references that no longer exist under their old names.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AppUsageDaily, AppUsageEvent } from "../database/workspace-schema";
import {
  BURST_MS,
  DEDUPE_MS,
  backfillAuthors,
  dailyRowsOf,
  flagOpens,
  parseAppRenames,
  parseV1Migrations,
  replaceBackfillEvents,
  resolveAppRefIn,
  rollupsOf,
  writeDailyRows,
  type BackfillOpen,
} from "./app-usage-backfill";
import { computeAppUsageStats, recordAppUsage } from "./app-usage.service";

const WS = new Types.ObjectId().toString();
const T0 = new Date("2026-08-10T09:00:00Z").getTime();
const open = (
  appId: string,
  offsetMs: number,
  over: Partial<BackfillOpen> = {},
): BackfillOpen => ({
  workspaceId: WS,
  appId,
  userId: "u1",
  anonId: null,
  viewerKey: "u1",
  at: new Date(T0 + offsetMs),
  source: "app",
  uaClass: "desktop",
  ...over,
});

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
  await AppUsageDaily.deleteMany({});
  await AppUsageEvent.deleteMany({});
});

describe("flagOpens", () => {
  it("flags a tab-restore burst and keeps a single quick open", () => {
    const out = flagOpens([
      open("a", 0),
      open("b", 500),
      open("c", 1_200),
      // Alone, later: a real open.
      open("a", 60_000 * 30),
    ]);
    expect(out.bursts).toBe(3);
    expect(out.counted.map(o => o.appId)).toEqual(["a"]);
    expect(out.all).toHaveLength(4);
    expect(out.all.filter(o => o.throttled)).toHaveLength(3);
  });

  it("flags re-opens of the same app within the window (tab switches)", () => {
    const out = flagOpens([
      open("a", 0),
      open("a", 60_000),
      open("a", DEDUPE_MS - 1),
      open("a", DEDUPE_MS + 1),
    ]);
    expect(out.repeats).toBe(2);
    expect(out.counted).toHaveLength(2);
  });

  it("treats people separately and keeps bots out of every count", () => {
    const out = flagOpens([
      open("a", 0),
      open("b", BURST_MS - 1, { userId: "u2", viewerKey: "u2" }),
      open("a", 10, { uaClass: "bot", userId: null, viewerKey: "bot" }),
    ]);
    expect(out.bursts).toBe(0);
    expect(out.bots).toBe(1);
    expect(out.counted).toHaveLength(2);
    expect(out.all).toHaveLength(3);
  });
});

describe("rollup rows", () => {
  it("groups per viewer per day, anonymous ids as their own viewers", () => {
    const rows = dailyRowsOf([
      open("a", 0),
      open("a", 3_600_000),
      open("a", 0, {
        userId: null,
        anonId: "ph:x",
        viewerKey: "ph:x",
        source: "share",
      }),
      open("a", 86_400_000),
    ]);
    expect(rows).toHaveLength(3);
    const u1 = rows.filter(r => r.userId === "u1");
    expect(u1.map(r => [r.day, r.opens])).toEqual([
      ["2026-08-10", 2],
      ["2026-08-11", 1],
    ]);
    const stats = computeAppUsageStats(
      rollupsOf(rows, "2026-08-01"),
      new Map(),
      new Date("2026-08-11T12:00:00Z"),
    ).get("a");
    expect(stats).toMatchObject({ viewers: 1, viewerDays: 2, anonViewers: 1 });
  });

  it("writes idempotently, keeping the larger count where sources overlap", async () => {
    const rows = dailyRowsOf([open("a", 0), open("a", 3_600_000)]);
    await writeDailyRows(rows);
    await writeDailyRows(rows);
    expect((await AppUsageDaily.findOne({}).lean())?.opens).toBe(2);
    // Live tracking had already counted three that day: the max wins.
    await AppUsageDaily.updateOne({}, { $set: { opens: 3 } });
    await writeDailyRows(rows);
    expect((await AppUsageDaily.findOne({}).lean())?.opens).toBe(3);
  });

  it("replaces only its own source's raw events in its window", async () => {
    await recordAppUsage({
      workspaceId: WS,
      appId: "a",
      userId: "u1",
      kind: "open",
      source: "app",
      at: new Date(T0),
    });
    const { all } = flagOpens([open("a", 0), open("a", 60_000)]);
    const window = {
      workspaceIds: [WS],
      since: new Date(T0 - 86_400_000),
      before: new Date(T0 + 86_400_000),
    };
    await replaceBackfillEvents("posthog", all, window);
    const again = await replaceBackfillEvents("posthog", all, window);
    expect(again).toEqual({ removed: 2, inserted: 2 });
    expect(await AppUsageEvent.countDocuments({ backfill: "posthog" })).toBe(2);
    expect(
      await AppUsageEvent.countDocuments({
        backfill: "posthog",
        throttled: true,
      }),
    ).toBe(1);
    // The live event is untouched.
    expect(await AppUsageEvent.countDocuments({ backfill: null })).toBe(1);
  });
});

describe("historical references", () => {
  const rows = [
    {
      workspaceId: WS,
      appId: "id-a",
      path: "apps/csm-activity",
      slug: "csm-activity",
    },
    {
      workspaceId: WS,
      appId: "id-b",
      path: "apps/Sales/report",
      slug: "report",
    },
    {
      workspaceId: WS,
      appId: "id-c",
      path: "users/joan/apps/report",
      slug: "report",
    },
  ];

  it("resolves ids, paths, unique slugs, and moved folders", () => {
    expect(resolveAppRefIn(rows, "csm-activity")).toBe("id-a");
    expect(resolveAppRefIn(rows, "apps/Sales/report")).toBe("id-b");
    // Ambiguous slug: neither.
    expect(resolveAppRefIn(rows, "report")).toBeNull();
    const renames = new Map([["apps/old-report", "apps/Sales/report"]]);
    expect(resolveAppRefIn(rows, "old-report", renames)).toBe("id-b");
    expect(resolveAppRefIn(rows, "gone")).toBeNull();
    expect(resolveAppRefIn(rows, "6a38391374713808afb0874c")).toBe(
      "6a38391374713808afb0874c",
    );
  });

  it("maps v1 app ids to the folder their latest migration created", () => {
    const log = [
      '\0Migrate v1 app "CSM Activity" (6a3e72b70b5cebcc1ac3e989)\n\napps/csm-activity/MIGRATION.md\napps/csm-activity/src/App.tsx',
      '\0Migrate v1 app "CSM Activity" (6a3e72b70b5cebcc1ac3e989)\n\napps/csm-activity-old/MIGRATION.md',
      '\0Migrate v1 app "Mine" (6a4eb8a8a7704911c7c71c94)\n\nusers/joan/apps/mine/README.md',
    ].join("\n");
    expect(parseV1Migrations(log)).toEqual(
      new Map([
        ["6a3e72b70b5cebcc1ac3e989", "apps/csm-activity"],
        ["6a4eb8a8a7704911c7c71c94", "users/joan/apps/mine"],
      ]),
    );
  });

  it("follows chains of folder renames to where the app is now", () => {
    const log = [
      "\0c2",
      "",
      "R100\tapps/b/mako.json\tapps/Sales/c/mako.json",
      "R090\tapps/b/src/App.tsx\tapps/Sales/c/src/App.tsx",
      "\0c1",
      "",
      "R100\tapps/a/mako.json\tapps/b/mako.json",
    ].join("\n");
    const renames = parseAppRenames(log);
    expect(renames.get("apps/a")).toBe("apps/Sales/c");
    expect(renames.get("apps/b")).toBe("apps/Sales/c");
    expect(renames.has("apps/b/src")).toBe(false);
  });

  it("collects authors from committers, tree owners and rows", () => {
    const authors = backfillAuthors({
      index: [{ ...rows[2], ownerId: "joan" }],
      projects: [{ _id: "id-a", owner_id: "owner", createdBy: "creator" }],
      committers: new Map([["id-a", new Set(["dev"])]]),
    });
    expect([...(authors.get("id-a") ?? [])].sort()).toEqual([
      "creator",
      "dev",
      "owner",
    ]);
    expect([...(authors.get("id-c") ?? [])]).toEqual(["joan"]);
  });
});
