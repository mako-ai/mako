/**
 * Unified sync-flow trigger model (docs/unified-sync-flow-proposal.md).
 *
 * A flow's behavior is driven by an orthogonal trigger set derived from
 * existing fields instead of the hard `type: "scheduled" | "webhook"`
 * discriminator:
 *
 * - poll trigger      → `schedule.enabled` + a cron expression
 * - webhook trigger   → `webhookConfig.enabled`
 * - reconcile trigger → `backfillSchedule.enabled` + a cron expression
 *
 * This module is intentionally dependency-free (structural types only) so it
 * can be imported from `workspace-schema.ts` without creating import cycles.
 */

/** Structural subset of IFlow used for trigger derivation. */
export interface FlowTriggerFields {
  type?: "scheduled" | "webhook";
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
  } | null;
}

export interface FlowTriggerSet {
  /** Cron-driven poll (`schedule.enabled` with a cron expression). */
  schedule: boolean;
  /** Push-driven ingest (`webhookConfig.enabled`). */
  webhook: boolean;
  /** Periodic full reconcile (`backfillSchedule.enabled` with a cron). */
  reconcile: boolean;
}

function hasCron(cron: string | null | undefined): boolean {
  return typeof cron === "string" && cron.trim().length > 0;
}

export function hasScheduleTrigger(flow: FlowTriggerFields): boolean {
  return flow.schedule?.enabled === true && hasCron(flow.schedule?.cron);
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
  return (
    flow.backfillSchedule?.enabled === true &&
    hasCron(flow.backfillSchedule?.cron)
  );
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
  return {
    "schedule.enabled": true,
    // String, non-empty, not whitespace-only — mirrors hasScheduleTrigger.
    "schedule.cron": { $exists: true, $type: "string", $not: /^\s*$/ },
  };
}
