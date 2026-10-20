/**
 * The Apps home feed — pure rules: which apps go on the Popular and New
 * shelves, how every other app is ranked in the Recommended grid, and the
 * cursor that pages through it. No I/O here (app-feed.service loads the
 * inputs and keeps the snapshots), so the formula can be iterated on and
 * unit-tested without a database, and without touching the client.
 *
 * The page shows every app the viewer can see exactly once: the two shelves
 * first, then the Recommended grid over everything else, in the order
 * rankRecommended decides.
 */
import type { DiscoveryApp } from "./app-discovery.service";
import type { AppUsageRollup } from "./app-usage.service";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Shelves
// ---------------------------------------------------------------------------

/** Cards on each shelf (one horizontally scrolling row). */
export const SHELF_SIZE = 10;
/** "New" means first committed within this many days. */
export const NEW_SHELF_DAYS = 7;

/**
 * Popular: the highest popularity scores (only apps someone besides an
 * author opened). New: first committed in the last NEW_SHELF_DAYS, newest
 * first, minus anything already on Popular — so the shelves never repeat
 * an app either.
 */
export function pickShelves(
  apps: ReadonlyArray<Pick<DiscoveryApp, "id" | "title" | "createdAt">>,
  popularity: ReadonlyMap<string, number>,
  now: Date,
  size = SHELF_SIZE,
): { popular: string[]; fresh: string[] } {
  const popular = apps
    .filter(a => (popularity.get(a.id) ?? 0) > 0)
    .sort(
      (a, b) =>
        (popularity.get(b.id) ?? 0) - (popularity.get(a.id) ?? 0) ||
        a.title.localeCompare(b.title) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, size)
    .map(a => a.id);
  const taken = new Set(popular);
  const since = now.getTime() - NEW_SHELF_DAYS * DAY_MS;
  const fresh = apps
    .filter(a => !taken.has(a.id))
    .map(a => ({ a, at: a.createdAt ? Date.parse(a.createdAt) : NaN }))
    .filter(({ at }) => Number.isFinite(at) && at >= since)
    .sort((x, y) => y.at - x.at || x.a.id.localeCompare(y.a.id))
    .slice(0, size)
    .map(({ a }) => a.id);
  return { popular, fresh };
}

// ---------------------------------------------------------------------------
// Recommended
// ---------------------------------------------------------------------------

/**
 * Every weight in the formula, named. A term's contribution is its weight
 * times a signal normalised to [0, 1] (penalties are negative weights), so
 * the weights read as "how much this matters relative to being the most
 * popular app" (popularity = 1).
 */
export const FEED_WEIGHTS = {
  /** log-damped popularity (non-author viewer-days, 14-day half-life). */
  popularity: 1.0,
  /** Freshness of the last publish (else creation), 21-day half-life. */
  recency: 0.4,
  /** Linear boost for apps first committed in the last NEW_BOOST_DAYS. */
  newBoost: 0.4,
  /** I keep coming back to it: saturates at RETURN_SATURATION_DAYS. */
  myReturns: 0.35,
  /** I opened it in the last JUST_SEEN_HOURS: show me something else. */
  justSeen: -0.9,
  /** Share of its tables that apps I use also read. */
  sharedTables: 0.45,
  /** It sits in a (non-root) folder with an app I use. */
  sameFolder: 0.2,
  /** Someone whose apps I use made it (not me). */
  sameOwner: 0.2,
  /** Used by people who use the same apps as me (cosine overlap). */
  coUsage: 0.6,
  /** Ships its own raster thumbnail (png/webp/jpg). */
  customThumbnail: 0.25,
  /** Ships only the starter's generated thumbnail.svg. */
  placeholderThumbnail: 0.05,
  /** Has a description in mako.json. */
  description: 0.1,
  /** Curated by an admin. */
  verified: 0.25,
  /** Last deploy failed, or a data refresh is failing. */
  unhealthy: -0.3,
  /** Never published: opening it shows the editor, not an app. */
  unpublished: -0.4,
  /** Deterministic per-viewer-per-day jitter, so the long tail gets seen. */
  exploration: 0.2,
} as const;

