/**
 * The Apps home feed — GET /apps/feed. The first page ranks every app the
 * viewer can see (app-feed.ts), freezes the order in a snapshot, and
 * returns the Popular and New shelves plus the first Recommended page; each
 * later page is a slice of that frozen order. So scrolling never repeats or
 * skips an app, whatever happens to usage meanwhile (opening an app from
 * the feed changes this very person's signals).
 *
 * Visibility is re-checked on every page: cards are hydrated from the
 * current listDiscoveryApps (canSeeIndexedApp), so an app made private
 * after the snapshot was taken drops out instead of leaking, and a
 * snapshot is only ever read back by the workspace and person it was
 * ranked for.
 */
import { Types } from "mongoose";
import { AppFeedSnapshot } from "../database/workspace-schema";
import { User } from "../database/schema";
import { loggers } from "../logging";
import { listDiscoveryApps, type DiscoveryApp } from "./app-discovery.service";
import {
  buildFeedOrder,
  coUsageScores,
  decodeFeedCursor,
  encodeFeedCursor,
  type FeedOrder,
  type FeedSignals,
  type FeedViewer,
} from "./app-feed";
import {
  computeAppUsageStats,
  DEFAULT_USAGE_WINDOW_DAYS,
  getAppAuthors,
  loadUsageRollups,
  utcDay,
} from "./app-usage.service";

const logger = loggers.api("apps-feed");

const DAY_MS = 24 * 60 * 60 * 1000;
/** My reads and co-usage look this far back; popularity stays at 28 days. */
export const AFFINITY_WINDOW_DAYS = 90;
export const FEED_PAGE_DEFAULT = 24;
export const FEED_PAGE_MAX = 60;

export class FeedCursorError extends Error {
  constructor(
    message: string,
    /** 400: not a cursor of this person's; 410: its snapshot expired. */
    readonly status: 400 | 410,
  ) {
    super(message);
  }
}

export interface StoredFeedSnapshot extends FeedOrder {
  workspaceId: string;
  userId: string | null;
}

export interface FeedDeps {
  listApps: (
    workspaceId: string,
    userId: string | undefined,
    role: string | undefined,
  ) => Promise<DiscoveryApp[]>;
  loadViewer: (userId: string | undefined) => Promise<FeedViewer>;
  loadSignals: (
    workspaceId: string,
    viewer: FeedViewer,
    now: Date,
  ) => Promise<FeedSignals>;
  saveSnapshot: (snapshot: StoredFeedSnapshot, now: Date) => Promise<string>;
  loadSnapshot: (id: string) => Promise<StoredFeedSnapshot | null>;
}

export interface FeedPage {
  /** First page only: the shelves, in order. */
  popular?: DiscoveryApp[];
  fresh?: DiscoveryApp[];
  /** This page of the Recommended grid. */
  apps: DiscoveryApp[];
  /** Where this page starts in the Recommended order. */
  offset: number;
  /** null once the Recommended order is exhausted. */
  nextCursor: string | null;
  /** Apps in the snapshot: shelves + Recommended. */
  total: number;
  recommendedTotal: number;
}

const EMPTY_SIGNALS: FeedSignals = {
  popularity: new Map(),
  mine: new Map(),
  coUsage: new Map(),
};

