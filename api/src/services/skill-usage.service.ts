/**
 * Skill usage: which skills the agent actually reads.
 *
 * Three things count as reading a skill: a `load_skill` that returns it, a
 * `read_skill_resource` that returns one of its files, and a body returned by
 * `get_relevant_skills` or `search_skills`. Each bumps one row per
 * (workspace, scope, skill, source, UTC day) in `skill_usage_daily` with an
 * `$inc` upsert. Counts only: no user, no chat, no query text.
 *
 * The index and the pinned excerpts in every prompt do not count: they are
 * sent on every turn whether or not the skill is used.
 *
 * Skills stay files (apps.md §27): the catalog never reads this collection,
 * so a lost or late row changes a number in `list_skills` and nothing else.
 * Recording is fire-and-forget. It never fails or slows a load.
 */
import mongoose, { Types } from "mongoose";
import { SkillUsageDaily } from "../database/workspace-schema";
import { loggers } from "../logging";

const logger = loggers.api("skills-usage");

export type SkillUsageSource = "agent" | "mcp";
export type SkillUsageScope = "workspace" | "system";
/** What happened: a load by name, a resource read, a body from a keyword match. */
export type SkillUsageKind = "load" | "resource" | "relevant";

export const SKILL_USAGE_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const COUNTER_OF: Record<SkillUsageKind, string> = {
  load: "loads",
  resource: "resourceReads",
  relevant: "relevantHits",
};

export interface SkillUsageTarget {
  skill: string;
  scope: SkillUsageScope;
}

export interface SkillUsageSummary {
  /** Loads, resource reads and keyword-match bodies in the last 30 days. */
  loads30d: number;
  /** Last read of any kind, within the 400 days rows are kept. */
  lastLoadedAt: Date | null;
}

/** `YYYY-MM-DD` of the UTC day `at` falls on. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The key `getSkillUsage` answers by. */
export function skillUsageKey(scope: SkillUsageScope, skill: string): string {
  return `${scope}:${skill}`;
}

/** A skill's scope from the id the skills service gives it. */
export function skillScopeFromId(id: string): SkillUsageScope {
  return id.startsWith("system:") ? "system" : "workspace";
}

/** Bump the day's counters and wait for the write. Throws on a database error. */
export async function recordSkillUsageNow(
  workspaceId: string,
  targets: readonly SkillUsageTarget[],
  kind: SkillUsageKind,
  source: SkillUsageSource,
  at: Date = new Date(),
): Promise<void> {
  if (targets.length === 0 || !Types.ObjectId.isValid(workspaceId)) return;
  const workspace = new Types.ObjectId(workspaceId);
  const day = utcDay(at);
  const operations = targets.map(target => ({
    updateOne: {
      filter: {
        workspaceId: workspace,
        scope: target.scope,
        skill: target.skill,
        source,
        day,
      },
      update: {
        $inc: { [COUNTER_OF[kind]]: 1 },
        $min: { firstAt: at },
        $max: { lastAt: at },
      },
      upsert: true,
    },
  }));
  try {
    await SkillUsageDaily.bulkWrite(operations, { ordered: false });
  } catch (error) {
    // Two first loads of a skill on one day can both try to insert its row.
    // The loser gets a duplicate-key error for those rows only: bump them
    // again now that the row exists.
    const failed = duplicateKeyIndexes(error);
    if (failed.length === 0) throw error;
    await SkillUsageDaily.bulkWrite(
      failed.map(index => operations[index]),
      { ordered: false },
    );
  }
}

/** The operations of a bulk write that lost an upsert race, by position. */
function duplicateKeyIndexes(error: unknown): number[] {
  const writeErrors = (error as { writeErrors?: unknown }).writeErrors;
  if (!Array.isArray(writeErrors) || writeErrors.length === 0) return [];
  const indexes: number[] = [];
  for (const entry of writeErrors as Array<{
    code?: number;
    index?: number;
    err?: { code?: number; index?: number };
  }>) {
    const code = entry.code ?? entry.err?.code;
    const index = entry.index ?? entry.err?.index;
    // Any other write error is a real failure: let the caller see it.
    if (code !== 11000 || typeof index !== "number") return [];
    indexes.push(index);
  }
  return indexes;
}

/**
 * Count a read without waiting for it. Returns at once. A database error is
 * logged and swallowed, and with no database connection nothing is queued.
 */
export function recordSkillUsage(
  workspaceId: string,
  targets: readonly SkillUsageTarget[],
  kind: SkillUsageKind,
  source: SkillUsageSource,
): void {
  if (targets.length === 0) return;
  // Without a live connection mongoose would buffer the write for 10 s.
  if (mongoose.connection.readyState !== 1) return;
  void recordSkillUsageNow(workspaceId, targets, kind, source).catch(error => {
    logger.warn("Could not record skill usage", {
      workspaceId,
      kind,
      source,
      skills: targets.map(target => target.skill),
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * Usage per skill, keyed by {@link skillUsageKey}. Skills never read have no
 * entry. Throws on a database error: callers that only decorate a listing
 * use {@link getSkillUsageOrNull}.
 */
export async function getSkillUsage(
  workspaceId: string,
  now: Date = new Date(),
): Promise<Map<string, SkillUsageSummary>> {
  const usage = new Map<string, SkillUsageSummary>();
  if (!Types.ObjectId.isValid(workspaceId)) return usage;
  // Today and the 29 days before it.
  const since = utcDay(
    new Date(now.getTime() - (SKILL_USAGE_WINDOW_DAYS - 1) * DAY_MS),
  );
  const rows = await SkillUsageDaily.aggregate<{
    _id: { scope: SkillUsageScope; skill: string };
    loads30d: number;
    lastLoadedAt: Date | null;
  }>([
    { $match: { workspaceId: new Types.ObjectId(workspaceId) } },
    {
      $group: {
        _id: { scope: "$scope", skill: "$skill" },
        loads30d: {
          $sum: {
            $cond: [
              { $gte: ["$day", since] },
              {
                $add: [
                  { $ifNull: ["$loads", 0] },
                  { $ifNull: ["$resourceReads", 0] },
                  { $ifNull: ["$relevantHits", 0] },
                ],
              },
              0,
            ],
          },
        },
        lastLoadedAt: { $max: "$lastAt" },
      },
    },
  ]);
  for (const row of rows) {
    usage.set(skillUsageKey(row._id.scope, row._id.skill), {
      loads30d: row.loads30d,
      lastLoadedAt: row.lastLoadedAt ?? null,
    });
  }
  return usage;
}

/** {@link getSkillUsage}, or null when the numbers cannot be read. Never throws. */
export async function getSkillUsageOrNull(
  workspaceId: string,
  now: Date = new Date(),
): Promise<Map<string, SkillUsageSummary> | null> {
  if (mongoose.connection.readyState !== 1) return null;
  try {
    return await getSkillUsage(workspaceId, now);
  } catch (error) {
    logger.warn("Could not read skill usage", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
