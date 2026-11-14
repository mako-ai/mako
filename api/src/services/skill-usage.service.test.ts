/**
 * Skill usage: the daily rollup behind `loads30d` and `lastLoadedAt`. Real
 * Mongo (the unique key and the `$inc` upsert are the point).
 */
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
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  SKILL_USAGE_TTL_SECONDS,
  SkillUsageDaily,
} from "../database/workspace-schema";
import {
  getSkillUsage,
  getSkillUsageOrNull,
  recordSkillUsage,
  recordSkillUsageNow,
  skillScopeFromId,
  skillUsageKey,
} from "./skill-usage.service";

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();
const OTHER_WS = new Types.ObjectId().toString();
const at = (iso: string) => new Date(iso);
const NOW = at("2026-11-13T12:00:00Z");
const glossary = { skill: "glossary", scope: "workspace" as const };

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await SkillUsageDaily.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await SkillUsageDaily.deleteMany({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recordSkillUsageNow", () => {
  it("bumps one row per workspace, skill, source and UTC day, counts only", async () => {
    await recordSkillUsageNow(WS, [glossary], "load", "agent", NOW);
    await recordSkillUsageNow(
      WS,
      [glossary],
      "load",
      "agent",
      at("2026-11-13T23:59:00Z"),
    );
    await recordSkillUsageNow(WS, [glossary], "resource", "agent", NOW);
    await recordSkillUsageNow(WS, [glossary], "relevant", "mcp", NOW);
    await recordSkillUsageNow(
      WS,
      [glossary],
      "load",
      "agent",
      at("2026-11-14T00:01:00Z"),
    );

    const rows = await SkillUsageDaily.find({})
      .sort({ day: 1, source: 1 })
      .lean();
    expect(
      rows.map(row => [
        row.day,
        row.source,
        row.loads ?? 0,
        row.resourceReads ?? 0,
        row.relevantHits ?? 0,
      ]),
    ).toEqual([
      ["2026-11-13", "agent", 2, 1, 0],
      ["2026-11-13", "mcp", 0, 0, 1],
      ["2026-11-14", "agent", 1, 0, 0],
    ]);
    expect(rows[0].firstAt).toEqual(NOW);
    expect(rows[0].lastAt).toEqual(at("2026-11-13T23:59:00Z"));
    // Counts only: nothing about who asked or what they asked.
    expect(Object.keys(rows[0]).sort()).toEqual([
      "_id",
      "day",
      "firstAt",
      "lastAt",
      "loads",
      "relevantHits",
      "resourceReads",
      "scope",
      "skill",
      "source",
      "workspaceId",
    ]);
  });

  it("keeps 20 parallel first loads in one row", async () => {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        recordSkillUsageNow(WS, [glossary], "load", "agent", NOW),
      ),
    );
    const rows = await SkillUsageDaily.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].loads).toBe(20);
  });

  it("expires rows 400 days after their last bump", async () => {
    const indexes = await SkillUsageDaily.collection.indexes();
    const ttl = indexes.find(index => index.expireAfterSeconds !== undefined);
    expect(ttl?.key).toEqual({ lastAt: 1 });
    expect(ttl?.expireAfterSeconds).toBe(SKILL_USAGE_TTL_SECONDS);
    expect(SKILL_USAGE_TTL_SECONDS).toBe(400 * 24 * 60 * 60);
  });
});

describe("getSkillUsage", () => {
  it("sums the three kinds over 30 days, per skill, for one workspace", async () => {
    // Day 30 of the window (counts) and the day before it (does not).
    await recordSkillUsageNow(
      WS,
      [glossary],
      "load",
      "agent",
      at("2026-10-15T09:00:00Z"),
    );
    await recordSkillUsageNow(
      WS,
      [glossary],
      "load",
      "agent",
      at("2026-10-14T09:00:00Z"),
    );
    await recordSkillUsageNow(WS, [glossary], "load", "mcp", NOW);
    await recordSkillUsageNow(WS, [glossary], "resource", "mcp", NOW);
    await recordSkillUsageNow(
      WS,
      [glossary, { skill: "apps", scope: "system" }],
      "relevant",
      "agent",
      at("2026-11-12T08:00:00Z"),
    );
    await recordSkillUsageNow(
      WS,
      [{ skill: "dormant", scope: "workspace" }],
      "load",
      "agent",
      at("2026-06-01T08:00:00Z"),
    );
    await recordSkillUsageNow(OTHER_WS, [glossary], "load", "agent", NOW);

    const usage = await getSkillUsage(WS, NOW);
    expect(Object.fromEntries(usage)).toEqual({
      "workspace:glossary": { loads30d: 4, lastLoadedAt: NOW },
      "system:apps": {
        loads30d: 1,
        lastLoadedAt: at("2026-11-12T08:00:00Z"),
      },
      "workspace:dormant": {
        loads30d: 0,
        lastLoadedAt: at("2026-06-01T08:00:00Z"),
      },
    });
    expect(skillUsageKey("workspace", "glossary")).toBe("workspace:glossary");
    expect(skillScopeFromId("system:apps")).toBe("system");
    expect(skillScopeFromId("0123456789abcdef01234567")).toBe("workspace");
  });
});

describe("recording never fails a load", () => {
  it("returns at once and swallows a database error", async () => {
    const write = vi
      .spyOn(SkillUsageDaily, "bulkWrite")
      .mockRejectedValue(new Error("mongo is down"));
    expect(() =>
      recordSkillUsage(WS, [glossary], "load", "agent"),
    ).not.toThrow();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    // The rejection was handled: one more turn of the loop and no crash.
    await new Promise(resolve => setImmediate(resolve));
    expect(await SkillUsageDaily.countDocuments({})).toBe(0);
  });

  it("writes in the background when the database is up", async () => {
    recordSkillUsage(WS, [glossary], "load", "mcp");
    await vi.waitFor(async () =>
      expect(await SkillUsageDaily.countDocuments({})).toBe(1),
    );
  });

  it("ignores an empty list and a workspace id that is not an id", async () => {
    recordSkillUsage(WS, [], "relevant", "agent");
    await recordSkillUsageNow("not-an-id", [glossary], "load", "agent");
    expect(await SkillUsageDaily.countDocuments({})).toBe(0);
  });

  it("answers null, not an error, when the numbers cannot be read", async () => {
    vi.spyOn(SkillUsageDaily, "aggregate").mockImplementation(() => {
      throw new Error("mongo is down");
    });
    expect(await getSkillUsageOrNull(WS)).toBeNull();
  });
});
