/**
 * Unified sync-flow trigger model (docs/unified-sync-flow-proposal.md).
 *
 * A flow's behavior is driven by an orthogonal trigger set derived from
 * existing fields instead of the hard `type: "scheduled" | "webhook"`
 * discriminator:
 *
 * - poll trigger      → a `schedules[]` row with `kind: "poll"`
 * - webhook trigger   → `webhookConfig.enabled`
 * - reconcile trigger → a `schedules[]` row with `kind: "reconcile"`
 *
 * Flows written before the unified `schedules[]` list carry the same two cron
 * triggers in the standalone `schedule` (poll) and `backfillSchedule`
 * (reconcile) fields; `resolveFlowSchedules` projects both generations into
 * one shape, so nothing below branches on storage layout.
 *
 * This module is intentionally dependency-free (structural types only) so it
 * can be imported from `workspace-schema.ts` without creating import cycles.
 */

/**
 * One row of the unified `schedules[]` list. Replaces the split
 * `schedule` (poll) / `backfillSchedule` (reconcile) pair: a flow now has a
 * list of cron rows, each with its own entity scope and run kind.
 */
export interface FlowScheduleEntry {
  /** Stable client-generated id (used to stamp `lastRunAt` on the right row). */
  id?: string;
  enabled?: boolean;
  cron?: string | null;
  timezone?: string;
  /** Empty/absent = every entity enabled in the flow's entity selection. */
  entities?: string[];
  /**
   * - "poll": a normal run honoring the flow's `syncMode`.
   * - "reconcile": a full re-pull of the scoped entities (CDC backfill on the
   *   CDC engine, a `backfill: true` run otherwise).
   */
  kind?: "poll" | "reconcile";
  lastRunAt?: Date | string | null;
}

/** Structural subset of IFlow used for trigger derivation. */
export interface FlowTriggerFields {
  type?: "scheduled" | "webhook";
  schedules?: FlowScheduleEntry[] | null;
  schedule?: {
    enabled?: boolean;
    cron?: string | null;
    timezone?: string;
  } | null;
  webhookConfig?: {
    enabled?: boolean;
    endpoint?: string | null;
  } | null;
  backfillSchedule?: {
    enabled?: boolean;
    cron?: string | null;
    timezone?: string;
    lastRunAt?: Date | string | null;
  } | null;
}

export interface FlowTriggerSet {
  /** At least one cron-driven poll schedule. */
  schedule: boolean;
  /** Push-driven ingest (`webhookConfig.enabled`). */
  webhook: boolean;
  /** At least one periodic full reconcile schedule. */
  reconcile: boolean;
}

function hasCron(cron: string | null | undefined): boolean {
  return typeof cron === "string" && cron.trim().length > 0;
}

/** A schedule row normalized for the schedulers to act on. */
export interface ResolvedFlowSchedule {
  id: string;
  cron: string;
  timezone: string;
  /** Empty = no per-schedule narrowing (use the flow's entity selection). */
  entities: string[];
  kind: "poll" | "reconcile";
  lastRunAt: Date | null;
  /**
   * Where this row came from. Legacy rows are derived from the pre-list
   * `schedule` / `backfillSchedule` fields and keep their original
   * `lastRunAt` bookkeeping; "list" rows stamp `schedules.$[...].lastRunAt`.
   */
  origin: "list" | "schedule" | "backfillSchedule";
}

