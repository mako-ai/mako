/* eslint-disable no-console, no-process-exit */
/**
 * Backfill app_usage_daily from Cloud Run request logs.
 *
 * Usage tracking (app-usage.service) starts counting when it deploys; this
 * reconstructs the weeks before it from what the logs already say:
 *
 *   - `POST /api/workspaces/<ws>/apps/<id>/view-token` (stdout http log, has
 *     userId) — minted exactly when a published app is shown, in an app tab
 *     or on the /view/ page. The best open signal there is. Two caveats the
 *     script corrects for: a page reload restores every open app tab at
 *     once, so a burst of tokens for several apps by one person within
 *     BURST_MS is a tab restore, not views (dropped); and a re-mint for the
 *     same person and app within DEDUPE_MS is the same view (collapsed).
 *   - `GET /api/workspaces/<ws>/apps/<id>/live/` answered 200 (a raw link) —
 *     the 302s are browser visits redirected to /view/, already counted by
 *     their view token.
 *   - `GET /api/share/<token>/app/` (request log, anonymous) — a share-link
 *     page load; a referer from another site marks an embed. Bots are kept
 *     as raw events (uaClass bot) and never counted.
 *
 * With `--write` it also writes RAW events (`app_usage_events`, `backfill:
 * true`): every open above, the dropped ones kept with `throttled: true`.
 * Anonymous events carry `anonId: null` — the logs only have an IP, which is
 * never turned into an id — and `sessionId: null`.
 *
 * Nothing in the logs measures time on page, so backfilled rows carry
 * activeSeconds 0. Writes are idempotent (`$max` / `$min`), so a re-run, or
 * a run overlapping live tracking, never double counts.
 *
 * Usage (from api/):
 *   DATABASE_URL=... tsx src/scripts/backfill-app-usage.ts \
 *     [--days=30] [--before=<ISO>] [--project=mako-ai-prod] [--db=production]
 *     [--workspace-id=X] [--git-log=<file>] [--write]
 *
 * Dry run by default: reads logs and Mongo, prints a summary (top apps by
 * score, apps nobody but their authors opened), writes nothing.
 * `--git-log` adds commit authorship to the author exclusion, as the service
 * does; produce it from a clone of the workspace repo with
 *   git log origin/main --no-merges --since=365.days --format=%x00%ae \
 *     --name-only -- apps users > authors.log
 */

import * as dotenv from "dotenv";
dotenv.config({ quiet: true });

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import mongoose, { Types } from "mongoose";
import {
  AppIndexEntry,
  AppProject,
  AppUsageDaily,
  AppUsageEvent,
  type AppUsageReferrerKind,
  type AppUsageUaClass,
} from "../database/workspace-schema";
import { User } from "../database/schema";
import {
  classifyReferrer,
  classifyUserAgent,
  computeAppUsageStats,
  parseCommitAuthors,
  utcDay,
  type AppUsageRollup,
  type AppUsageSource,
} from "../apps/app-usage.service";

const BURST_MS = 3_000;
const DEDUPE_MS = 10 * 60 * 1000;
interface Args {
  days: number;
  before: Date;
  project: string;
  db?: string;
  workspaceId?: string;
  gitLog?: string;
  write: boolean;
}

