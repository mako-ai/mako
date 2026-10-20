/* eslint-disable no-console, no-process-exit */
/**
 * Backfill app usage from Cloud Run request logs.
 *
 * Usage tracking (app-usage.service) starts counting when it deploys; this
 * reconstructs the weeks before it from what the logs already say (Cloud
 * Logging keeps ~30 days; backfill-app-usage-posthog.ts reaches further):
 *
 *   - `POST /api/workspaces/<ws>/apps/<id>/view-token` (stdout http log, has
 *     userId) — minted exactly when a published app is shown, in an app tab
 *     or on the /view/ page. The best open signal there is.
 *   - `GET /api/workspaces/<ws>/apps/<id>/live/` answered 200 (a raw link) —
 *     the 302s are browser visits redirected to /view/, already counted by
 *     their view token.
 *   - `GET /api/share/<token>/app/` (request log, anonymous) — a share-link
 *     page load; a referer from another site marks an embed.
 *
 * Tab-restore bursts and re-opens are flagged, not dropped, and bots kept
 * as `uaClass: "bot"` (see apps/app-usage-backfill.ts). Anonymous events
 * carry `anonId: null`: the logs only have an IP, which is never turned
 * into an id. Nothing in the logs measures time on page, so backfilled rows
 * carry activeSeconds 0.
 *
 * Writes: rollup rows by idempotent `$max`/`$min` upserts (overlapping live
 * tracking or the PostHog backfill keeps the larger count); raw events with
 * `backfill: "cloud-run"`, replacing this source's events in the window.
 *
 * Usage (from api/):
 *   DATABASE_URL=... tsx src/scripts/backfill-app-usage.ts \
 *     [--days=30] [--before=<ISO>] [--project=mako-ai-prod] [--db=production]
 *     [--workspace-id=X] [--git-log=<file>] [--write]
 *
 * Dry run by default: reads logs and Mongo, prints a summary, writes
 * nothing. `--git-log` adds commit authorship to the author exclusion, as
 * the service does; produce it from a clone of the workspace repo with
 *   git log origin/main --no-merges --since=365.days --format=%x00%ae \
 *     --name-only -- apps users > authors.log
 */

import * as dotenv from "dotenv";
dotenv.config({ quiet: true });

import { execFile } from "node:child_process";
import mongoose from "mongoose";
import { AppProject } from "../database/workspace-schema";
import { classifyReferrer, classifyUserAgent } from "../apps/app-usage.service";
import { resolveAppRefIn, type BackfillOpen } from "../apps/app-usage-backfill";
import {
  connectForBackfill,
  finishBackfill,
  loadAuthors,
  loadIndex,
  printSummary,
} from "./app-usage-backfill-cli";

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

const APP_PATH =
  /^\/api\/workspaces\/([0-9a-f]{24})\/apps\/(.+?)\/(view-token|live\/?)$/;

function statusOf(message: string | undefined): number | null {
  const m = message?.match(/ (\d{3}) \d+ms$/);
  return m ? Number(m[1]) : null;
}

async function main() {
  const args = parseArgs();
  await connectForBackfill(args);
  const since = new Date(args.before.getTime() - args.days * 86_400_000);
  console.log(
    `${args.write ? "WRITE" : "DRY RUN"} — ${args.days} days of ${args.project} logs before ${args.before.toISOString()}, db ${mongoose.connection.db?.databaseName}`,
  );

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

  const index = await loadIndex(
    args.workspaceId ? [args.workspaceId] : undefined,
  );
  const indexByWs = new Map<string, typeof index>();
  for (const row of index) {
    indexByWs.set(row.workspaceId, [
      ...(indexByWs.get(row.workspaceId) ?? []),
      row,
    ]);
  }
  const counters = {
    viewTokens: 0,
    liveRaw: 0,
    liveRedirects: 0,
    nonOk: 0,
    unresolved: 0,
    shares: 0,
    shareUnknownToken: 0,
  };
  const opens: BackfillOpen[] = [];

  for (const e of appEntries) {
    const p = e.jsonPayload;
    const m = p?.path?.match(APP_PATH);
    if (!p || !m) continue;
    const status = statusOf(p.message);
    if (m[3].startsWith("live") && status === 302) {
      counters.liveRedirects++;
      continue;
    }
    if (status !== 200) {
      counters.nonOk++;
      continue;
    }
    if (m[3].startsWith("live")) counters.liveRaw++;
    else counters.viewTokens++;
    if (!p.userId) continue;
    if (args.workspaceId && m[1] !== args.workspaceId) continue;
    const appId = resolveAppRefIn(
      indexByWs.get(m[1]) ?? [],
      decodeURIComponent(m[2]),
    );
    if (!appId) {
      counters.unresolved++;
      continue;
    }
    opens.push({
      workspaceId: m[1],
      appId,
      userId: p.userId,
      anonId: null,
      viewerKey: p.userId,
      at: new Date(p.timestamp ?? e.timestamp),
      source: "app",
      // The stdout http log carries no User-Agent.
      uaClass: "unknown",
    });
  }

  const shareRows = await AppProject.find({
    "publicShare.token": { $exists: true },
  })
    .select("_id workspaceId publicShare.token")
    .lean();
  const appByToken = new Map(
    shareRows
      .filter(r => r.publicShare?.token)
      .map(r => [r.publicShare?.token as string, r] as const),
  );
  for (const e of shareEntries) {
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
    const referrerKind = classifyReferrer(req.referer, "app.mako.ai");
    counters.shares++;
    opens.push({
      workspaceId,
      appId: row._id.toString(),
      userId: null,
      anonId: null,
      // IP+UA only groups reloads for the dedupe rules; it is never stored.
      viewerKey: `client:${(req.remoteIp ?? "").split(",")[0]}|${req.userAgent ?? ""}`,
      at: new Date(e.timestamp),
      // A frame on another site is an embed; the logs cannot say better.
      source: referrerKind === "external" ? "embed" : "share",
      uaClass: classifyUserAgent(req.userAgent),
      referrerKind,
    });
  }
  console.log("Counters:", counters);

  const { rows } = await finishBackfill({
    source: "cloud-run",
    opens,
    write: args.write,
    since,
    eventsBefore: args.before,
  });
  const workspaceIds = [...new Set(opens.map(o => o.workspaceId))];
  printSummary({
    rows,
    index,
    authors: await loadAuthors(index, workspaceIds, args.gitLog),
    now: args.before,
    windowDays: 28,
    sortBy: "score",
  });
  await mongoose.disconnect();
}

main().catch(async error => {
  console.error(error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
