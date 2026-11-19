/**
 * Coalescing window for live CDC materialization.
 *
 * Every materialization of an entity costs the same 4 to 6 BigQuery jobs
 * (staging load, staging schema read, partition probe on partitioned tables,
 * MERGE, staging drop, plus a DELETE for hard deletes), whether it applies 1
 * event or 5,000. The webhook batch dispatcher asks for one every minute per
 * entity that got events, and the 5-minute stale-entity cron asks again.
 *
 * A run for an entity materialized less than the window ago sleeps until the
 * window has passed. The cdc-materialize singleton (one run per flow + entity,
 * mode "skip") drops every trigger that arrives meanwhile, and the events
 * those triggers stand for wait in the event store as pending. The run then
 * reads them all in ingest-seq order and applies them in one load + MERGE,
 * exactly as a single larger batch does today.
 *
 * `force: true` triggers (operator retry, backfill recovery and drain,
 * repartition) skip the window.
 */

/**
 * CDC_MATERIALIZE_WINDOW_MS, else 300 s. 0 turns coalescing off.
 * 300 s: on 19 Nov 2026 it cut realadvisor-prod's CDC runs 53% (60 s: 4%,
 * because the webhook dispatcher already fires once a minute per entity).
 */
export const DEFAULT_CDC_MATERIALIZE_WINDOW_MS = 300_000;

/** At most 15 min: a run sleeps inside its 30 min finish timeout. */
const MAX_CDC_MATERIALIZE_WINDOW_MS = 15 * 60_000;

export function cdcMaterializeWindowMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.CDC_MATERIALIZE_WINDOW_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_CDC_MATERIALIZE_WINDOW_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_CDC_MATERIALIZE_WINDOW_MS;
  }
  return Math.min(Math.floor(parsed), MAX_CDC_MATERIALIZE_WINDOW_MS);
}

/**
 * How long a run waits before it materializes: the rest of the window since
 * the entity's last materialization. 0 when forced, when coalescing is off,
 * when the entity never materialized, or when the window has passed. A
 * `lastMaterializedAt` in the future (clock skew) waits one window at most.
 */
export function coalesceWaitMs(params: {
  lastMaterializedAt?: Date | string | number | null;
  now: number;
  windowMs: number;
  force?: boolean;
}): number {
  if (params.force || params.windowMs <= 0) return 0;
  if (params.lastMaterializedAt == null) return 0;
  const last = new Date(params.lastMaterializedAt).getTime();
  if (!Number.isFinite(last)) return 0;
  const elapsed = params.now - last;
  if (elapsed >= params.windowMs) return 0;
  return Math.min(params.windowMs - Math.max(elapsed, 0), params.windowMs);
}
