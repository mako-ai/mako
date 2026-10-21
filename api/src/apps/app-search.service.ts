/**
 * What app search needs beyond ranking (app-search.ts): the tables each
 * app's bindings read, and how much each app is used (app-usage.service,
 * through the Apps home's memo — app-home-base.service).
 *
 * The tables are indexed with the app (app-index.service reads every
 * `bindings/*.sql` once per push and runs extractTables over it), so a
 * search never opens the repo. Both the `search_apps` agent tool and
 * GET /apps/search rank through here and app-search.ts — one search.
 *
 * Semantic matches (querySimilarity) come from app-embeddings.service: the
 * query's vector against each app's, in memory. Best-effort by design — no
 * key, a slow gateway or a failed call all mean the words alone rank.
 */
import { loggers } from "../logging";
import { getEmbeddingModelName } from "../services/embedding.service";
import {
  dot,
  embedSearchQuery,
  scheduleAppEmbeddings,
  workspaceAppVectors,
} from "./app-embeddings.service";
import { loadAppsIndex, type AppsIndexSnapshot } from "./app-index.service";
import type { RelatedSignals } from "./app-search";
import { homeUsageStats } from "./app-home-base.service";

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
    const stats = await homeUsageStats(workspaceId, { days: 28 });
    return new Map([...stats].map(([id, s]) => [id, s.score]));
  } catch (error) {
    logger.warn("App usage unavailable for search", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** How long a search waits for semantic matches before going lexical. */
export const SEMANTIC_TIMEOUT_MS = 1500;
/** A workspace with apps lacking a vector is backfilled at most this often. */
const BACKFILL_EVERY_MS = 10 * 60_000;
const backfillAt = new Map<string, number>();

/**
 * Embed what the search found without a vector, in the background: apps
 * from before semantic search, or whose last refresh failed.
 */
function backfillMissing(workspaceId: string): void {
  const last = backfillAt.get(workspaceId) ?? 0;
  if (Date.now() - last < BACKFILL_EVERY_MS) return;
  backfillAt.set(workspaceId, Date.now());
  void loadAppsIndex(workspaceId, { freshen: false })
    .then(snapshot =>
      scheduleAppEmbeddings(workspaceId, snapshot, { force: true }),
    )
    .catch(error => {
      logger.warn("App embeddings backfill failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/**
 * Start embedding the query now (cached, deduplicated), so it overlaps
 * with listing the apps the caller can see. Never throws.
 */
export function prefetchQueryEmbedding(query: string): void {
  if (!getEmbeddingModelName()) return;
  embedSearchQuery(query).catch(() => undefined);
}

/**
 * The semantic signals for a query over the given apps (already filtered
 * to what the caller may see): each app's cosine similarity to the query
 * and its document's words. Null when semantic search is off, slow
 * (SEMANTIC_TIMEOUT_MS) or failing: the caller ranks lexically.
 */
export async function relatedSignals(
  workspaceId: string,
  query: string,
  appIds: string[],
  options: { timeoutMs?: number } = {},
): Promise<RelatedSignals | null> {
  if (!getEmbeddingModelName() || !query.trim() || appIds.length === 0) {
    return null;
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(
      () => resolve(null),
      options.timeoutMs ?? SEMANTIC_TIMEOUT_MS,
    );
  });
  try {
    const work = Promise.all([
      workspaceAppVectors(workspaceId),
      embedSearchQuery(query),
    ]);
    // A late failure must not surface as an unhandled rejection.
    work.catch(() => undefined);
    const got = await Promise.race([work, timeout]);
    if (!got) {
      logger.info("Semantic app search timed out; lexical only", {
        workspaceId,
      });
      return null;
    }
    const [stored, q] = got;
    if (!stored || !q) return null;
    const similarity = new Map<string, number>();
    const terms = new Map<string, readonly string[]>();
    let missing = 0;
    for (const id of appIds) {
      const v = stored.vectors.get(id);
      if (!v) {
        missing++;
        continue;
      }
      similarity.set(id, dot(q, v));
      terms.set(id, stored.terms.get(id) ?? []);
    }
    if (missing > 0) backfillMissing(workspaceId);
    return { similarity, terms };
  } catch (error) {
    logger.warn("Semantic app search unavailable; lexical only", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
