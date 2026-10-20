/**
 * What app search needs beyond ranking (app-search.ts): the tables each
 * app's bindings read, and how much each app is used (app-usage.service).
 *
 * The tables are indexed with the app (app-index.service reads every
 * `bindings/*.sql` once per push and runs extractTables over it), so a
 * search never opens the repo. Both the `search_apps` agent tool and
 * GET /apps/search rank through here and app-search.ts — one search.
 */
import { loggers } from "../logging";
import type { AppsIndexSnapshot } from "./app-index.service";
import { getAppUsageStats } from "./app-usage.service";

const logger = loggers.api("app-search");

/** App path → the tables its bindings read, at the snapshot's commit. */
export function bindingTablesByApp(
  snapshot: AppsIndexSnapshot,
): Map<string, string[]> {
  return new Map(snapshot.apps.map(a => [a.path, a.tables ?? []]));
}

/** appId → popularity score (app-usage.service), or null when unavailable. */
export async function appUsageScores(
  workspaceId: string,
): Promise<Map<string, number> | null> {
  try {
    const stats = await getAppUsageStats(workspaceId, { days: 28 });
    return new Map([...stats].map(([id, s]) => [id, s.score]));
  } catch (error) {
    logger.warn("App usage unavailable for search", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
