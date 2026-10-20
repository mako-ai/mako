/* eslint-disable no-console */
/**
 * What the two app-usage backfill scripts share on the command line:
 * connecting without writing, reading the index and authors, writing, and
 * the dry-run summary. The reconstruction rules live in
 * apps/app-usage-backfill.ts (unit-tested).
 */
import { readFile } from "node:fs/promises";
import mongoose, { Types } from "mongoose";
import { AppIndexEntry, AppProject } from "../database/workspace-schema";
import { User } from "../database/schema";
import {
  backfillAuthors,
  dailyRowsOf,
  flagOpens,
  replaceBackfillEvents,
  rollupsOf,
  writeDailyRows,
  type BackfillDailyRow,
  type BackfillIndexRow,
  type BackfillOpen,
  type BackfillSource,
} from "../apps/app-usage-backfill";
import {
  computeAppUsageStats,
  parseCommitAuthors,
  utcDay,
} from "../apps/app-usage.service";

/**
 * A dry run must not write ANYTHING — and Mongoose's default is to build
 * every imported model's indexes (and create its collection) on connect.
 */
export async function connectForBackfill(opts: {
  db?: string;
  write: boolean;
}): Promise<void> {
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error("DATABASE_URL is not set");
  await mongoose.connect(uri, {
    ...(opts.db ? { dbName: opts.db } : {}),
    autoIndex: false,
    autoCreate: false,
    ...(opts.write ? {} : { readPreference: "secondaryPreferred" as const }),
  });
}

export async function loadIndex(
  workspaceIds?: string[],
): Promise<BackfillIndexRow[]> {
  const rows = await AppIndexEntry.find(
    workspaceIds
      ? { workspaceId: { $in: workspaceIds.map(id => new Types.ObjectId(id)) } }
      : {},
  )
    .select("workspaceId appId path slug ownerId")
    .lean();
  return rows.map(r => ({
    workspaceId: r.workspaceId.toString(),
    appId: r.appId,
    path: r.path,
    slug: r.slug,
    ownerId: r.ownerId ?? null,
  }));
}

/** Email → user id, lowercased. */
export async function userIdsByEmail(
  emails: Iterable<string>,
): Promise<Map<string, string>> {
  const list = [...new Set([...emails].map(e => e.toLowerCase()))];
  const out = new Map<string, string>();
  for (let i = 0; i < list.length; i += 500) {
    const users = await User.find({ email: { $in: list.slice(i, i + 500) } })
      .select("_id email")
      .lean();
    for (const u of users) out.set(u.email.toLowerCase(), String(u._id));
  }
  return out;
}

export async function loadAuthors(
  index: BackfillIndexRow[],
  workspaceIds: string[],
  gitLogFile?: string,
): Promise<Map<string, Set<string>>> {
  const projects = await AppProject.find({
    workspaceId: { $in: workspaceIds.map(id => new Types.ObjectId(id)) },
  })
    .select("_id owner_id createdBy")
    .lean();
  let committers = new Map<string, Set<string>>();
  if (gitLogFile) {
    const emailsByApp = parseCommitAuthors(
      await readFile(gitLogFile, "utf8"),
      index.map(r => ({ appId: r.appId, path: r.path })),
    );
    const ids = await userIdsByEmail(
      [...emailsByApp.values()].flatMap(s => [...s]),
    );
    committers = new Map(
      [...emailsByApp].map(([appId, set]) => [
        appId,
        new Set([...set].map(e => ids.get(e)).filter((x): x is string => !!x)),
      ]),
    );
    console.log(`Commit authors read for ${committers.size} apps`);
  }
  return backfillAuthors({ index, projects, committers });
}