function normalizeScheduleEntities(entities: unknown): string[] {
  if (!Array.isArray(entities)) return [];
  const seen = new Set<string>();
  for (const entity of entities) {
    if (typeof entity !== "string") continue;
    const trimmed = entity.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return Array.from(seen);
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The flow's effective schedule rows. `schedules[]` wins when present;
 * otherwise the legacy `schedule` (poll) + `backfillSchedule` (reconcile)
 * pair is projected into the same shape so both storage generations run
 * through one code path.
 */
export function resolveFlowSchedules(
  flow: FlowTriggerFields,
): ResolvedFlowSchedule[] {
  const list = Array.isArray(flow.schedules) ? flow.schedules : [];
  if (list.length > 0) {
    return list
      .filter(entry => entry?.enabled !== false && hasCron(entry?.cron))
      .map((entry, index) => ({
        id: entry.id || `schedule-${index}`,
        cron: (entry.cron as string).trim(),
        timezone: entry.timezone || "UTC",
        entities: normalizeScheduleEntities(entry.entities),
        kind: entry.kind === "reconcile" ? "reconcile" : "poll",
        lastRunAt: toDate(entry.lastRunAt),
        origin: "list" as const,
      }));
  }

  const resolved: ResolvedFlowSchedule[] = [];
  if (flow.schedule?.enabled === true && hasCron(flow.schedule.cron)) {
    resolved.push({
      id: "legacy-schedule",
      cron: (flow.schedule.cron as string).trim(),
      timezone: flow.schedule.timezone || "UTC",
      entities: [],
      kind: "poll",
      // The poll runner has always tracked its cadence off the flow-level
      // `lastRunAt`, which the execution itself updates.
      lastRunAt: null,
      origin: "schedule",
    });
  }
  if (
    flow.backfillSchedule?.enabled === true &&
    hasCron(flow.backfillSchedule.cron)
  ) {
    resolved.push({
      id: "legacy-backfill-schedule",
      cron: (flow.backfillSchedule.cron as string).trim(),
      timezone: flow.backfillSchedule.timezone || "UTC",
      entities: [],
      kind: "reconcile",
      lastRunAt: toDate(flow.backfillSchedule.lastRunAt),
      origin: "backfillSchedule",
    });
  }
  return resolved;
}

export interface NormalizedFlowSchedule {
  id: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  entities?: string[];
  kind: "poll" | "reconcile";
  lastRunAt?: Date;
}

export type NormalizeSchedulesResult =
  | { ok: true; schedules: NormalizedFlowSchedule[] }
  | { ok: false; error: string };

function isValidCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  return fields.length === 5 || fields.length === 6;
}

/**
 * Validate and normalize a client-supplied `schedules[]` payload.
 * `lastRunAt` is never taken from the client — it is carried over from the
 * stored row with the same id so an edit can't replay or skip a cadence.
 */
export function normalizeFlowScheduleList(
  input: unknown,
  options: {
    previous?: FlowScheduleEntry[] | null;
    generateId: () => string;
  },
): NormalizeSchedulesResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: "schedules must be an array" };
  }

  const previousById = new Map<string, FlowScheduleEntry>();
  for (const entry of options.previous || []) {
    if (entry?.id) previousById.set(entry.id, entry);
  }

  const schedules: NormalizedFlowSchedule[] = [];
  const seenIds = new Set<string>();

  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "Each schedule must be an object" };
    }
    const entry = raw as FlowScheduleEntry;
    const cron = typeof entry.cron === "string" ? entry.cron.trim() : "";
    if (!cron || !isValidCron(cron)) {
      return {
        ok: false,
        error: `Invalid cron expression: "${cron}". Use 5 or 6 space-separated fields.`,
      };
    }

    let id =
      typeof entry.id === "string" && entry.id.trim().length > 0
        ? entry.id.trim()
        : options.generateId();
    while (seenIds.has(id)) id = options.generateId();
    seenIds.add(id);

    const entities = normalizeScheduleEntities(entry.entities);
    const previousRun = toDate(previousById.get(id)?.lastRunAt);

    schedules.push({
      id,
      enabled: entry.enabled !== false,
      cron,
      timezone:
        typeof entry.timezone === "string" && entry.timezone.trim()
          ? entry.timezone.trim()
          : "UTC",
      ...(entities.length > 0 ? { entities } : {}),
      kind: entry.kind === "reconcile" ? "reconcile" : "poll",
      ...(previousRun ? { lastRunAt: previousRun } : {}),
    });
  }

  return { ok: true, schedules };
}

/**
 * Back-compat projection of a `schedules[]` list onto the standalone
 * `schedule` / `backfillSchedule` fields that older readers (list payloads,
 * the flow detail panels, the /toggle-schedule endpoint) still consult.
 */
export function deriveLegacyScheduleMirrors(
  schedules: NormalizedFlowSchedule[],
): {
  schedule: { enabled: boolean; cron?: string; timezone?: string };
  backfillSchedule: { enabled: boolean; cron?: string; timezone?: string };
} {
  const firstPoll = schedules.find(s => s.enabled && s.kind === "poll");
  const firstReconcile = schedules.find(
    s => s.enabled && s.kind === "reconcile",
  );
  return {
    schedule: firstPoll
      ? { enabled: true, cron: firstPoll.cron, timezone: firstPoll.timezone }
      : { enabled: false },
    backfillSchedule: firstReconcile
      ? {
          enabled: true,
          cron: firstReconcile.cron,
          timezone: firstReconcile.timezone,
        }
      : { enabled: false },
  };
}

