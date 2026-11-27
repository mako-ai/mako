/**
 * Skill usage: the daily rollup behind `loads30d` and `lastLoadedAt`. PGlite exercises the unique key and atomic upsert.
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
import { Types } from "mongoose";
import {
  ensureTestWorkspace,
  setupPgTestDb,
  type PgTestDb,
} from "../test-support/pg-test";
import { skillUsageDaily } from "../database/pg/schema";
import {
  DEFAULT_PG_TTL_RULES,
  reapExpiredRows,
} from "../database/pg/ttl-reaper";
import { usageStatsRepo } from "../repositories/usage-stats";
import {
  getSkillUsage,
  getSkillUsageOrNull,
  recordSkillUsage,
  recordSkillUsageNow,
  skillScopeFromId,
  skillUsageKey,
} from "./skill-usage.service";

let pgh: PgTestDb;
const WS = new Types.ObjectId().toString();
const OTHER_WS = new Types.ObjectId().toString();
const at = (iso: string) => new Date(iso);
const NOW = at("2026-11-13T12:00:00Z");
const glossary = { skill: "glossary", scope: "workspace" as const };

beforeAll(async () => {
  pgh = await setupPgTestDb();
});

afterAll(async () => {
  await pgh?.close();
});

beforeEach(async () => {
  await pgh.reset();
  await ensureTestWorkspace(pgh.db, { id: WS });
  await ensureTestWorkspace(pgh.db, { id: OTHER_WS });
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

    const rows = await pgh.db
      .select()
      .from(skillUsageDaily)
      .orderBy(skillUsageDaily.day, skillUsageDaily.source);
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
      "day",
      "firstAt",
      "id",
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
    const rows = await pgh.db.select().from(skillUsageDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0].loads).toBe(20);
  });

  it("expires rows 400 days after their last bump", async () => {
    const rule = DEFAULT_PG_TTL_RULES.find(
      rule => rule.tableName === "skill_usage_daily",
    );
    if (!rule) throw new Error("Missing skill usage retention rule");
    const cutoff = NOW.getTime() - 400 * 24 * 60 * 60 * 1000;
    await recordSkillUsageNow(
      WS,
      [glossary],
      "load",
      "agent",
      new Date(cutoff - 1),
    );
    await recordSkillUsageNow(
      WS,
      [glossary],
      "load",
      "mcp",
      new Date(cutoff - 1),
    );
    await recordSkillUsageNow(WS, [glossary], "load", "mcp", new Date(cutoff));
    await reapExpiredRows(rule, { db: pgh.db, now: NOW });
    const rows = await pgh.db.select().from(skillUsageDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "mcp",
      loads: 2,
      lastAt: new Date(cutoff),
    });
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
      .spyOn(usageStatsRepo, "bumpSkillUsageDaily")
      .mockRejectedValue(new Error("database is down"));
    expect(() =>
      recordSkillUsage(WS, [glossary], "load", "agent"),
    ).not.toThrow();
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    // The rejection was handled: one more turn of the loop and no crash.
    await new Promise(resolve => setImmediate(resolve));
    expect(await pgh.db.$count(skillUsageDaily)).toBe(0);
  });

  it("writes in the background when the database is up", async () => {
    recordSkillUsage(WS, [glossary], "load", "mcp");
    await vi.waitFor(async () =>
      expect(await pgh.db.$count(skillUsageDaily)).toBe(1),
    );
  });

  it("ignores an empty list and a workspace id that is not an id", async () => {
    recordSkillUsage(WS, [], "relevant", "agent");
    await recordSkillUsageNow("not-an-id", [glossary], "load", "agent");
    expect(await pgh.db.$count(skillUsageDaily)).toBe(0);
  });

  it("answers null, not an error, when the numbers cannot be read", async () => {
    vi.spyOn(usageStatsRepo, "getSkillUsageSummary").mockImplementation(() => {
      throw new Error("database is down");
    });
    expect(await getSkillUsageOrNull(WS)).toBeNull();
  });
});
