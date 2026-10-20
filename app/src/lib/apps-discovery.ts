/**
 * Apps discovery — the pure rules behind the Apps home and the explorer's
 * Recently viewed / Popular sections: which apps go in which shelf, and
 * what counts as "needs attention". The store fetches; this decides.
 */
import { getApiBasePath } from "./api-base-path";

/**
 * Where a card's picture comes from: the app's own `thumbnail.*`, served by
 * the thumbnail route. Null when the app ships none (the card shows its
 * placeholder and makes no request). The blob oid versions the URL, so a
 * new picture is a new URL and the old one caches forever.
 */
export function appThumbnailUrl(
  workspaceId: string,
  app: Pick<DiscoveryApp, "id" | "thumbnail">,
): string | null {
  if (!app.thumbnail) return null;
  const base = getApiBasePath(import.meta.env.VITE_API_URL);
  return `${base}/workspaces/${workspaceId}/apps/${app.id}/thumbnail?v=${encodeURIComponent(app.thumbnail.oid)}`;
}

/**
 * A thumbnail URL asking for a card-sized WebP (`w`, snapped server-side to
 * 320/480/640/960/1200). The originals are 1200-wide posters of several
 * hundred KB; a card is ~300 px wide.
 */
export function thumbnailAtWidth(src: string, width: number): string {
  return `${src}${src.includes("?") ? "&" : "?"}w=${width}`;
}

/** `srcSet` for a thumbnail URL: 1×, 2× and 3× of a ~320 px card. */
export function thumbnailSrcSet(src: string): string {
  return [320, 640, 960]
    .map(w => `${thumbnailAtWidth(src, w)} ${w}w`)
    .join(", ");
}

/** The usage API's per-app stats (Lane A contract, app-usage.service). */
export interface AppUsageStats {
  appId: string;
  viewers: number;
  nonAuthorViewers: number;
  viewerDays: number;
  /** Visit-days by all signed-in viewers, authors included (the card). */
  allViewerDays?: number;
  /** Anonymous share-link / embed viewers with a first-party id. */
  anonViewers?: number;
  anonViewerDays?: number;
  opens: number;
  activeSeconds: number;
  lastOpenedAt: string | null;
  lastNonAuthorOpenedAt: string | null;
  score: number;
}

export interface RecentAppView {
  appId: string;
  lastOpenedAt: string;
}

/** One app as GET /apps/discovery describes it. */
export interface DiscoveryApp {
  id: string;
  slug: string;
  path: string;
  scope: "workspace" | "private";
  title: string;
  description?: string;
  access: "private" | "workspace";
  ownerId?: string;
  /** The owner's workspace handle (`users/<handle>/`), when they have one. */
  ownerHandle?: string;
  ownerEmail?: string;
  authorEmail?: string;
  /**
   * The owner as a person (the server resolves the author email to a
   * workspace member): what cards and search show. No `userId` = nobody
   * in the workspace; `name` is then the email's local part.
   */
  owner?: { userId?: string; name: string; handle?: string; email?: string };
  createdAt?: string;
  publishedAt?: string;
  publishedSha?: string;
  verified: boolean;
  /** The app's own `thumbnail.*` (file, blob oid); null = placeholder. */
  thumbnail: { file: string; oid: string } | null;
  scheduled: boolean;
  tables: string[];
  dataRefreshedAt: string | null;
  health: {
    deployError?: { stage: string; at: string };
    bindingErrors: string[];
  };
}

/**
 * A card's worth of facts from the explorer's app list (the persisted
 * `apps-store` cache), for painting the Apps home before /discovery
 * answers: title, folder, dates; no picture (the placeholder), no health.
 * The real card replaces it in place, keyed by the same id.
 */
export function discoveryFromMeta(meta: {
  id: string;
  title: string;
  slug?: string;
  path?: string;
  scope?: "workspace" | "private";
  description?: string;
  access?: "private" | "workspace";
  owner_id?: string;
  createdAt?: string;
  publishedAt?: string;
  publishedSha?: string;
  verified?: boolean;
}): DiscoveryApp {
  const path = meta.path ?? `apps/${meta.slug ?? meta.id}`;
  return {
    id: meta.id,
    slug: meta.slug ?? path.split("/").pop() ?? meta.id,
    path,
    scope: meta.scope ?? "workspace",
    title: meta.title,
    ...(meta.description ? { description: meta.description } : {}),
    access: meta.access ?? "workspace",
    ...(meta.owner_id ? { ownerId: meta.owner_id } : {}),
    ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
    ...(meta.publishedAt ? { publishedAt: meta.publishedAt } : {}),
    ...(meta.publishedSha ? { publishedSha: meta.publishedSha } : {}),
    verified: meta.verified === true,
    thumbnail: null,
    scheduled: false,
    tables: [],
    dataRefreshedAt: null,
    health: { bindingErrors: [] },
  };
}

