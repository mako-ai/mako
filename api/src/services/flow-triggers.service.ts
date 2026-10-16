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

/**
 * Whether the flow takes inbound webhook deliveries. A flow created as
 * `type: "webhook"` keeps exactly the behaviour it always had (its URL was
 * minted at creation and providers already POST to it). Any other flow takes
 * them once its webhook trigger is on: an endpoint minted when webhooks were
 * switched on, and `enabled`. `type` no longer decides alone, so a scheduled
 * flow keeps polling and gets webhooks on top.
 */
export function isWebhookFlow(flow: FlowTriggerFields): boolean {
  return flow.type === "webhook" || hasWebhookTrigger(flow);
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
 * Never persist it onto a flow's `type`: `type` is what keeps an existing
 * webhook flow taking deliveries (see `isWebhookFlow`).
 */
export function deriveFlowType(
  flow: FlowTriggerFields,
): "scheduled" | "webhook" {
  const triggers = deriveTriggerSet(flow);
  return triggers.webhook && !triggers.schedule ? "webhook" : "scheduled";
}

export const LEGACY_ENGINE_REMOVED =
  "The legacy sync engine has been removed: connector flows run on CDC and need a table destination with a CDC adapter";

/**
 * Engine for a flow. CDC is the only engine for connector flows (the legacy
 * engine has been removed); a connector flow that cannot run on CDC is
 * refused where it is created (`connectorFlowCdcError`). Database-source
 * flows (query -> table) have their own write path and keep the "legacy"
 * label, which nothing reads for them.
 */
export function resolveDefaultSyncEngine(params: {
  sourceType: "connector" | "database";
}): "cdc" | "legacy" {
  return params.sourceType === "database" ? "legacy" : "cdc";
}

/**
 * Why a connector flow cannot be created or saved, or null when it can: CDC
 * needs a table destination whose database has a CDC adapter.
 */
export function connectorFlowCdcError(params: {
  sourceType: "connector" | "database";
  hasTableDestination: boolean;
  destinationSupportsCdc: boolean;
}): string | null {
  if (params.sourceType === "database") return null;
  if (!params.hasTableDestination) {
    return `${LEGACY_ENGINE_REMOVED}: this flow has no table destination`;
  }
  if (!params.destinationSupportsCdc) {
    return `${LEGACY_ENGINE_REMOVED}: the destination database has no CDC adapter`;
  }
  return null;
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
