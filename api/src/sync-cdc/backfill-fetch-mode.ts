/**
 * Incremental scheduled resync — which records a CDC backfill fetches.
 *
 * A scheduled resync (`backfillSchedule`, the flow file's `resync:`) used to
 * re-download every record of every entity in scope. For a large Close
 * account that is 12–20 h a night and sometimes a WORKER_TIMEOUT, while the
 * live stream (webhooks) already carries the changes between resyncs.
 *
 * This module decides, per entity and per run, whether the backfill fetches
 * everything (`full`) or only the records the source updated since the last
 * completed backfill of that entity, minus a safety overlap (`incremental`).
 * It is ADDITIVE: every safety layer that existed stays.
 *
 * - Only scheduled runs can go incremental. A human pressing Backfill (UI,
 *   MCP `flow_backfill`, API), a resync, a layout change — all stay full.
 * - Only connector/entity pairs listed in INCREMENTAL_RESYNC_ENTITIES, i.e.
 *   whose fetch filters on the source's update time end to end. Everything
 *   else (Close users, statuses, custom fields, groups, …) keeps a full fetch.
 * - A full fetch still happens for each entity at least every
 *   `fullIntervalMs` (default 7 days), measured between run start times, and
 *   whenever the entity has no completed full backfill on record (new flow,
 *   after a resync wiped the state, first run after this shipped).
 * - Only `append_dedup` (upsert) destinations: `overwrite` truncates the live
 *   table at run start, so it needs every record; `append` keeps one row per
 *   fetched version and is left untouched.
 *
 * Deletions: a backfill MERGEs (upserts) fetched rows into the live table; it
 * has never removed rows the source no longer returns. Deletions reach the
 * destination through the live stream (Close `*.deleted` webhooks →
 * tombstones / hard deletes). An incremental resync changes nothing there; the
 * weekly full fetch re-reads every live record exactly as before.
 *
 * The decision depends only on values that are stable for the whole run (the
 * run's start time, the entity's stamps that change only when the entity
 * completes), so a run resumed from a checkpoint re-derives the same `since`
 * and the connector's resumable cursor stays consistent.
 */

export type BackfillTrigger = "scheduled" | "manual";

export type BackfillFetchDecision =
  | { mode: "full"; reason: string }
  | { mode: "incremental"; since: Date; reason: string };

/**
 * Connector type → predicate on entity names whose fetch honours `since` by
 * filtering on the source's update time.
 *
 * Close: leads, contacts, opportunities and every `activities:<Type>` go
 * through the Search API, which windows on `date_updated` (moment_range,
 * full timestamp) when `since` is set — the same path an incremental poll
 * uses. `users` (`/user/` has no update filter), `custom_fields`, `groups`
 * and the lookup tables ignore `since` and are small, so they stay full.
 */
export const INCREMENTAL_RESYNC_ENTITIES: Readonly<
  Record<string, (entity: string) => boolean>
> = {
  close: entity =>
    entity === "leads" ||
    entity === "contacts" ||
    entity === "opportunities" ||
    (entity.startsWith("activities:") && entity.length > "activities:".length),
};

export const DEFAULT_OVERLAP_MS = 6 * 60 * 60 * 1000; // 6 h
export const DEFAULT_FULL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface BackfillFetchConfig {
  enabled: boolean;
  overlapMs: number;
  fullIntervalMs: number;
}

function positiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Environment overrides:
 * - `CDC_INCREMENTAL_RESYNC=off` (or `false`/`0`) — kill switch: every
 *   backfill is full again.
 * - `CDC_INCREMENTAL_RESYNC_OVERLAP_HOURS` — safety overlap (default 6).
 * - `CDC_FULL_RESYNC_INTERVAL_DAYS` — max age of the last full fetch
 *   (default 7).
 */
