import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * Who looked at which app, rolled up per UTC day (app-usage.service). One row
 * per (workspace, app, viewer, day), bumped with `$inc` upserts, so a viewer
 * who keeps an app open all day is one row, not a row per heartbeat.
 * `userId` is a person's id, `anon:<hash>` for an anonymous share-link or
 * embed viewer carrying Mako's first-party anonymous cookie, or null for an
 * anonymous viewer nobody can tell apart (backfilled from logs, or a frame
 * whose cookie could not be set) — those collapse into one row per app per
 * day. `appId` is the app identity (manifest id), never its path, so a move
 * keeps the history.
 */
export interface IAppUsageDaily extends Document {
  workspaceId: Types.ObjectId;
  appId: string;
  userId: string | null;
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  opens: number;
  activeSeconds: number;
  /** Opens by where the app was opened. */
  sources: { app?: number; share?: number; embed?: number };
  firstAt: Date;
  lastAt: Date;
}

const AppUsageDailySchema = new Schema<IAppUsageDaily>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    appId: { type: String, required: true },
    userId: { type: String, default: null },
    day: { type: String, required: true },
    opens: { type: Number, default: 0 },
    activeSeconds: { type: Number, default: 0 },
    sources: {
      type: new Schema(
        { app: Number, share: Number, embed: Number },
        { _id: false },
      ),
      default: {},
    },
    firstAt: { type: Date, required: true },
    lastAt: { type: Date, required: true },
  },
  { collection: "app_usage_daily", versionKey: false },
);

AppUsageDailySchema.index(
  { workspaceId: 1, appId: 1, userId: 1, day: 1 },
  { unique: true },
);
// The window scan behind the popularity stats.
AppUsageDailySchema.index({ workspaceId: 1, day: 1 });
// "Recently viewed" for one person.
AppUsageDailySchema.index({ workspaceId: 1, userId: 1, lastAt: -1 });

export const AppUsageDaily = mongoose.model<IAppUsageDaily>(
  "AppUsageDaily",
  AppUsageDailySchema,
);

/** Rows of skill_usage_daily expire this long after their last bump. */
export const SKILL_USAGE_TTL_SECONDS = 400 * 24 * 60 * 60;

/**
 * Which skills get read, rolled up per UTC day (skill-usage.service). One row
 * per (workspace, scope, skill, source, day), bumped with `$inc` upserts, so
 * the collection grows with distinct skill-days, never with traffic. Counts
 * only: no user, no chat, no query text. `skill` is the folder name, so a
 * renamed skill starts a new history. Rows expire 400 days after their last
 * bump (the TTL index on `lastAt`).
 */
export interface ISkillUsageDaily extends Document {
  workspaceId: Types.ObjectId;
  scope: "workspace" | "system";
  skill: string;
  /** Who asked: the in-product agent, or a client over MCP. */
  source: "agent" | "mcp";
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  /** `load_skill` calls that returned the skill. */
  loads: number;
  /** `read_skill_resource` calls that returned one of its files. */
  resourceReads: number;
  /** Bodies returned by `get_relevant_skills` or `search_skills`. */
  relevantHits: number;
  firstAt: Date;
  lastAt: Date;
}

const SkillUsageDailySchema = new Schema<ISkillUsageDaily>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    scope: { type: String, enum: ["workspace", "system"], required: true },
    skill: { type: String, required: true },
    source: { type: String, enum: ["agent", "mcp"], required: true },
    day: { type: String, required: true },
    loads: { type: Number, default: 0 },
    resourceReads: { type: Number, default: 0 },
    relevantHits: { type: Number, default: 0 },
    firstAt: { type: Date, required: true },
    lastAt: { type: Date, required: true },
  },
  { collection: "skill_usage_daily", versionKey: false },
);

SkillUsageDailySchema.index(
  { workspaceId: 1, scope: 1, skill: 1, source: 1, day: 1 },
  { unique: true },
);
// The 30-day window scan behind `list_skills`.
SkillUsageDailySchema.index({ workspaceId: 1, day: 1 });
SkillUsageDailySchema.index(
  { lastAt: 1 },
  { expireAfterSeconds: SKILL_USAGE_TTL_SECONDS },
);

export const SkillUsageDaily = mongoose.model<ISkillUsageDaily>(
  "SkillUsageDaily",
  SkillUsageDailySchema,
);

/**
 * Every view event, append-only (app-usage.service): the raw log the daily
 * rollup above is derived from, kept so ranking can be re-derived from
 * scratch — "opened every day" vs "opened once by mistake" is a question
 * about events, not counters. Nothing is dropped here: a reload burst the
 * rollup's throttle refused is kept with `throttled: true`, a bot with
 * `uaClass: "bot"`. Expires after ~13 months.
 */