/** Usage signals for one viewer, from the daily rollup. */
export async function loadFeedSignals(
  workspaceId: string,
  viewer: FeedViewer,
  now: Date,
): Promise<FeedSignals> {
  try {
    const since = utcDay(
      new Date(now.getTime() - (AFFINITY_WINDOW_DAYS - 1) * DAY_MS),
    );
    const popularSince = utcDay(
      new Date(now.getTime() - (DEFAULT_USAGE_WINDOW_DAYS - 1) * DAY_MS),
    );
    const [rollups, authors] = await Promise.all([
      loadUsageRollups(workspaceId, since),
      getAppAuthors(workspaceId),
    ]);
    // Popularity is the Popular shelf's score exactly: the 28-day window.
    const windowed = rollups
      .map(r => ({ ...r, days: r.days.filter(d => d >= popularSince) }))
      .filter(r => r.days.length > 0);
    const stats = computeAppUsageStats(windowed, authors, now);
    const mine = new Map<string, { days: number; lastAt: string }>();
    if (viewer.id) {
      for (const r of rollups) {
        if (r.userId !== viewer.id) continue;
        mine.set(r.appId, {
          days: new Set(r.days).size,
          lastAt: new Date(r.lastAt).toISOString(),
        });
      }
    }
    return {
      popularity: new Map([...stats].map(([id, s]) => [id, s.score])),
      mine,
      coUsage: coUsageScores(rollups, viewer.id),
    };
  } catch (error) {
    // Ranking without usage still shows every app, by recency and quality.
    logger.warn("Feed usage signals unavailable", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_SIGNALS;
  }
}

export const defaultFeedDeps: FeedDeps = {
  listApps: listDiscoveryApps,
  loadViewer: async userId => {
    if (!userId || !Types.ObjectId.isValid(userId)) return { id: userId };
    const user = await User.findById(userId).select("email").lean();
    return { id: userId, email: user?.email ?? undefined };
  },
  loadSignals: loadFeedSignals,
  saveSnapshot: async (snapshot, now) => {
    const doc = await AppFeedSnapshot.create({
      workspaceId: new Types.ObjectId(snapshot.workspaceId),
      userId: snapshot.userId,
      popular: snapshot.popular,
      fresh: snapshot.fresh,
      recommended: snapshot.recommended,
      createdAt: now,
    });
    return doc._id.toString();
  },
  loadSnapshot: async id => {
    const doc = await AppFeedSnapshot.findById(id).lean();
    if (!doc) return null;
    return {
      workspaceId: doc.workspaceId.toString(),
      userId: doc.userId ?? null,
      popular: doc.popular ?? [],
      fresh: doc.fresh ?? [],
      recommended: doc.recommended ?? [],
    };
  },
};

/**
 * One page of the feed. Without a cursor: rank, snapshot, and return the
 * shelves with the first page. With one: the next slice of that snapshot.
 */
export async function getFeedPage(
  workspaceId: string,
  userId: string | undefined,
  role: string | undefined,
  options: { cursor?: string | null; limit?: number } = {},
  deps: FeedDeps = defaultFeedDeps,
  now: Date = new Date(),
): Promise<FeedPage> {
  const limit = Math.max(
    1,
    Math.min(options.limit ?? FEED_PAGE_DEFAULT, FEED_PAGE_MAX),
  );
  const visible = await deps.listApps(workspaceId, userId, role);
  const byId = new Map(visible.map(a => [a.id, a]));
  const hydrate = (ids: readonly string[]) =>
    ids.flatMap(id => {
      const app = byId.get(id);
      return app ? [app] : [];
    });

  let snapshotId: string;
  let order: FeedOrder;
  let offset: number;
  if (options.cursor) {
    const cursor = decodeFeedCursor(options.cursor);
    if (!cursor) throw new FeedCursorError("Invalid feed cursor", 400);
    const stored = await deps.loadSnapshot(cursor.snapshotId);
    if (!stored) {
      throw new FeedCursorError("The feed expired; reload it", 410);
    }
    // Someone else's snapshot is not readable, even by id: its order is a
    // read of their usage.
    if (
      stored.workspaceId !== workspaceId ||
      stored.userId !== (userId ?? null)
    ) {
      throw new FeedCursorError("Invalid feed cursor", 400);
    }
    snapshotId = cursor.snapshotId;
    order = stored;
    offset = cursor.offset;
  } else {
    const viewer = await deps.loadViewer(userId);
    const signals = await deps.loadSignals(workspaceId, viewer, now);
    order = buildFeedOrder(visible, signals, viewer, now);
    snapshotId = await deps.saveSnapshot(
      { workspaceId, userId: userId ?? null, ...order },
      now,
    );
    offset = 0;
  }

  const end = offset + limit;
  const page: FeedPage = {
    apps: hydrate(order.recommended.slice(offset, end)),
    offset,
    nextCursor:
      end < order.recommended.length
        ? encodeFeedCursor({ snapshotId, offset: end })
        : null,
    total: order.popular.length + order.fresh.length + order.recommended.length,
    recommendedTotal: order.recommended.length,
  };
  if (!options.cursor) {
    page.popular = hydrate(order.popular);
    page.fresh = hydrate(order.fresh);
  }
  return page;
}
