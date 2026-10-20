/**
 * Shared machinery for reconstructing app usage from history — Cloud Run
 * logs (scripts/backfill-app-usage.ts) and PostHog page views
 * (scripts/backfill-app-usage-posthog.ts).
 *
 * Both sources over-report the same two ways, and both are corrected the
 * same way live tracking is: nothing is dropped, the extra opens are kept
 * as raw events flagged `throttled` and left out of the rollup.
 *
 *   - Tab restores: a reload remounts every open app tab, so one person
 *     "opening" several apps within BURST_MS is a restore, not views.
 *   - Re-opens: the same person on the same app again within DEDUPE_MS is
 *     the same view — a token re-mint, or (PostHog fires on every history
 *     change) switching back to a tab that was already open.
 *
 * Rollup writes are idempotent `$max`/`$min` upserts, so a source that
 * overlaps another (or live tracking) never double counts: an overlapping
 * row keeps the larger count. Raw events are REPLACED per source and
 * window, never merged.
 */
import { Types } from "mongoose";
import {
  AppUsageDaily,
  AppUsageEvent,
  type AppUsageReferrerKind,
  type AppUsageUaClass,
} from "../database/workspace-schema";
import {
  utcDay,
  type AppUsageRollup,
  type AppUsageSource,
} from "./app-usage.service";

export const BURST_MS = 3_000;
export const DEDUPE_MS = 10 * 60 * 1000;

export type BackfillSource = "cloud-run" | "posthog";

/** One reconstructed open, already resolved to an app. */
export interface BackfillOpen {
  workspaceId: string;
  appId: string;
  userId: string | null;
  anonId: string | null;
  /**
   * Who the burst/re-open rules group by: the user, the anonymous id, or —
   * for log lines with neither — whatever tells clients apart for dedupe
   * only (never stored).
   */
  viewerKey: string;
  at: Date;
  source: AppUsageSource;
  uaClass: AppUsageUaClass;
  referrerKind?: AppUsageReferrerKind;
  sessionId?: string | null;
  throttled?: boolean;
}

export interface FlaggedOpens {
  /** What the rollup counts. */
  counted: BackfillOpen[];
  /** Everything, counted or not, for the raw event log. */
  all: BackfillOpen[];
  bursts: number;
  repeats: number;
  bots: number;
}

/**
 * Apply the burst and re-open rules. Pure, so it is unit-tested. Bots are
 * kept (uaClass "bot") but never counted, and are not "throttled".
 */
export function flagOpens(opens: ReadonlyArray<BackfillOpen>): FlaggedOpens {
  const sorted = [...opens].sort((a, b) => a.at.getTime() - b.at.getTime());
  const all: BackfillOpen[] = [];
  let bots = 0;
  const byViewer = new Map<string, BackfillOpen[]>();
  for (const o of sorted) {
    if (o.uaClass === "bot") {
      bots++;
      all.push(o);
      continue;
    }
    const list = byViewer.get(o.viewerKey) ?? [];
    list.push(o);
    byViewer.set(o.viewerKey, list);
  }
  let bursts = 0;
  let repeats = 0;
  const counted: BackfillOpen[] = [];
  for (const list of byViewer.values()) {
    const kept: BackfillOpen[] = [];
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
      if (new Set(group.map(g => g.appId)).size >= 2) {
        bursts += group.length;
        all.push(...group.map(g => ({ ...g, throttled: true })));
      } else {
        kept.push(...group);
      }
      i = j;
    }
    const last = new Map<string, number>();
    for (const o of kept) {
      const prev = last.get(o.appId);
      if (prev !== undefined && o.at.getTime() - prev < DEDUPE_MS) {
        repeats++;
        all.push({ ...o, throttled: true });
        continue;
      }
      last.set(o.appId, o.at.getTime());
      counted.push(o);
      all.push(o);
    }
  }
  all.sort((a, b) => a.at.getTime() - b.at.getTime());
  counted.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { counted, all, bursts, repeats, bots };
}