export const RECENCY_HALF_LIFE_DAYS = 21;
export const NEW_BOOST_DAYS = 14;
export const RETURN_SATURATION_DAYS = 10;
export const JUST_SEEN_HOURS = 24;

export type FeedTerm = keyof typeof FEED_WEIGHTS;

/** What the ranking reads about one app (a DiscoveryApp has all of it). */
export type FeedApp = Pick<
  DiscoveryApp,
  | "id"
  | "path"
  | "title"
  | "description"
  | "ownerId"
  | "authorEmail"
  | "createdAt"
  | "publishedAt"
  | "publishedSha"
  | "verified"
  | "thumbnail"
  | "tables"
  | "health"
>;

export interface FeedSignals {
  /** appId → popularity score (app-usage.service computeAppUsageStats). */
  popularity: ReadonlyMap<string, number>;
  /** appId → the viewer's own use over the affinity window. */
  mine: ReadonlyMap<string, { days: number; lastAt: string }>;
  /** appId → co-usage score (coUsageScores); unnormalised. */
  coUsage: ReadonlyMap<string, number>;
}

export interface FeedViewer {
  id?: string;
  email?: string;
}

export interface RankedApp {
  id: string;
  score: number;
  /** Each non-zero term's contribution (weight × signal), for tests/tuning. */
  terms: Partial<Record<FeedTerm, number>>;
}

/** 32-bit FNV-1a → [0, 1). Stable across processes, no crypto needed. */
export function seededUnit(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x1_0000_0000;
}

/**
 * The folder an app is filed in, when it is a real grouping: `apps/Sales`
 * for `apps/Sales/pipeline`. The roots (`apps`, `users/<h>/apps`) hold
 * everything, so sharing them says nothing.
 */
export function folderOf(path: string): string | null {
  const parts = path.split("/");
  parts.pop();
  const folder = parts.join("/");
  if (!folder || folder === "apps" || /^users\/[^/]+\/apps$/.test(folder)) {
    return null;
  }
  return folder;
}

function ownerKey(app: FeedApp): string | null {
  if (app.ownerId) return `id:${app.ownerId}`;
  return app.authorEmail ? `email:${app.authorEmail.toLowerCase()}` : null;
}

function isViewers(app: FeedApp, viewer: FeedViewer): boolean {
  if (app.ownerId) return !!viewer.id && app.ownerId === viewer.id;
  return (
    !!viewer.email &&
    !!app.authorEmail &&
    app.authorEmail.toLowerCase() === viewer.email.toLowerCase()
  );
}

const bump = (m: Map<string, number>, k: string | null) => {
  if (k) m.set(k, (m.get(k) ?? 0) + 1);
};

/**
 * Rank apps for the Recommended grid, best first. Pass EVERY app the viewer
 * can see (the affinity profile is built from all of them, shelves
 * included); the caller drops the shelved ones afterwards.
 *
 * score = Σ weight × signal, with the signals:
 *
 * - popularity: log(1 + score) / log(1 + max score). The usage score is
 *   already "non-author viewer-days, each halved every 14 days"; the log
 *   keeps the one or two apps the whole company opens daily from flattening
 *   everything below them to zero.
 * - recency: 0.5^(age / 21 days) of the last publish (a deploy follows every
 *   push to main, so this is the last commit that shipped), else creation.
 * - newBoost: 1 → 0 over the first 14 days after the first commit.
 * - myReturns: log(1 + my active days) / log(1 + 10), over the last 90 days:
 *   an app I keep returning to is useful to me.
 * - justSeen: 1 when I opened it in the last 24 h, so the top of the feed
 *   is not what I just closed.
 * - sharedTables: of the warehouse tables its bindings read, the share that
 *   some OTHER app I use also reads.
 * - sameFolder / sameOwner: 1 when another app I use sits in the same real
 *   folder / was made by the same person (never me — that's the Mine chip).
 * - coUsage: the app's co-usage score over the best one's — "people who use
 *   what you use also use this" (coUsageScores).
 * - quality: custom (raster) thumbnail, the starter's svg placeholder,
 *   a description, verified; failing deploy/refresh and never-published
 *   count against it.
 * - exploration: seededUnit(viewer, UTC day, app) — a small shuffle that is
 *   the same all day for one person, different for the next person or day.
 *
 * Ties (equal scores) break on title, then id, so the order is total.
 */