/** Rank and print; returns the rows for any further reporting. */
export function printSummary(input: {
  rows: BackfillDailyRow[];
  index: BackfillIndexRow[];
  authors: Map<string, Set<string>>;
  now: Date;
  windowDays: number;
  sortBy: "score" | "viewerDays";
  top?: number;
}): void {
  const since = utcDay(
    new Date(input.now.getTime() - (input.windowDays - 1) * 86_400_000),
  );
  const stats = computeAppUsageStats(
    rollupsOf(input.rows, since),
    input.authors,
    input.now,
  );
  const meta = new Map(input.index.map(r => [r.appId, r]));
  const ranked = [...stats.values()].sort(
    (a, b) =>
      (input.sortBy === "score"
        ? b.score - a.score
        : b.viewerDays - a.viewerDays) || b.score - a.score,
  );
  console.log(
    `\nTop ${input.top ?? 20} apps by ${input.sortBy} (${input.windowDays}-day window ending ${utcDay(input.now)}):`,
  );
  console.log(
    [
      "score",
      "viewerDays",
      "nonAuthViewers",
      "allViewerDays",
      "viewers",
      "anonViewers",
      "opens",
      "path",
    ].join("\t"),
  );
  for (const s of ranked.slice(0, input.top ?? 20)) {
    console.log(
      [
        s.score.toFixed(2),
        s.viewerDays,
        s.nonAuthorViewers,
        s.allViewerDays,
        s.viewers,
        s.anonViewers,
        s.opens,
        meta.get(s.appId)?.path ?? `(not indexed) ${s.appId}`,
      ].join("\t"),
    );
  }
  const workspaceIds = [...new Set(input.rows.map(r => r.workspaceId))];
  for (const ws of workspaceIds) {
    const apps = input.index.filter(a => a.workspaceId === ws);
    if (apps.length === 0) continue;
    const nonAuthorSeen = new Set<string>();
    const anySeen = new Set<string>();
    for (const row of input.rows) {
      if (row.workspaceId !== ws || row.day < since) continue;
      anySeen.add(row.appId);
      if (!row.userId || !input.authors.get(row.appId)?.has(row.userId)) {
        nonAuthorSeen.add(row.appId);
      }
    }
    console.log(
      `Workspace ${ws}: ${apps.length} indexed apps; ${apps.filter(a => anySeen.has(a.appId)).length} opened in the window; ` +
        `${apps.filter(a => !nonAuthorSeen.has(a.appId)).length} with ZERO non-author views (${apps.filter(a => !anySeen.has(a.appId)).length} with no views at all)`,
    );
  }
}

/** Flag, roll up, report the counts; on --write, write both stores. */
export async function finishBackfill(input: {
  source: BackfillSource;
  opens: BackfillOpen[];
  write: boolean;
  /** Raw events are written for [since, eventsBefore). */
  since: Date;
  eventsBefore: Date;
}): Promise<{ rows: BackfillDailyRow[] }> {
  const flagged = flagOpens(input.opens);
  const rows = dailyRowsOf(flagged.counted);
  console.log(
    `Opens: ${input.opens.length} → counted ${flagged.counted.length}; flagged ${flagged.bursts} tab-restore burst + ${flagged.repeats} re-open; ${flagged.bots} bots`,
  );
  console.log(
    `Daily rows: ${rows.length}; raw events: ${flagged.all.length} (${flagged.all.filter(o => o.at < input.eventsBefore).length} before ${input.eventsBefore.toISOString()} would be written)`,
  );
  if (!input.write) {
    console.log("\nDry run: nothing written. Re-run with --write to write.");
    return { rows };
  }
  const written = await writeDailyRows(rows);
  console.log(`\nUpserted ${written} daily rows ($max, idempotent).`);
  const workspaceIds = [...new Set(input.opens.map(o => o.workspaceId))];
  const { removed, inserted } = await replaceBackfillEvents(
    input.source,
    flagged.all,
    { workspaceIds, since: input.since, before: input.eventsBefore },
  );
  console.log(
    `Replaced ${removed} ${input.source} backfill events with ${inserted}.`,
  );
  return { rows };
}