export interface BackfillDailyRow {
  workspaceId: string;
  appId: string;
  /** A user id, `anon:`/`ph:` anonymous id, or null (indistinguishable). */
  userId: string | null;
  day: string;
  opens: number;
  sources: Partial<Record<AppUsageSource, number>>;
  firstAt: Date;
  lastAt: Date;
}

/** Counted opens → one rollup row per (workspace, app, viewer, day). */
export function dailyRowsOf(
  counted: ReadonlyArray<BackfillOpen>,
): BackfillDailyRow[] {
  const rows = new Map<string, BackfillDailyRow>();
  for (const o of counted) {
    const userId = o.userId ?? o.anonId;
    const day = utcDay(o.at);
    const k = `${o.workspaceId}|${o.appId}|${userId}|${day}`;
    let row = rows.get(k);
    if (!row) {
      row = {
        workspaceId: o.workspaceId,
        appId: o.appId,
        userId,
        day,
        opens: 0,
        sources: {},
        firstAt: o.at,
        lastAt: o.at,
      };
      rows.set(k, row);
    }
    row.opens++;
    row.sources[o.source] = (row.sources[o.source] ?? 0) + 1;
    if (o.at < row.firstAt) row.firstAt = o.at;
    if (o.at > row.lastAt) row.lastAt = o.at;
  }
  return [...rows.values()];
}

/** Daily rows → per-viewer rollups from `sinceDay` on, for the stats math. */
export function rollupsOf(
  rows: ReadonlyArray<BackfillDailyRow>,
  sinceDay: string,
): AppUsageRollup[] {
  const out = new Map<string, AppUsageRollup>();
  for (const row of rows) {
    if (row.day < sinceDay) continue;
    const k = `${row.appId}|${row.userId}`;
    const r = out.get(k) ?? {
      appId: row.appId,
      userId: row.userId,
      days: [],
      opens: 0,
      activeSeconds: 0,
      lastAt: row.lastAt,
    };
    if (!r.days.includes(row.day)) r.days.push(row.day);
    r.opens += row.opens;
    if (row.lastAt > r.lastAt) r.lastAt = row.lastAt;
    out.set(k, r);
  }
  return [...out.values()];
}