export function rankRecommended(
  apps: ReadonlyArray<FeedApp>,
  signals: FeedSignals,
  viewer: FeedViewer,
  now: Date,
): RankedApp[] {
  const W = FEED_WEIGHTS;
  const nowMs = now.getTime();
  const day = now.toISOString().slice(0, 10);
  const seedKey = viewer.id ?? viewer.email ?? "anonymous";

  let maxPopularity = 0;
  for (const a of apps) {
    maxPopularity = Math.max(maxPopularity, signals.popularity.get(a.id) ?? 0);
  }
  let maxCo = 0;
  for (const a of apps) maxCo = Math.max(maxCo, signals.coUsage.get(a.id) ?? 0);

  // The profile of what I use: counts of my apps per table, folder, owner,
  // so an app's own contribution can be subtracted from its match.
  const myTables = new Map<string, number>();
  const myFolders = new Map<string, number>();
  const myOwners = new Map<string, number>();
  for (const a of apps) {
    if (!signals.mine.has(a.id)) continue;
    for (const t of new Set(a.tables)) bump(myTables, t);
    bump(myFolders, folderOf(a.path));
    if (!isViewers(a, viewer)) bump(myOwners, ownerKey(a));
  }

  const ranked = apps.map(app => {
    const terms: Partial<Record<FeedTerm, number>> = {};
    const add = (term: FeedTerm, signal: number) => {
      if (signal) terms[term] = W[term] * signal;
    };
    const mine = signals.mine.get(app.id);
    const self = mine ? 1 : 0;

    const pop = signals.popularity.get(app.id) ?? 0;
    if (maxPopularity > 0 && pop > 0) {
      add("popularity", Math.log1p(pop) / Math.log1p(maxPopularity));
    }

    const created = app.createdAt ? Date.parse(app.createdAt) : NaN;
    const published = app.publishedAt ? Date.parse(app.publishedAt) : NaN;
    const lastShip = Number.isFinite(published) ? published : created;
    if (Number.isFinite(lastShip)) {
      const ageDays = Math.max(0, (nowMs - lastShip) / DAY_MS);
      add("recency", 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS));
    }
    if (Number.isFinite(created)) {
      const ageDays = Math.max(0, (nowMs - created) / DAY_MS);
      if (ageDays < NEW_BOOST_DAYS) {
        add("newBoost", 1 - ageDays / NEW_BOOST_DAYS);
      }
    }

    if (mine) {
      add(
        "myReturns",
        Math.min(1, Math.log1p(mine.days) / Math.log1p(RETURN_SATURATION_DAYS)),
      );
      const last = Date.parse(mine.lastAt);
      if (
        Number.isFinite(last) &&
        nowMs - last < JUST_SEEN_HOURS * 60 * 60 * 1000
      ) {
        add("justSeen", 1);
      }
    }

    const tables = [...new Set(app.tables)];
    if (tables.length > 0) {
      const shared = tables.filter(t => (myTables.get(t) ?? 0) - self > 0);
      add("sharedTables", shared.length / tables.length);
    }
    const folder = folderOf(app.path);
    if (folder && (myFolders.get(folder) ?? 0) - self > 0) add("sameFolder", 1);
    const owner = ownerKey(app);
    if (owner && !isViewers(app, viewer)) {
      if ((myOwners.get(owner) ?? 0) - self > 0) add("sameOwner", 1);
    }
    const co = signals.coUsage.get(app.id) ?? 0;
    if (maxCo > 0 && co > 0) add("coUsage", co / maxCo);

    if (app.thumbnail) {
      add(
        /\.svg$/i.test(app.thumbnail.file)
          ? "placeholderThumbnail"
          : "customThumbnail",
        1,
      );
    }
    if (app.description?.trim()) add("description", 1);
    if (app.verified) add("verified", 1);
    if (app.health.deployError || app.health.bindingErrors.length > 0) {
      add("unhealthy", 1);
    }
    if (!app.publishedSha && !app.publishedAt) add("unpublished", 1);

    add("exploration", seededUnit(`${seedKey}:${day}:${app.id}`));

    let score = 0;
    for (const v of Object.values(terms)) score += v ?? 0;
    return { id: app.id, title: app.title, score, terms };
  });

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id),
  );
  return ranked.map(({ id, score, terms }) => ({
    id,
    score: Math.round(score * 1e4) / 1e4,
    terms,
  }));
}