export type AppUsageUaClass = "desktop" | "mobile" | "bot" | "unknown";
export type AppUsageReferrerKind = "internal" | "external" | "direct";
export const APP_USAGE_PLACEMENT_SHELVES = [
  "popular",
  "new",
  "recommended",
  "recent",
  "mine",
  "attention",
  "search",
] as const;
export interface AppUsagePlacement {
  surface: "home";
  shelf: (typeof APP_USAGE_PLACEMENT_SHELVES)[number];
  position: number;
}

export interface IAppUsageEvent extends Document {
  workspaceId: Types.ObjectId;
  appId: string;
  at: Date;
  kind: "open" | "heartbeat";
  source: "app" | "share" | "embed";
  /** Signed-in viewer, else null. */
  userId: string | null;
  /** `anon:<hash>` of the first-party anonymous cookie, else null. */
  anonId: string | null;
  /** One per view: an open and its heartbeats share it. */
  sessionId: string | null;
  referrerKind?: AppUsageReferrerKind | null;
  uaClass: AppUsageUaClass;
  /** Refused by the rollup's throttle (a reload burst, a double mount). */
  throttled?: boolean;
  /**
   * Where in Mako the view was opened from, when it was a card on the Apps
   * home: the shelf or grid, and the card's 0-based position in it — so
   * click-through per position can be computed from this log later.
   */
  placement?: AppUsagePlacement;
  /**
   * Reconstructed from history rather than recorded live: `cloud-run`
   * (request logs) or `posthog` (page views), by a one-off backfill of
   * Mako's hosted workspaces in October 2026.
   */
  backfill?: "cloud-run" | "posthog";
}

/** ~13 months: a year of history plus a month to compare it with. */
export const APP_USAGE_EVENT_TTL_SECONDS = 400 * 24 * 60 * 60;

const AppUsageEventSchema = new Schema<IAppUsageEvent>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    appId: { type: String, required: true },
    at: { type: Date, required: true },
    kind: { type: String, enum: ["open", "heartbeat"], required: true },
    source: { type: String, enum: ["app", "share", "embed"], required: true },
    userId: { type: String, default: null },
    anonId: { type: String, default: null },
    sessionId: { type: String, default: null },
    referrerKind: { type: String, enum: ["internal", "external", "direct"] },
    uaClass: {
      type: String,
      enum: ["desktop", "mobile", "bot", "unknown"],
      required: true,
    },
    throttled: { type: Boolean },
    placement: {
      type: new Schema(
        {
          surface: { type: String, enum: ["home"] },
          shelf: { type: String, enum: APP_USAGE_PLACEMENT_SHELVES },
          position: Number,
        },
        { _id: false },
      ),
      default: undefined,
    },
    backfill: { type: String, enum: ["cloud-run", "posthog"] },
  },
  { collection: "app_usage_events", versionKey: false },
);

AppUsageEventSchema.index({ workspaceId: 1, appId: 1, at: 1 });
AppUsageEventSchema.index({ workspaceId: 1, userId: 1, at: 1 });
AppUsageEventSchema.index(
  { at: 1 },
  { expireAfterSeconds: APP_USAGE_EVENT_TTL_SECONDS },
);

export const AppUsageEvent = mongoose.model<IAppUsageEvent>(
  "AppUsageEvent",
  AppUsageEventSchema,
);

/**
 * One person's Apps home feed, frozen when its first page was served
 * (app-feed.service): the Recommended order, so scrolling never repeats or
 * skips an app however usage moves underneath. The cursor names the
 * snapshot; pages re-check visibility on read. Expires after a day.
 */
export interface IAppFeedSnapshot extends Document {
  workspaceId: Types.ObjectId;
  /** The viewer it was ranked for; null for a caller without a user. */
  userId: string | null;
  popular: string[];
  fresh: string[];
  recommended: string[];
  createdAt: Date;
}

export const APP_FEED_SNAPSHOT_TTL_SECONDS = 24 * 60 * 60;

const AppFeedSnapshotSchema = new Schema<IAppFeedSnapshot>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    userId: { type: String, default: null },
    popular: { type: [String], default: [] },
    fresh: { type: [String], default: [] },
    recommended: { type: [String], default: [] },
    createdAt: { type: Date, required: true },
  },
  { collection: "app_feed_snapshots", versionKey: false },
);

AppFeedSnapshotSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: APP_FEED_SNAPSHOT_TTL_SECONDS },
);

export const AppFeedSnapshot = mongoose.model<IAppFeedSnapshot>(
  "AppFeedSnapshot",
  AppFeedSnapshotSchema,
);
