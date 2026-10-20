/* eslint-disable no-console, no-process-exit */
/**
 * Backfill app usage from Mako's own PostHog — months of app views where
 * Cloud Run logs keep 30 days.
 *
 * Source: the GTM `page_view` event on app.mako.ai (`$pageview` is a
 * parallel autocapture duplicate of it; localhost, the marketing site and
 * pr-* previews are other hosts and are left out). App views are page views
 * of one of these paths:
 *
 *   /a/<v1 app id>           the Apps v1 tab (removed 2026-08-30, #816). v1
 *                            ids no longer exist anywhere; the workspace
 *                            repo's `Migrate v1 app "<title>" (<id>)`
 *                            commits map each to the folder it became
 *                            (--v1-map, see below).
 *   /apps/<ref>              the app tab: id, slug or path, as the routes
 *                            resolve it. A slug that has since moved is
 *                            followed through the repo's renames (--renames).
 *   /view/<ws>/<ref>         the full-screen viewer page.
 *   /share/<org>/<token>     a public share link (`/share/<token>` too). An
 *                            unknown token (a v1 share, a rotated one) falls
 *                            back to the app whose slug equals it in the
 *                            org's workspace — reported separately.
 *
 * Sub-pages (`/apps/<x>/file/...`, `/a/<id>/data/...`) are someone working
 * on the app, not viewing it, and are skipped.
 *
 * Who: PostHog's `$user_id` when it is a Mako user, else the person's email
 * mapped to a user; else an anonymous visitor, stored as `ph:<hash>` of
 * PostHog's distinct id (counted with anonViewers, never in the score).
 * PostHog fires `page_view` on every history change, so switching back to
 * an open app tab is another page view: the re-open rule (same person, same
 * app, within 10 minutes) and the tab-restore burst rule apply exactly as
 * for the Cloud Run source — flagged, not dropped (apps/app-usage-backfill).
 *
 * Writes (only with --write): rollup rows by idempotent `$max`/`$min`
 * upserts, so overlapping the Cloud Run backfill or live tracking keeps the
 * larger count per row; raw events with `backfill: "posthog"`, replacing
 * this source's events in [--since, --events-before). `--events-before`
 * defaults to the first event recorded any other way, so the raw log never
 * holds the same view twice.
 *
 * Usage (from api/):
 *   POSTHOG_PERSONAL_API_KEY=... [POSTHOG_HOST=https://us.posthog.com]
 *   [POSTHOG_PROJECT_ID=281792] DATABASE_URL=... \
 *   tsx src/scripts/backfill-app-usage-posthog.ts [--since=2026-06-01]
 *     [--before=<ISO>] [--db=production] [--workspace-id=X]
 *     [--repo-workspace-id=<the workspace the repo files below describe>]
 *     [--v1-map=<file>] [--renames=<file>] [--git-log=<file>]
 *     [--events-before=<ISO>] [--write]
 *
 * The repo files, from a clone of the workspace repo:
 *   git log --all --format=%x00%s --name-only --grep="Migrate v1 app" > v1.log
 *   git log origin/main --format=%x00%H -M --name-status --diff-filter=R \
 *     -- apps users > renames.log
 *   git log origin/main --no-merges --since=365.days --format=%x00%ae \
 *     --name-only -- apps users > authors.log
 */

import * as dotenv from "dotenv";
dotenv.config({ quiet: true });

import { readFile } from "node:fs/promises";
import mongoose, { Types } from "mongoose";
import {
  AppProject,
  AppUsageEvent,
  Workspace,
  WorkspaceMember,
} from "../database/workspace-schema";
import { User } from "../database/schema";
import {
  anonIdFromPosthog,
  classifyUserAgent,
  utcDay,
} from "../apps/app-usage.service";
import {
  parseAppRenames,
  parseV1Migrations,
  resolveAppRefIn,
  type BackfillIndexRow,
  type BackfillOpen,
} from "../apps/app-usage-backfill";
import {
  connectForBackfill,
  finishBackfill,
  loadAuthors,
  loadIndex,
  printSummary,
  userIdsByEmail,
} from "./app-usage-backfill-cli";

interface Args {
  since: Date;
  before: Date;
  db?: string;
  workspaceId?: string;
  repoWorkspaceId?: string;
  v1Map?: string;
  renames?: string;
  gitLog?: string;
  eventsBefore?: Date;
  shareAliases?: string;
  write: boolean;
}