function parseArgs(): Args {
  const args: Args = {
    days: 30,
    before: new Date(),
    project: "mako-ai-prod",
    write: false,
  };
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.split("=", 2);
    if (k === "--days") args.days = Number(v) || 30;
    else if (k === "--before") args.before = new Date(v);
    else if (k === "--project") args.project = v;
    else if (k === "--db") args.db = v;
    else if (k === "--workspace-id") args.workspaceId = v;
    else if (k === "--git-log") args.gitLog = v;
    else if (k === "--write") args.write = true;
    else if (k === "--dry-run") args.write = false;
    else {
      console.error(`Unknown argument ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function run(cmd: string, argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      argv,
      { maxBuffer: 1024 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`${cmd} failed: ${stderr || error.message}`))
          : resolve(stdout),
    );
  });
}

async function readLogs<T>(args: Args, filter: string): Promise<T[]> {
  const since = new Date(args.before.getTime() - args.days * 86_400_000);
  const full = `${filter} AND timestamp>="${since.toISOString()}" AND timestamp<"${args.before.toISOString()}"`;
  const out = await run("gcloud", [
    "logging",
    "read",
    full,
    `--project=${args.project}`,
    "--format=json",
    "--limit=1000000",
  ]);
  return JSON.parse(out || "[]") as T[];
}

interface StdoutEntry {
  jsonPayload?: {
    path?: string;
    message?: string;
    userId?: string;
    timestamp?: string;
  };
  timestamp: string;
}

interface RequestEntry {
  timestamp: string;
  httpRequest?: {
    requestUrl?: string;
    status?: number;
    referer?: string;
    remoteIp?: string;
    userAgent?: string;
  };
}

interface RawOpen {
  workspaceId: string;
  ref: string;
  userId: string | null;
  at: Date;
  source: AppUsageSource;
  /** Anonymous: the client, for counting distinct share viewers. */
  client?: string;
  uaClass: AppUsageUaClass;
  referrerKind?: AppUsageReferrerKind;
  /**
   * A tab-restore burst or a repeat within DEDUPE_MS: kept as a raw event,
   * flagged, and left out of the rollup — the same rule live tracking uses.
   */
  throttled?: boolean;
}

const APP_PATH =
  /^\/api\/workspaces\/([0-9a-f]{24})\/apps\/(.+?)\/(view-token|live\/?)$/;

function statusOf(message: string | undefined): number | null {
  const m = message?.match(/ (\d{3}) \d+ms$/);
  return m ? Number(m[1]) : null;
}

async function main() {
  const args = parseArgs();
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error("DATABASE_URL is not set");
  // A dry run must not write ANYTHING — and Mongoose's default is to build
  // every imported model's indexes (and create its collection) on connect.
  await mongoose.connect(uri, {
    ...(args.db ? { dbName: args.db } : {}),
    autoIndex: false,
    autoCreate: false,
    ...(args.write ? {} : { readPreference: "secondaryPreferred" as const }),
  });
  console.log(
    `${args.write ? "WRITE" : "DRY RUN"} — ${args.days} days of ${args.project} logs before ${args.before.toISOString()}, db ${mongoose.connection.db?.databaseName}`,
  );

  // ── Logs ──
  const [appEntries, shareEntries] = await Promise.all([
    readLogs<StdoutEntry>(
      args,
      'logName="projects/' +
        args.project +
        '/logs/run.googleapis.com%2Fstdout" AND jsonPayload.category="http" AND (jsonPayload.path=~"/apps/[^/]+/view-token$" OR jsonPayload.path=~"/apps/.+/live/?$")',
    ),
    readLogs<RequestEntry>(
      args,
      'logName="projects/' +
        args.project +
        '/logs/run.googleapis.com%2Frequests" AND httpRequest.requestUrl=~"/api/share/[^/]+/app/?([?].*)?$"',
    ),
  ]);
  console.log(
    `Read ${appEntries.length} app-view log lines, ${shareEntries.length} share-link requests`,
  );

  const counters = {
    viewTokens: 0,
    liveRaw: 0,
    liveRedirects: 0,
    nonOk: 0,
    restoreBursts: 0,
    deduped: 0,
    unresolved: 0,
    shares: 0,
    shareBots: 0,
    shareUnknownToken: 0,
  };

  const signedIn: RawOpen[] = [];
  for (const e of appEntries) {
    const p = e.jsonPayload;
    const m = p?.path?.match(APP_PATH);
    if (!p || !m) continue;
    const status = statusOf(p.message);
    if (m[3].startsWith("live")) {
      if (status === 302) {
        counters.liveRedirects++;
        continue;
      }
      if (status !== 200) {
        counters.nonOk++;
        continue;
      }
      counters.liveRaw++;
    } else {
      if (status !== 200) {
        counters.nonOk++;
        continue;
      }
      counters.viewTokens++;
    }
    if (!p.userId) continue;
    if (args.workspaceId && m[1] !== args.workspaceId) continue;
    signedIn.push({
      workspaceId: m[1],
      ref: decodeURIComponent(m[2]),
      userId: p.userId,
      at: new Date(p.timestamp ?? e.timestamp),
      source: "app",
      // The stdout http log carries no User-Agent.
      uaClass: "unknown",
    });
  }

  // Tab restores: several distinct apps within BURST_MS by one person.
  signedIn.sort((a, b) => a.at.getTime() - b.at.getTime());
  const byUser = new Map<string, RawOpen[]>();
  for (const o of signedIn) {
    const list = byUser.get(o.userId!) ?? [];
    list.push(o);
    byUser.set(o.userId!, list);
  }
  const kept: RawOpen[] = [];
  // Opens the rollup leaves out but the raw event log keeps, flagged.
  const flagged: RawOpen[] = [];
  for (const list of byUser.values()) {
    let i = 0;
    while (i < list.length) {
      let j = i + 1;
      while (
        j < list.length &&
        list[j].at.getTime() - list[j - 1].at.getTime() <= BURST_MS
      ) {
        j++;
      }
      const group = list.slice(i, j);
      const distinct = new Set(group.map(g => g.ref));
      if (distinct.size >= 2) {
        counters.restoreBursts += group.length;
        flagged.push(...group.map(g => ({ ...g, throttled: true })));
      } else {
        kept.push(...group);
      }
      i = j;
    }
  }
  // Same person, same app, within DEDUPE_MS: one view.
  kept.sort((a, b) => a.at.getTime() - b.at.getTime());
  const lastKept = new Map<string, number>();
  const opens: RawOpen[] = [];
  for (const o of kept) {
    const k = `${o.userId}:${o.ref}`;
    const last = lastKept.get(k);
    if (last !== undefined && o.at.getTime() - last < DEDUPE_MS) {
      counters.deduped++;
      flagged.push({ ...o, throttled: true });
      continue;
    }
    lastKept.set(k, o.at.getTime());
    opens.push(o);
  }

  // Shares → app rows by token.
  const shareRows = await AppProject.find({
    "publicShare.token": { $exists: true },
  })
    .select("_id workspaceId publicShare.token")
    .lean();
  const appByToken = new Map(
    shareRows
      .filter(r => r.publicShare?.token)
      .map(r => [r.publicShare!.token, r] as const),
  );
  const lastShare = new Map<string, number>();
  for (const e of shareEntries.sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  )) {
    const req = e.httpRequest;
    if (!req?.requestUrl || req.status !== 200) continue;
    const token = new URL(req.requestUrl).pathname.match(
      /^\/api\/share\/([^/]+)\/app\/?$/,
    )?.[1];
    const row = token ? appByToken.get(token) : undefined;
    if (!row) {
      counters.shareUnknownToken++;
      continue;
    }
    const workspaceId = row.workspaceId.toString();
    if (args.workspaceId && workspaceId !== args.workspaceId) continue;
    const at = new Date(e.timestamp);
    const referrerKind = classifyReferrer(req.referer, "app.mako.ai");
    const base = {
      workspaceId,
      ref: row._id.toString(),
      userId: null,
      at,
      // A frame on another site is an embed; the logs cannot say better.
      source: (referrerKind === "external"
        ? "embed"
        : "share") as AppUsageSource,
      uaClass: classifyUserAgent(req.userAgent),
      referrerKind,
    };
    if (base.uaClass === "bot") {
      counters.shareBots++;
      flagged.push(base);
      continue;
    }
    // The IP+UA pair only dedupes reloads here; it never becomes an id —
    // backfilled anonymous viewers stay anonId null (indistinguishable).
    const client = `${(req.remoteIp ?? "").split(",")[0]}|${req.userAgent ?? ""}`;
    const k = `${client}:${token}`;
    const last = lastShare.get(k);
    if (last !== undefined && at.getTime() - last < DEDUPE_MS) {
      counters.deduped++;
      flagged.push({ ...base, throttled: true });
      continue;
    }
    lastShare.set(k, at.getTime());
    counters.shares++;
    opens.push({ ...base, client });
  }

  // ── Resolve refs → app ids via the index ──
  const workspaceIds = [...new Set(opens.map(o => o.workspaceId))];
  const index = await AppIndexEntry.find({
    workspaceId: { $in: workspaceIds.map(id => new Types.ObjectId(id)) },
  })
    .select("workspaceId appId path slug title scope ownerId")
    .lean();
  const indexByWs = new Map<string, typeof index>();
  for (const row of index) {
    const ws = row.workspaceId.toString();
    indexByWs.set(ws, [...(indexByWs.get(ws) ?? []), row]);
  }
  const resolve = (ws: string, ref: string): string | null => {
    const rows = indexByWs.get(ws) ?? [];
    const clean = ref.replace(/^\/+|\/+$/g, "");
    const hit =
      rows.find(r => r.appId === clean.toLowerCase()) ??
      rows.find(r => r.path === clean || r.path === `apps/${clean}`) ??
      (rows.filter(r => r.slug === clean).length === 1
        ? rows.find(r => r.slug === clean)
        : undefined);
    // An id the index no longer lists (a deleted app) is still an id.
    if (!hit && /^[0-9a-f]{24}$/i.test(clean)) return clean.toLowerCase();
    return hit?.appId ?? null;
  };

  interface DailyRow {
    workspaceId: string;
    appId: string;
    userId: string | null;
    day: string;
    opens: number;
    sources: Partial<Record<AppUsageSource, number>>;
    firstAt: Date;
    lastAt: Date;
  }
  const daily = new Map<string, DailyRow>();
  const shareClients = new Map<string, Set<string>>();
  for (const o of opens) {
    const appId = resolve(o.workspaceId, o.ref);
    if (!appId) {
      counters.unresolved++;
      continue;
    }
    if (o.client) {
      const set = shareClients.get(appId) ?? new Set();
      set.add(o.client);
      shareClients.set(appId, set);
    }
    const day = utcDay(o.at);
    const k = `${o.workspaceId}|${appId}|${o.userId}|${day}`;
    let row = daily.get(k);
    if (!row) {
      row = {
        workspaceId: o.workspaceId,
        appId,
        userId: o.userId,
        day,
        opens: 0,
        sources: {},
        firstAt: o.at,
        lastAt: o.at,
      };
      daily.set(k, row);
    }
    row.opens++;
    row.sources[o.source] = (row.sources[o.source] ?? 0) + 1;
    if (o.at < row.firstAt) row.firstAt = o.at;
    if (o.at > row.lastAt) row.lastAt = o.at;
  }

  // Raw events: every open the logs show, counted or not, flagged as the
  // live log flags them. Anonymous ones have no id — an IP is not a person.
  const events: Array<Record<string, unknown>> = [];
  for (const o of [...opens, ...flagged]) {
    const appId = resolve(o.workspaceId, o.ref);
    if (!appId) continue;
    events.push({
      workspaceId: new Types.ObjectId(o.workspaceId),
      appId,
      at: o.at,
      kind: "open",
      source: o.source,
      userId: o.userId,
      anonId: null,
      sessionId: null,
      ...(o.referrerKind ? { referrerKind: o.referrerKind } : {}),
      uaClass: o.uaClass,
      ...(o.throttled ? { throttled: true } : {}),
      backfill: true,
    });
  }
  events.sort((a, b) => (a.at as Date).getTime() - (b.at as Date).getTime());

  console.log("\nCounters:", counters);
  console.log(`Daily rows: ${daily.size}`);
  const flaggedEvents = events.filter(e => e.throttled).length;
  const botEvents = events.filter(e => e.uaClass === "bot").length;
  console.log(
    `Raw events: ${events.length} (${events.length - flaggedEvents - botEvents} counted, ${flaggedEvents} flagged throttled, ${botEvents} bots)`,
  );

  // ── Summary per workspace ──
  const projects = await AppProject.find({
    workspaceId: { $in: workspaceIds.map(id => new Types.ObjectId(id)) },
  })
    .select("_id owner_id createdBy")
    .lean();
  let commitAuthors = new Map<string, Set<string>>();
  if (args.gitLog) {
    const log = await readFile(args.gitLog, "utf8");
    const emailsByApp = parseCommitAuthors(
      log,
      index.map(r => ({ appId: r.appId, path: r.path })),
    );
    const emails = [...new Set([...emailsByApp.values()].flatMap(s => [...s]))];
    const users = await User.find({ email: { $in: emails } })
      .select("_id email")
      .lean();
    const idByEmail = new Map(
      users.map(u => [u.email.toLowerCase(), String(u._id)]),
    );
    commitAuthors = new Map(
      [...emailsByApp].map(([appId, set]) => [
        appId,
        new Set(
          [...set].map(e => idByEmail.get(e)).filter((x): x is string => !!x),
        ),
      ]),
    );
    console.log(
      `Commit authors read for ${commitAuthors.size} apps from ${args.gitLog}`,
    );
  }
  const authors = new Map<string, Set<string>>(commitAuthors);
  const addAuthor = (appId: string, id: string | null | undefined) => {
    if (!id) return;
    const set = authors.get(appId) ?? new Set();
    set.add(id);
    authors.set(appId, set);
  };
  for (const r of index) addAuthor(r.appId, r.ownerId);
  for (const p of projects) {
    addAuthor(p._id.toString(), p.owner_id);
    addAuthor(p._id.toString(), p.createdBy);
  }

  const now = args.before;
  const windowStart = utcDay(new Date(now.getTime() - 27 * 86_400_000));
  const rollups = new Map<string, AppUsageRollup>();
  for (const row of daily.values()) {
    if (row.day < windowStart) continue;
    const k = `${row.appId}|${row.userId}`;
    const r = rollups.get(k) ?? {
      appId: row.appId,
      userId: row.userId,
      days: [],
      opens: 0,
      activeSeconds: 0,
      lastAt: row.lastAt,
    };
    r.days.push(row.day);
    r.opens += row.opens;
    if (row.lastAt > r.lastAt) r.lastAt = row.lastAt;
    rollups.set(k, r);
  }
  const stats = computeAppUsageStats([...rollups.values()], authors, now);
  const meta = new Map(index.map(r => [r.appId, r]));
  const ranked = [...stats.values()].sort((a, b) => b.score - a.score);
  console.log(`\nTop 20 apps by score (28-day window ending ${utcDay(now)}):`);
  console.log(
    [
      "score",
      "nonAuthViewers",
      "viewerDays",
      "viewers",
      "opens",
      "shareClients",
      "path",
    ].join("\t"),
  );
  for (const s of ranked.slice(0, 20)) {
    console.log(
      [
        s.score.toFixed(2),
        s.nonAuthorViewers,
        s.viewerDays,
        s.viewers,
        s.opens,
        shareClients.get(s.appId)?.size ?? 0,
        meta.get(s.appId)?.path ?? `(not indexed) ${s.appId}`,
      ].join("\t"),
    );
  }
  for (const ws of workspaceIds) {
    const apps = indexByWs.get(ws) ?? [];
    if (apps.length === 0) continue;
    // "Viewed" over the whole backfill window, signed in or by share link.
    const nonAuthorSeen = new Set<string>();
    const anySeen = new Set<string>();
    for (const row of daily.values()) {
      if (row.workspaceId !== ws) continue;
      anySeen.add(row.appId);
      if (!row.userId || !authors.get(row.appId)?.has(row.userId)) {
        nonAuthorSeen.add(row.appId);
      }
    }
    const zero = apps.filter(a => !nonAuthorSeen.has(a.appId));
    console.log(
      `\nWorkspace ${ws}: ${apps.length} indexed apps; ${anySeen.size} opened at all in ${args.days} days; ` +
        `${zero.length} with ZERO non-author views (${apps.filter(a => !anySeen.has(a.appId)).length} with no views at all)`,
    );
  }

  if (!args.write) {
    console.log("\nDry run: nothing written. Re-run with --write to upsert.");
  } else {
    const ops = [...daily.values()].map(row => ({
      updateOne: {
        filter: {
          workspaceId: new Types.ObjectId(row.workspaceId),
          appId: row.appId,
          userId: row.userId,
          day: row.day,
        },
        update: {
          $max: {
            opens: row.opens,
            lastAt: row.lastAt,
            ...Object.fromEntries(
              Object.entries(row.sources).map(([s, n]) => [`sources.${s}`, n]),
            ),
          },
          $min: { firstAt: row.firstAt },
          $setOnInsert: { activeSeconds: 0 },
        },
        upsert: true,
      },
    }));
    for (let i = 0; i < ops.length; i += 1000) {
      await AppUsageDaily.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    }
    console.log(`\nWrote ${ops.length} daily rows.`);
    // Raw events are replaced, not merged: drop this window's earlier
    // backfill (never live events) and insert the fresh reconstruction, so
    // a re-run is idempotent.
    const since = new Date(args.before.getTime() - args.days * 86_400_000);
    const removed = await AppUsageEvent.deleteMany({
      backfill: true,
      workspaceId: { $in: workspaceIds.map(id => new Types.ObjectId(id)) },
      at: { $gte: since, $lt: args.before },
    });
    for (let i = 0; i < events.length; i += 1000) {
      await AppUsageEvent.insertMany(events.slice(i, i + 1000), {
        ordered: false,
      });
    }
    console.log(
      `Replaced ${removed.deletedCount} backfilled events with ${events.length}.`,
    );
  }
  await mongoose.disconnect();
}

main().catch(async error => {
  console.error(error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