export function backfillFetchConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): BackfillFetchConfig {
  const flag = (env.CDC_INCREMENTAL_RESYNC || "").trim().toLowerCase();
  const overlapHours = positiveNumber(env.CDC_INCREMENTAL_RESYNC_OVERLAP_HOURS);
  const fullDays = positiveNumber(env.CDC_FULL_RESYNC_INTERVAL_DAYS);
  return {
    enabled: !["off", "false", "0", "no"].includes(flag),
    overlapMs:
      overlapHours !== undefined
        ? overlapHours * 60 * 60 * 1000
        : DEFAULT_OVERLAP_MS,
    fullIntervalMs:
      fullDays !== undefined
        ? fullDays * 24 * 60 * 60 * 1000
        : DEFAULT_FULL_INTERVAL_MS,
  };
}

/** Whether this connector/entity can ever fetch incrementally on a resync. */
export function supportsIncrementalResync(
  connectorType: string | undefined,
  entity: string,
): boolean {
  if (!connectorType) return false;
  const predicate = INCREMENTAL_RESYNC_ENTITIES[connectorType];
  return Boolean(predicate && predicate(entity));
}

/** Whether this connector participates at all (any entity). */
export function isIncrementalResyncConnector(
  connectorType: string | undefined,
): boolean {
  return Boolean(connectorType && INCREMENTAL_RESYNC_ENTITIES[connectorType]);
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function decideBackfillFetchMode(input: {
  connectorType: string | undefined;
  entity: string;
  trigger: BackfillTrigger | undefined;
  writeMode?: string;
  /** `flow.backfillState.startedAt` of the run being executed. */
  runStartedAt: Date | string | null | undefined;
  /** Start of the last backfill run in which this entity completed. */
  lastBackfillRunStartedAt: Date | string | null | undefined;
  /** Start of the last backfill run in which this entity completed FULL. */
  lastFullBackfillRunStartedAt: Date | string | null | undefined;
  config?: BackfillFetchConfig;
}): BackfillFetchDecision {
  const config = input.config ?? backfillFetchConfigFromEnv();

  if (!config.enabled) {
    return { mode: "full", reason: "incremental resync disabled" };
  }
  if (!supportsIncrementalResync(input.connectorType, input.entity)) {
    return {
      mode: "full",
      reason: `${input.connectorType || "connector"} entity ${input.entity} has no update-time filter`,
    };
  }
  if (input.trigger !== "scheduled") {
    return { mode: "full", reason: "not a scheduled resync" };
  }
  const writeMode = input.writeMode || "append_dedup";
  if (writeMode !== "append_dedup") {
    return {
      mode: "full",
      reason: `write mode ${writeMode} needs a full fetch`,
    };
  }

  const runStartedAt = toDate(input.runStartedAt);
  if (!runStartedAt) {
    return { mode: "full", reason: "run start time unknown" };
  }
  const lastFull = toDate(input.lastFullBackfillRunStartedAt);
  if (!lastFull) {
    return { mode: "full", reason: "no completed full backfill on record" };
  }
  if (runStartedAt.getTime() - lastFull.getTime() >= config.fullIntervalMs) {
    return {
      mode: "full",
      reason: `last full backfill started ${lastFull.toISOString()}, periodic full fetch due`,
    };
  }
  const lastCompleted = toDate(input.lastBackfillRunStartedAt) ?? lastFull;
  // Never anchor later than the last full run's start if the stamps disagree
  // (clock skew, manual edits): take the later of the two only when it is
  // not in the future relative to this run.
  const anchor =
    lastCompleted.getTime() > lastFull.getTime() &&
    lastCompleted.getTime() <= runStartedAt.getTime()
      ? lastCompleted
      : lastFull;
  const since = new Date(anchor.getTime() - config.overlapMs);
  return {
    mode: "incremental",
    since,
    reason: `records updated since ${since.toISOString()} (last completed run started ${anchor.toISOString()}, overlap ${Math.round(config.overlapMs / 3_600_000)}h)`,
  };
}