/**
 * Until the server's feed answers: Popular and New from what is already
 * known, then everything else by popularity and title — the same shelves the
 * feed will fill, so the swap moves as little as possible.
 */
export function provisionalFeed(
  apps: readonly DiscoveryApp[],
  usage: Readonly<Record<string, AppUsageStats>>,
  limits: { shelf: number; page: number },
  now = Date.now(),
): {
  popular: DiscoveryApp[];
  fresh: DiscoveryApp[];
  items: DiscoveryApp[];
} {
  const popular = popularApps(apps, usage, limits.shelf);
  const taken = new Set(popular.map(a => a.id));
  const fresh = newApps(
    apps.filter(a => !taken.has(a.id)),
    7,
    now,
  ).slice(0, limits.shelf);
  for (const a of fresh) taken.add(a.id);
  const items = apps
    .filter(a => !taken.has(a.id))
    .sort(
      (a, b) =>
        (usage[b.id]?.score ?? 0) - (usage[a.id]?.score ?? 0) ||
        a.title.localeCompare(b.title),
    )
    .slice(0, limits.page);
  return { popular, fresh, items };
}

/**
 * When the ranked feed replaces the provisional one, the cards a person is
 * already looking at should not jump: those of `onScreen` that the new
 * list also has keep their previous order at its front; everything else
 * follows in the new order. Same set, same length — only the order moves.
 */
export function keepOnScreen<T extends { id: string }>(
  onScreen: readonly string[],
  items: readonly T[],
): T[] {
  if (onScreen.length === 0) return [...items];
  const byId = new Map(items.map(a => [a.id, a]));
  const first: T[] = [];
  for (const id of onScreen) {
    const hit = byId.get(id);
    if (hit) {
      first.push(hit);
      byId.delete(id);
    }
  }
  return [...first, ...items.filter(a => byId.has(a.id))];
}

/**
 * Upgrade cached cards with fresher ones (same id), keeping the cache's
 * order and membership — so a feed page that lands before /discovery puts
 * its posters and owners into the persisted listing for the next visit.
 */
export function upgradeCards(
  cached: readonly DiscoveryApp[],
  fresh: readonly DiscoveryApp[],
): DiscoveryApp[] {
  if (cached.length === 0 || fresh.length === 0) return [...cached];
  const byId = new Map(fresh.map(a => [a.id, a]));
  return cached.map(a => byId.get(a.id) ?? a);
}

