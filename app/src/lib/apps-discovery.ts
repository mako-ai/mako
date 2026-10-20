/**
 * Apps discovery — the pure rules behind the Apps home and the explorer's
 * Recently viewed / Popular sections: which apps go in which shelf, and
 * what counts as "needs attention". The store fetches; this decides.
 */
import { getApiBasePath } from "./api-base-path";

/**
 * Where a card's picture comes from: the thumbnail route, which redirects to
 * a signed bucket URL. The version busts the browser cache when a new
 * picture lands.
 */
export function appThumbnailUrl(
  workspaceId: string,
  app: Pick<DiscoveryApp, "id" | "thumbnailAt" | "publishedSha">,
): string {
  const base = getApiBasePath(import.meta.env.VITE_API_URL);
  const v = encodeURIComponent(app.thumbnailAt ?? app.publishedSha ?? "");
  return `${base}/workspaces/${workspaceId}/apps/${app.id}/thumbnail?v=${v}`;
}

/** The usage API's per-app stats (Lane A contract, app-usage.service). */
export interface AppUsageStats {
  appId: string;
  viewers: number;
  nonAuthorViewers: number;
  viewerDays: number;
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
  ownerEmail?: string;
  authorEmail?: string;
  createdAt?: string;
  publishedAt?: string;
  publishedSha?: string;
  verified: boolean;
  thumbnailAt: string | null;
  scheduled: boolean;
  tables: string[];
  dataRefreshedAt: string | null;
  health: {
    deployError?: { stage: string; at: string };
    bindingErrors: string[];
  };
}

export interface DiscoverySearchHit extends DiscoveryApp {
  score: number;
  matches: Array<"title" | "description" | "path" | "owner" | "tables">;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Data older than this on a scheduled app is stale (its schedule stalled). */
export const STALE_DATA_MS = 3 * DAY_MS;

/** Who an app belongs to, as a short human handle. */
export function ownerHandle(app: DiscoveryApp): string | null {
  const email = app.ownerEmail ?? app.authorEmail;
  return email ? email.split("@")[0] : null;
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
export function recentlyViewedApps(
  apps: readonly DiscoveryApp[] | ReadonlyMap<string, DiscoveryApp>,
  recent: readonly RecentAppView[],
  limit: number,
): DiscoveryApp[] {
  const byId =
    apps instanceof Map
      ? apps
      : new Map((apps as readonly DiscoveryApp[]).map(a => [a.id, a]));
  const out: DiscoveryApp[] = [];
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
