/**
 * What app search needs beyond the index rows: the tables each app's
 * bindings read (from `bindings/*.sql` at main) and how much each app is
 * used (app-usage.service). Ranking itself is app-search.ts.
 */
import { loggers } from "../logging";
import {
  discoverApps,
  listAppTrees,
  type AppsIndexSnapshot,
} from "./app-index.service";
import { extractTables } from "./app-search";
import { getAppUsageStats } from "./app-usage.service";
import { readBlobsBatch } from "./repository.service";
import { boundRepoDirIfExists } from "./workspace-repo-required";

const logger = loggers.api("app-search");

/** Per workspace: main's sha → app path → tables. Bindings only change on push. */
const tablesCache = new Map<
  string,
  { sha: string; tables: Map<string, string[]> }
>();

/** App path → the tables its bindings read, at the snapshot's commit. */
export async function bindingTablesByApp(
  workspaceId: string,
  snapshot: AppsIndexSnapshot,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!snapshot.sha) return out;
  const hit = tablesCache.get(workspaceId);
  if (hit?.sha === snapshot.sha) return hit.tables;
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return out;
  try {
    const discovery = discoverApps(await listAppTrees(repoDir, snapshot.sha));
    const paths: string[] = [];
    for (const app of discovery.apps) {
      for (const name of app.bindingBlobs.keys()) {
        paths.push(`${app.path}/bindings/${name}.sql`);
      }
    }
    const blobs = await readBlobsBatch(repoDir, snapshot.sha, paths);
    for (const app of discovery.apps) {
      const tables = new Set<string>();
      for (const name of app.bindingBlobs.keys()) {
        const blob = blobs.get(`${app.path}/bindings/${name}.sql`);
        if (blob) {
          for (const t of extractTables(blob.toString("utf8"))) tables.add(t);
        }
      }
      out.set(app.path, [...tables].sort());
    }
    tablesCache.set(workspaceId, { sha: snapshot.sha, tables: out });
  } catch (error) {
    // Search still works on titles and descriptions without the tables.
    logger.warn("Could not read binding tables for app search", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return out;
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