export interface DiscoverySearchHit extends DiscoveryApp {
  score: number;
  /** Fields that matched: title, description, path, owner, tables. */
  matches: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Data older than this on a scheduled app is stale (its schedule stalled). */
export const STALE_DATA_MS = 3 * DAY_MS;

/** Who an app belongs to, as a short human label (the person's name). */
export function ownerHandle(
  app: Pick<
    DiscoveryApp,
    "owner" | "ownerHandle" | "ownerEmail" | "authorEmail"
  >,
): string | null {
  if (app.owner?.name) return app.owner.name;
  if (app.ownerHandle) return app.ownerHandle;
  const email = app.ownerEmail ?? app.authorEmail;
  // A GitHub noreply address's `<id>+` prefix is not a name.
  return email ? email.split("@")[0].replace(/^\d+\+/, "") : null;
}

/**
 * Is this the viewer's app? Its sharing owner, else (a folder-only app
 * nobody has claimed) whoever first committed it — matched by email, the
 * only identity git has.
 */
export function isMyApp(
  app: DiscoveryApp,
  me: { id?: string; email?: string },
): boolean {
  if (app.ownerId) return !!me.id && app.ownerId === me.id;
  // The server matched the author to a member (a laptop email, a GitHub
  // noreply address): that member's id is the answer.
  if (app.owner?.userId) return !!me.id && app.owner.userId === me.id;
  return (
    !!me.email &&
    !!app.authorEmail &&
    app.authorEmail.toLowerCase() === me.email.toLowerCase()
  );
}

export type AttentionReason =
  | { kind: "deploy"; stage: string }
  | { kind: "binding"; names: string[] }
  | { kind: "stale"; since: string | null };

/** Why an app needs its owner, if it does — the worst first. */
export function attentionReasons(
  app: DiscoveryApp,
  now = Date.now(),
): AttentionReason[] {
  const out: AttentionReason[] = [];
  if (app.health.deployError) {
    out.push({ kind: "deploy", stage: app.health.deployError.stage });
  }
  if (app.health.bindingErrors.length > 0) {
    out.push({ kind: "binding", names: app.health.bindingErrors });
  }
  if (app.scheduled && app.publishedSha) {
    const at = app.dataRefreshedAt ? Date.parse(app.dataRefreshedAt) : NaN;
    if (!Number.isFinite(at) || now - at > STALE_DATA_MS) {
      out.push({ kind: "stale", since: app.dataRefreshedAt });
    }
  }
  return out;
}

export function describeAttention(reason: AttentionReason): string {
  switch (reason.kind) {
    case "deploy":
      return reason.stage === "bindings"
        ? "Last deploy failed preparing data"
        : `Last deploy failed (${reason.stage})`;
    case "binding":
      return reason.names.length === 1
        ? `Data refresh failing: ${reason.names[0]}`
        : `${reason.names.length} data refreshes failing`;
    case "stale":
      return reason.since ? "Scheduled data is stale" : "Data never refreshed";
  }
}

/** Popular: by usage score, only apps someone besides the author opened. */
export function popularApps<T extends { id: string; title: string }>(
  apps: readonly T[],
  usage: Readonly<Record<string, AppUsageStats>>,
  limit: number,
): T[] {
  return apps
    .filter(a => (usage[a.id]?.score ?? 0) > 0)
    .sort(
      (a, b) =>
        (usage[b.id]?.score ?? 0) - (usage[a.id]?.score ?? 0) ||
        a.title.localeCompare(b.title),
    )
    .slice(0, limit);
}

/** New: first committed within `days`, newest first. */
export function newApps(
  apps: readonly DiscoveryApp[],
  days: number,
  now = Date.now(),
): DiscoveryApp[] {
  const since = now - days * DAY_MS;
  return apps
    .filter(a => {
      const at = a.createdAt ? Date.parse(a.createdAt) : NaN;
      return Number.isFinite(at) && at >= since;
    })
    .sort(
      (a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""),
    );
}

/** The viewer's recently viewed apps, in their order, dropping vanished ones. */
export function recentlyViewedApps<T extends { id: string }>(
  apps: readonly T[],
  recent: readonly RecentAppView[],
  limit: number,
): T[] {
  const byId = new Map(apps.map(a => [a.id, a]));
  const out: T[] = [];
  for (const r of recent) {
    const app = byId.get(r.appId);
    if (app) out.push(app);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The placeholder a card shows without a screenshot: the title's initials
 * on a colour picked from the id, so the same app always looks the same.
 */
export function placeholderFor(app: Pick<DiscoveryApp, "id" | "title">): {
  initials: string;
  hue: number;
} {
  const words = app.title
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const initials =
    words.length >= 2
      ? `${words[0][0]}${words[1][0]}`
      : (words[0]?.slice(0, 2) ?? "?");
  let hash = 0;
  for (const ch of app.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { initials: initials.toUpperCase(), hue: hash % 360 };
}

/** "3 days ago", "just now" — coarse on purpose, for card meta lines. */
export function relativeTime(
  iso: string | null | undefined,
  now = Date.now(),
): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const diff = Math.max(0, now - at);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 12) return months === 1 ? "a month ago" : `${months} months ago`;
  const years = Math.round(months / 12);
  return years === 1 ? "a year ago" : `${years} years ago`;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * The card's usage figure: visit-days (person-days in the window), which
 * tells an app opened daily by a few people from one opened once by many —
 * a count of distinct viewers cannot. Authors' own visits are included
 * here (the popularity score excludes them) and the tooltip says so.
 * Anonymous share-link viewers go in the tooltip, not the figure.
 */
export function visitSummary(
  usage: AppUsageStats | undefined,
  windowDays = 28,
): { count: number; tooltip: string } | null {
  if (!usage) return null;
  const days = usage.allViewerDays ?? usage.viewerDays;
  const anon = usage.anonViewers ?? 0;
  if (days <= 0 && anon <= 0) return null;
  let tooltip = `${plural(days, "visit-day", "visit-days")} by ${plural(usage.viewers, "person", "people")} in the last ${windowDays} days, authors included`;
  if (anon > 0) {
    tooltip += ` (+${plural(anon, "anonymous viewer", "anonymous viewers")} via share links)`;
  }
  return { count: days, tooltip };
}
