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
import mongoose from "mongoose";
import { hasPostgresConfig } from "../database/pg/client";
import { parseEntityId } from "../database/pg/id-codec";
import { loggers } from "../logging";
import { usageStatsRepo } from "../repositories/usage-stats";

const logger = loggers.api("skills-usage");

export type SkillUsageSource = "agent" | "mcp";
export type SkillUsageScope = "workspace" | "system";
/** What happened: a load by name, a resource read, a body from a keyword match. */
export type SkillUsageKind = "load" | "resource" | "relevant";

export const SKILL_USAGE_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

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
  if (targets.length === 0 || !parseEntityId(workspaceId)) return;
  await usageStatsRepo.bumpSkillUsageDaily(
    workspaceId,
    targets,
    kind,
    source,
    at,
  );
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
  if (mongoose.connection.readyState !== 1 && !hasPostgresConfig()) return;
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
  if (!parseEntityId(workspaceId)) return usage;
  // Today and the 29 days before it.
  const since = utcDay(
    new Date(now.getTime() - (SKILL_USAGE_WINDOW_DAYS - 1) * DAY_MS),
  );
  const rows = await usageStatsRepo.getSkillUsageSummary(workspaceId, since);
  for (const row of rows) {
    usage.set(skillUsageKey(row.scope, row.skill), {
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
  if (mongoose.connection.readyState !== 1 && !hasPostgresConfig()) return null;
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