/** Idempotent rollup upserts: an existing row keeps the larger counts. */
export async function writeDailyRows(
  rows: ReadonlyArray<BackfillDailyRow>,
): Promise<number> {
  const ops = rows.map(row => ({
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
  return ops.length;
}

export function eventDocOf(open: BackfillOpen, backfill: BackfillSource) {
  return {
    workspaceId: new Types.ObjectId(open.workspaceId),
    appId: open.appId,
    at: open.at,
    kind: "open" as const,
    source: open.source,
    userId: open.userId,
    anonId: open.userId ? null : open.anonId,
    sessionId: open.sessionId ?? null,
    ...(open.referrerKind ? { referrerKind: open.referrerKind } : {}),
    uaClass: open.uaClass,
    ...(open.throttled ? { throttled: true } : {}),
    backfill,
  };
}

/**
 * Replace this source's backfilled events in [since, before) with `opens`,
 * so a re-run is idempotent. Live events and other sources are untouched.
 */
export async function replaceBackfillEvents(
  backfill: BackfillSource,
  opens: ReadonlyArray<BackfillOpen>,
  window: { workspaceIds: string[]; since: Date; before: Date },
): Promise<{ removed: number; inserted: number }> {
  const removed = await AppUsageEvent.deleteMany({
    backfill,
    workspaceId: { $in: window.workspaceIds.map(id => new Types.ObjectId(id)) },
    at: { $gte: window.since, $lt: window.before },
  });
  const docs = opens
    .filter(o => o.at >= window.since && o.at < window.before)
    .map(o => eventDocOf(o, backfill));
  for (let i = 0; i < docs.length; i += 1000) {
    await AppUsageEvent.insertMany(docs.slice(i, i + 1000), { ordered: false });
  }
  return { removed: removed.deletedCount, inserted: docs.length };
}

// ---------------------------------------------------------------------------
// Context: the index, refs → ids, authors
// ---------------------------------------------------------------------------

export interface BackfillIndexRow {
  workspaceId: string;
  appId: string;
  path: string;
  slug: string;
  ownerId?: string | null;
}

/**
 * Resolve an app reference as the routes do — id, repo path, or a slug
 * that is unique in its workspace — within one workspace's index rows.
 * `renames` (old folder → current) catches a slug or path that has moved
 * since. An id the index no longer lists (a deleted app) is kept as is.
 */
export function resolveAppRefIn(
  rows: ReadonlyArray<BackfillIndexRow>,
  ref: string,
  renames: ReadonlyMap<string, string> = new Map(),
): string | null {
  const clean = ref.replace(/^\/+|\/+$/g, "");
  if (!clean) return null;
  const byPath = (p: string) => rows.find(r => r.path === p);
  const hit =
    rows.find(r => r.appId === clean.toLowerCase()) ??
    byPath(clean) ??
    byPath(`apps/${clean}`) ??
    (rows.filter(r => r.slug === clean).length === 1
      ? rows.find(r => r.slug === clean)
      : undefined);
  if (hit) return hit.appId;
  for (const old of [clean, `apps/${clean}`]) {
    const moved = renames.get(old);
    if (moved && byPath(moved)) {
      return (byPath(moved) as BackfillIndexRow).appId;
    }
  }
  if (/^[0-9a-f]{24}$/i.test(clean)) return clean.toLowerCase();
  return null;
}

/** Each app's authors, as getAppAuthors computes them, from given inputs. */
export function backfillAuthors(input: {
  index: ReadonlyArray<BackfillIndexRow>;
  projects: ReadonlyArray<{
    _id: { toString(): string };
    owner_id?: string | null;
    createdBy?: string | null;
  }>;
  /** Commit authors per app (user ids), e.g. from parseCommitAuthors. */
  committers?: ReadonlyMap<string, ReadonlySet<string>>;
}): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (appId: string, id: string | null | undefined) => {
    if (!id) return;
    const set = out.get(appId) ?? new Set<string>();
    set.add(id);
    out.set(appId, set);
  };
  for (const [appId, ids] of input.committers ?? []) {
    for (const id of ids) add(appId, id);
  }
  for (const r of input.index) add(r.appId, r.ownerId);
  for (const p of input.projects) {
    add(p._id.toString(), p.owner_id);
    add(p._id.toString(), p.createdBy);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolving historical app references
// ---------------------------------------------------------------------------

/**
 * v1 app id → the folder its migration commit created, from
 * `git log --all --format=%x00%s --name-only --grep="Migrate v1 app"`.
 * Subjects read `Migrate v1 app "<title>" (<v1 id>)`; the log is newest
 * first, so a v1 app migrated several times maps to its latest folder.
 */
export function parseV1Migrations(log: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of log.split("\0")) {
    const lines = chunk.split("\n").map(l => l.trim());
    const id = /\(([0-9a-f]{24})\)\s*$/.exec(lines[0] ?? "")?.[1];
    if (!id || out.has(id)) continue;
    for (const file of lines.slice(1)) {
      const m = /^((?:apps|users\/[^/]+\/apps)\/[^/]+)\//.exec(file);
      if (m) {
        out.set(id, m[1]);
        break;
      }
    }
  }
  return out;
}

/**
 * Folder renames on main, old → current, from
 * `git log --format=%x00%H -M --name-status --diff-filter=R -- apps users`:
 * a renamed `<dir>/mako.json` is the app moving. Chains are followed, so a
 * folder moved twice maps to where it is now.
 */
export function parseAppRenames(log: string): Map<string, string> {
  // Newest first: the first rename seen for a path is its latest.
  const step = new Map<string, string>();
  for (const line of log.split("\n")) {
    const m = /^R\d*\t(.+)\/mako\.json\t(.+)\/mako\.json$/.exec(line.trim());
    if (m && !step.has(m[1])) step.set(m[1], m[2]);
  }
  const out = new Map<string, string>();
  for (const from of step.keys()) {
    let to = from;
    const seen = new Set<string>();
    while (step.has(to) && !seen.has(to)) {
      seen.add(to);
      to = step.get(to) as string;
    }
    out.set(from, to);
  }
  return out;
}