function parseArgs(): Args {
  const args: Args = {
    since: new Date("2026-06-01T00:00:00Z"),
    before: new Date(),
    write: false,
  };
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.split("=", 2);
    if (k === "--since") args.since = new Date(v);
    else if (k === "--before") args.before = new Date(v);
    else if (k === "--db") args.db = v;
    else if (k === "--workspace-id") args.workspaceId = v;
    else if (k === "--repo-workspace-id") args.repoWorkspaceId = v;
    else if (k === "--v1-map") args.v1Map = v;
    else if (k === "--renames") args.renames = v;
    else if (k === "--git-log") args.gitLog = v;
    else if (k === "--events-before") args.eventsBefore = new Date(v);
    else if (k === "--share-aliases") args.shareAliases = v;
    else if (k === "--write") args.write = true;
    else if (k === "--dry-run") args.write = false;
    else {
      console.error(`Unknown argument ${arg}`);
      process.exit(2);
    }
  }
  if ((args.v1Map || args.renames) && !args.repoWorkspaceId) {
    console.error("--v1-map/--renames need --repo-workspace-id");
    process.exit(2);
  }
  return args;
}

// ── PostHog ──

const APP_VIEW_PATH =
  "^/(a/[0-9a-f]{24}|apps/[^/]+|view/[0-9a-f]{24}/[^/]+|share/[^/]+(/[^/]+)?)/?$";
const PAGE_LIMIT = 50_000;
/** Apps v1 (and with it every v1 share link) was removed in #816. */
const V1_REMOVED_AT = new Date("2026-08-30T11:45:35Z");

type PosthogRow = [
  string, // timestamp
  string, // pathname
  string | null, // $user_id
  string | null, // person email
  string, // distinct_id
  string | null, // $session_id
  string | null, // $device_type
  string | null, // $referring_domain
  string | null, // $raw_user_agent
];

