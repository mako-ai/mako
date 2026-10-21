/**
 * Command palette — apps as first-class results.
 *
 * Two sources, so typing feels immediate and still finds what titles do not
 * say: an instant client-side match over the already-loaded apps list
 * (title, description, folder, owner), and the server search
 * (GET /apps/search: the same fields plus the warehouse tables each app's
 * bindings read, ranked with usage). Until the server answers for the
 * current query the local ranking shows; then the server's order leads and
 * local-only hits follow. An empty query shows Recently viewed and Popular.
 */
import { focusAppsTab } from "../../apps-runtime/shell";
import { appUrlSlug } from "../../store/appsStore";
import { TAB_KIND_ICONS } from "../entity-icons";
import type { AppUsageStats } from "../apps-discovery";
import { scoreItem, type PaletteEntityItem } from "./types";

/** What the palette needs to know about an app. */
export interface PaletteApp {
  id: string;
  title: string;
  description?: string;
  path?: string;
  slug?: string;
  owner?: string;
  /** A server hit found by meaning, not words (matches: ["related"]). */
  related?: boolean;
}

/** Usage only breaks ties between comparable text matches. */
const usageBoost = (score: number | undefined) =>
  score && score > 0 ? Math.log1p(score) * 0.5 : 0;

/**
 * Rank loaded apps for a query, client-side: every query word must match the
 * title, description, folder path or owner (title hits count most — see
 * scoreItem), boosted a little by popularity.
 */
export function rankAppsLocally(
  apps: readonly PaletteApp[],
  query: string,
  usage: Readonly<Record<string, Pick<AppUsageStats, "score">>>,
  limit: number,
): PaletteApp[] {
  if (!query.trim()) return [];
  return apps
    .map(app => {
      const text = scoreItem(
        query,
        app.title,
        [app.description, app.path, app.owner].filter((k): k is string => !!k),
      );
      return {
        app,
        score: text > 0 ? text + usageBoost(usage[app.id]?.score) : 0,
      };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.app.title.localeCompare(b.app.title))
    .slice(0, limit)
    .map(x => x.app);
}

/**
 * The server's word matches first when it has answered THIS query, then any
 * local hit it did not return (a prefix the server's tokenizer skipped),
 * then the server's related apps (found by meaning, so weaker than any word
 * match); before it answers, the local ranking alone.
 */
export function mergeAppResults(
  local: readonly PaletteApp[],
  server: readonly PaletteApp[] | null,
  limit: number,
): PaletteApp[] {
  if (!server) return local.slice(0, limit);
  const seen = new Set(server.map(a => a.id));
  return [
    ...server.filter(a => !a.related),
    ...local.filter(a => !seen.has(a.id)),
    ...server.filter(a => a.related),
  ].slice(0, limit);
}

/** `apps/Sales/CH/report` → `Sales / CH` (the folder, not the app itself). */
export function folderLabel(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split("/").slice(0, -1);
  // Drop the tree root: `apps`, or `users/<handle>/apps`.
  const at = parts.lastIndexOf("apps");
  const rest = parts.slice(at + 1);
  if (rest.length > 0) return rest.join(" / ");
  return parts[0] === "users" ? "Personal" : undefined;
}

export function appPaletteItems(
  apps: readonly PaletteApp[],
  section: string,
): PaletteEntityItem[] {
  return apps.map(app => ({
    id: `app:${section}:${app.id}`,
    title: app.title,
    subtitle: [folderLabel(app.path), app.owner].filter(Boolean).join(" · "),
    section,
    icon: TAB_KIND_ICONS.app,
    run: () => {
      focusAppsTab(app.id, app.title, appUrlSlug(app));
    },
  }));
}