/**
 * "People who use what you use also use": for every other signed-in viewer,
 * their similarity to `viewerId` is the cosine overlap of the two sets of
 * apps used (|A∩B| / √(|A|·|B|)); an app's score is the sum of the
 * similarities of the people who used it. Apps the viewer already uses
 * score 0 — this term is for discovering, myReturns covers the rest.
 * Anonymous viewers (share links) are not people in the workspace.
 */
export function coUsageScores(
  rollups: ReadonlyArray<Pick<AppUsageRollup, "appId" | "userId">>,
  viewerId: string | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!viewerId) return out;
  const appsByUser = new Map<string, Set<string>>();
  for (const r of rollups) {
    if (
      !r.userId ||
      r.userId.startsWith("anon:") ||
      r.userId.startsWith("ph:")
    ) {
      continue;
    }
    let set = appsByUser.get(r.userId);
    if (!set) appsByUser.set(r.userId, (set = new Set()));
    set.add(r.appId);
  }
  const mine = appsByUser.get(viewerId);
  if (!mine || mine.size === 0) return out;
  for (const [userId, theirs] of appsByUser) {
    if (userId === viewerId) continue;
    let overlap = 0;
    for (const a of theirs) if (mine.has(a)) overlap++;
    if (overlap === 0) continue;
    const sim = overlap / Math.sqrt(mine.size * theirs.size);
    for (const a of theirs) {
      if (mine.has(a)) continue;
      out.set(a, (out.get(a) ?? 0) + sim);
    }
  }
  return out;
}

/** Everything the feed shows, in page order, each app once. */
export interface FeedOrder {
  popular: string[];
  fresh: string[];
  recommended: string[];
}

/** The shelves, then every other app ranked. A partition of `apps`. */
export function buildFeedOrder(
  apps: ReadonlyArray<FeedApp>,
  signals: FeedSignals,
  viewer: FeedViewer,
  now: Date,
): FeedOrder {
  const { popular, fresh } = pickShelves(apps, signals.popularity, now);
  const shelved = new Set([...popular, ...fresh]);
  const recommended = rankRecommended(apps, signals, viewer, now)
    .map(r => r.id)
    .filter(id => !shelved.has(id));
  return { popular, fresh, recommended };
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/**
 * A page cursor: the snapshot of the ranked order the first page froze
 * (app-feed.service keeps it) and the offset into its Recommended list.
 * Opaque to the client.
 */
export interface FeedCursor {
  snapshotId: string;
  offset: number;
}

export function encodeFeedCursor(cursor: FeedCursor): string {
  return Buffer.from(
    JSON.stringify({ v: 1, s: cursor.snapshotId, o: cursor.offset }),
  ).toString("base64url");
}

/** null when the string is not a cursor this server wrote. */
export function decodeFeedCursor(raw: string): FeedCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      parsed?.v === 1 &&
      typeof parsed.s === "string" &&
      /^[0-9a-f]{24}$/.test(parsed.s) &&
      Number.isInteger(parsed.o) &&
      parsed.o >= 0
    ) {
      return { snapshotId: parsed.s, offset: parsed.o };
    }
  } catch {
    // fall through
  }
  return null;
}