async function hogql<T>(query: string): Promise<T[]> {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  if (!key) throw new Error("POSTHOG_PERSONAL_API_KEY is not set");
  const host = process.env.POSTHOG_HOST || "https://us.posthog.com";
  const project = process.env.POSTHOG_PROJECT_ID || "281792";
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${host}/api/projects/${project}/query/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    });
    if (res.ok) {
      return ((await res.json()) as { results: T[] }).results;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise(r => setTimeout(r, 2 ** attempt * 2000));
      continue;
    }
    throw new Error(
      `PostHog query failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  }
}

const iso = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");

/** All app page views in [from, to), split until each page fits. */
async function readPageViews(from: Date, to: Date): Promise<PosthogRow[]> {
  const rows = await hogql<PosthogRow>(
    `select timestamp, properties.$pathname, properties.$user_id, person.properties.email, distinct_id, properties.$session_id, properties.$device_type, properties.$referring_domain, properties.$raw_user_agent
     from events
     where event = 'page_view' and properties.$host = 'app.mako.ai'
       and timestamp >= toDateTime('${iso(from)}') and timestamp < toDateTime('${iso(to)}')
       and match(properties.$pathname, '${APP_VIEW_PATH}')
     order by timestamp
     limit ${PAGE_LIMIT}`,
  );
  if (rows.length < PAGE_LIMIT) return rows;
  const mid = new Date((from.getTime() + to.getTime()) / 2);
  return [
    ...(await readPageViews(from, mid)),
    ...(await readPageViews(mid, to)),
  ];
}

// ── Main ──

async function main() {
  const args = parseArgs();
  await connectForBackfill(args);
  console.log(
    `${args.write ? "WRITE" : "DRY RUN"} — PostHog app page views ${args.since.toISOString()} → ${args.before.toISOString()}, db ${mongoose.connection.db?.databaseName}`,
  );

  const views: PosthogRow[] = [];
  for (
    let from = args.since;
    from < args.before;
    from = new Date(from.getTime() + 7 * 86_400_000)
  ) {
    const to = new Date(
      Math.min(from.getTime() + 7 * 86_400_000, args.before.getTime()),
    );
    views.push(...(await readPageViews(from, to)));
  }
  console.log(`Read ${views.length} app page views from PostHog`);

  // Who: $user_id when it is a Mako user, else the person's email.
  const userIdsSeen = [
    ...new Set(views.map(v => v[2]).filter((x): x is string => !!x)),
  ];
  const knownUsers = new Set<string>();
  for (let i = 0; i < userIdsSeen.length; i += 500) {
    const found = await User.find({
      _id: { $in: userIdsSeen.slice(i, i + 500) },
    })
      .select("_id")
      .lean();
    for (const u of found) knownUsers.add(String(u._id));
  }
  const idByEmail = await userIdsByEmail(
    views.map(v => v[3]).filter((x): x is string => !!x),
  );
  const userOf = (v: PosthogRow): string | null =>
    (v[2] && knownUsers.has(v[2]) ? v[2] : null) ??
    (v[3] ? (idByEmail.get(v[3].toLowerCase()) ?? null) : null);

  // Where: every workspace's index, the repo's history, shares.
  const index = await loadIndex(
    args.workspaceId ? [args.workspaceId] : undefined,
  );
  const indexByWs = new Map<string, BackfillIndexRow[]>();
  for (const row of index) {
    indexByWs.set(row.workspaceId, [
      ...(indexByWs.get(row.workspaceId) ?? []),
      row,
    ]);
  }
  const v1 = args.v1Map
    ? parseV1Migrations(await readFile(args.v1Map, "utf8"))
    : new Map<string, string>();
  const renames = args.renames
    ? parseAppRenames(await readFile(args.renames, "utf8"))
    : new Map<string, string>();
  const shareAliases: Record<string, string> = args.shareAliases
    ? JSON.parse(await readFile(args.shareAliases, "utf8"))
    : {};
  const memberships = new Map<string, string[]>();
  const viewers = [
    ...new Set(views.map(userOf).filter((x): x is string => !!x)),
  ];
  for (const m of await WorkspaceMember.find({ userId: { $in: viewers } })
    .select("workspaceId userId")
    .lean()) {
    const list = memberships.get(m.userId) ?? [];
    list.push(m.workspaceId.toString());
    memberships.set(m.userId, list);
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
  const workspaceBySlug = new Map(
    (await Workspace.find({}).select("_id slug").lean())
      .filter(w => w.slug)
      .map(w => [w.slug as string, w._id.toString()] as const),
  );

  const counters = {
    a: 0,
    apps: 0,
    view: 0,
    share: 0,
    shareBySlugFallback: 0,
    shareByAlias: 0,
    anonymous: 0,
    unresolved: 0,
  };
  const unresolved = new Map<string, number>();
  const miss = (path: string) => {
    counters.unresolved++;
    unresolved.set(path, (unresolved.get(path) ?? 0) + 1);
  };
  const months = new Map<
    string,
    { views: number; resolved: number; people: Set<string> }
  >();
  const opens: BackfillOpen[] = [];

  for (const v of views) {
    const [
      ts,
      pathname,
      ,
      ,
      distinctId,
      sessionId,
      deviceType,
      referringDomain,
      ua,
    ] = v;
    const at = new Date(ts);
    const month = ts.slice(0, 7);
    const mStats = months.get(month) ?? {
      views: 0,
      resolved: 0,
      people: new Set(),
    };
    months.set(month, mStats);
    mStats.views++;
    const userId = userOf(v);
    const path = pathname.replace(/\/+$/, "");
    const seg = path
      .split("/")
      .slice(1)
      .map(s => decodeURIComponent(s));

    let workspaceId: string | null = null;
    let appId: string | null = null;
    let source: BackfillOpen["source"] = "app";
    const inWorkspaces = (candidates: string[], ref: string) => {
      for (const ws of candidates) {
        const id = resolveAppRefIn(
          indexByWs.get(ws) ?? [],
          ref,
          ws === args.repoWorkspaceId ? renames : undefined,
        );
        // A bare unknown id resolves to itself; only accept it where the
        // index actually lists it, unless nothing else matched.
        if (id && (indexByWs.get(ws) ?? []).some(r => r.appId === id)) {
          return { ws, id };
        }
      }
      return null;
    };

    if (seg[0] === "a") {
      counters.a++;
      // After #816 the v1 tab route was gone: a page view of it saw nothing.
      const folder = at < V1_REMOVED_AT ? v1.get(seg[1]) : undefined;
      if (folder && args.repoWorkspaceId) {
        const hit = inWorkspaces([args.repoWorkspaceId], folder);
        if (hit) ({ ws: workspaceId, id: appId } = hit);
      }
    } else if (seg[0] === "apps") {
      counters.apps++;
      // The viewer's own workspaces first; then anywhere the ref is unique
      // to one app (a guest, or someone who has since left).
      const mine = userId ? (memberships.get(userId) ?? []) : [];
      const hit =
        inWorkspaces(mine, seg[1]) ??
        inWorkspaces(
          [...indexByWs.keys()].filter(ws => !mine.includes(ws)),
          seg[1],
        );
      if (hit) ({ ws: workspaceId, id: appId } = hit);
    } else if (seg[0] === "view") {
      counters.view++;
      const hit = inWorkspaces([seg[1]], seg[2]);
      if (hit) ({ ws: workspaceId, id: appId } = hit);
    } else if (seg[0] === "share") {
      counters.share++;
      source = "share";
      const token = seg.length >= 3 ? seg[2] : seg[1];
      const row = appByToken.get(token);
      if (row) {
        workspaceId = row.workspaceId.toString();
        appId = row._id.toString();
      } else if (
        at < V1_REMOVED_AT &&
        seg.length >= 3 &&
        workspaceBySlug.has(seg[1])
      ) {
        // A v1 share (no v2 token by that name): the app whose slug is the
        // share's name. After v1 was removed such a link was dead, so a page
        // view of it then was nobody seeing the app.
        const ws = workspaceBySlug.get(seg[1]) as string;
        const hit = inWorkspaces([ws], token);
        if (hit) {
          counters.shareBySlugFallback++;
          ({ ws: workspaceId, id: appId } = hit);
        }
      }
      if (
        !appId &&
        at < V1_REMOVED_AT &&
        seg.length >= 3 &&
        workspaceBySlug.has(seg[1])
      ) {
        // A share link that died with Apps v1, pointed at the app it became
        // by the operator (--share-aliases): nothing in the data links them.
        const alias = shareAliases[`${seg[1]}/${token}`];
        const ws = workspaceBySlug.get(seg[1]) as string;
        const hit = alias ? inWorkspaces([ws], alias) : null;
        if (hit) {
          counters.shareByAlias++;
          ({ ws: workspaceId, id: appId } = hit);
        }
      }
    }
    if (!workspaceId || !appId) {
      miss(seg[0] === "a" ? `/a/<v1 id ${seg[1]}>` : path);
      continue;
    }
    if (args.workspaceId && workspaceId !== args.workspaceId) continue;
    mStats.resolved++;
    const anonId = userId ? null : anonIdFromPosthog(distinctId);
    if (!userId) counters.anonymous++;
    mStats.people.add(userId ?? (anonId as string));
    const uaClass =
      classifyUserAgent(ua) === "bot"
        ? "bot"
        : deviceType === "Mobile" || deviceType === "Tablet"
          ? "mobile"
          : deviceType === "Desktop"
            ? "desktop"
            : classifyUserAgent(ua);
    opens.push({
      workspaceId,
      appId,
      userId,
      anonId,
      viewerKey: userId ?? (anonId as string),
      at,
      source,
      uaClass,
      referrerKind:
        !referringDomain || referringDomain === "$direct"
          ? "direct"
          : /(^|\.)mako\.ai$/.test(referringDomain)
            ? "internal"
            : "external",
      sessionId: sessionId ? `ph:${sessionId}` : null,
    });
  }

  console.log("Counters:", counters);
  console.log(
    "\nCoverage by month (page views → resolved app opens, distinct viewers):",
  );
  for (const [m, s] of [...months].sort()) {
    console.log(
      `  ${m}: ${s.views} views, ${s.resolved} resolved, ${s.people.size} viewers`,
    );
  }
  console.log(
    `\nUnresolved paths (${unresolved.size} distinct, ${counters.unresolved} views), top 25:`,
  );
  for (const [p, n] of [...unresolved]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)) {
    console.log(`  ${n}\t${p}`);
  }

  // Raw events stop where another recorder starts, unless told otherwise.
  const workspaceIds = [...new Set(opens.map(o => o.workspaceId))];
  let eventsBefore = args.eventsBefore ?? args.before;
  if (!args.eventsBefore) {
    const first = await AppUsageEvent.findOne({
      workspaceId: { $in: workspaceIds.map(id => new Types.ObjectId(id)) },
      backfill: { $ne: "posthog" },
    })
      .sort({ at: 1 })
      .select("at")
      .lean()
      .catch(() => null);
    if (first && first.at < eventsBefore) eventsBefore = first.at;
  }

  const { rows } = await finishBackfill({
    source: "posthog",
    opens,
    write: args.write,
    since: args.since,
    eventsBefore,
  });
  const authors = await loadAuthors(index, workspaceIds, args.gitLog);
  printSummary({
    rows,
    index,
    authors,
    now: args.before,
    windowDays: 90,
    sortBy: "viewerDays",
    top: 25,
  });
  printSummary({
    rows,
    index,
    authors,
    now: args.before,
    windowDays: 28,
    sortBy: "score",
    top: 10,
  });
  console.log(`\nDays covered: ${utcDay(args.since)} → ${utcDay(args.before)}`);
  await mongoose.disconnect();
}

main().catch(async error => {
  console.error(error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