export function hasScheduleTrigger(flow: FlowTriggerFields): boolean {
  return resolveFlowSchedules(flow).some(s => s.kind === "poll");
}

export function hasWebhookTrigger(flow: FlowTriggerFields): boolean {
  // Mongoose nested-path defaults materialize `webhookConfig.enabled: true`
  // on EVERY flow (including plain scheduled flows), so `enabled` alone is
  // meaningless. A real webhook trigger requires the provisioned endpoint,
  // which is only generated for webhook flows at create time.
  return (
    flow.webhookConfig?.enabled === true &&
    typeof flow.webhookConfig.endpoint === "string" &&
    flow.webhookConfig.endpoint.trim().length > 0
  );
}

export function hasReconcileTrigger(flow: FlowTriggerFields): boolean {
  return resolveFlowSchedules(flow).some(s => s.kind === "reconcile");
}

export function deriveTriggerSet(flow: FlowTriggerFields): FlowTriggerSet {
  return {
    schedule: hasScheduleTrigger(flow),
    webhook: hasWebhookTrigger(flow),
    reconcile: hasReconcileTrigger(flow),
  };
}

export function hasAnyTrigger(flow: FlowTriggerFields): boolean {
  const triggers = deriveTriggerSet(flow);
  return triggers.schedule || triggers.webhook || triggers.reconcile;
}

/**
 * Back-compat `type` derivation: a flow is only "webhook" when the webhook
 * trigger is its sole freshness source; anything with a poll schedule is
 * "scheduled" so legacy consumers keep working.
 *
 * IMPORTANT: this value must never be persisted onto an existing webhook
 * flow's `type` — the inbound webhook receiver hard-filters `type: "webhook"`,
 * so rewriting a hybrid flow's type would 404 its webhook endpoint.
 */
export function deriveFlowType(
  flow: FlowTriggerFields,
): "scheduled" | "webhook" {
  const triggers = deriveTriggerSet(flow);
  return triggers.webhook && !triggers.schedule ? "webhook" : "scheduled";
}

/**
 * Engine default for newly created flows. Webhook flows are always CDC (the
 * legacy real-time webhook pipeline has been decommissioned). Connector
 * flows targeting a CDC-capable table destination default to CDC; everything
 * else stays on the legacy engine until the full sunset.
 */
export function resolveDefaultSyncEngine(params: {
  flowType: "scheduled" | "webhook";
  sourceType: "connector" | "database";
  hasTableDestination: boolean;
  destinationSupportsCdc: boolean;
}): "cdc" | "legacy" {
  if (params.flowType === "webhook") return "cdc";
  return params.sourceType === "connector" &&
    params.hasTableDestination &&
    params.destinationSupportsCdc
    ? "cdc"
    : "legacy";
}

/**
 * Mongo selection for the poll-trigger scheduler (`flowSchedulerFunction`):
 * purely trigger-based — any flow with an enabled poll schedule and a real
 * cron is polled (a webhook flow with a poll schedule is a hybrid).
 */
export function buildScheduledFlowSelection(): Record<string, unknown> {
  // Non-empty cron string, not whitespace-only — mirrors hasCron.
  const cronMatch = { $exists: true, $type: "string", $not: /^\s*$/ };
  return {
    $or: [
      { "schedule.enabled": true, "schedule.cron": cronMatch },
      {
        schedules: {
          $elemMatch: { enabled: { $ne: false }, cron: cronMatch },
        },
      },
    ],
  };
}

/**
 * Mongo selection for the reconcile-trigger scheduler
 * (`cdcScheduledBackfillFunction`): legacy `backfillSchedule` rows plus any
 * `schedules[]` row with `kind: "reconcile"`.
 */
export function buildReconcileFlowSelection(): Record<string, unknown> {
  const cronMatch = { $exists: true, $type: "string", $not: /^\s*$/ };
  return {
    $or: [
      { "backfillSchedule.enabled": true, "backfillSchedule.cron": cronMatch },
      {
        schedules: {
          $elemMatch: {
            enabled: { $ne: false },
            kind: "reconcile",
            cron: cronMatch,
          },
        },
      },
    ],
  };
}
