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
  /**
   * Retired. Documents written before triggers replaced it still carry it;
   * nothing writes it any more and only `isWebhookFlow` reads it, as a
   * fallback for such a document without an endpoint.
   */
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

/** The flow has an inbound webhook URL (minted once; providers POST to it). */
export function hasWebhookEndpoint(flow: FlowTriggerFields): boolean {
  return (
    typeof flow.webhookConfig?.endpoint === "string" &&
    flow.webhookConfig.endpoint.trim().length > 0
  );
}

/**
 * Whether the flow is set up for inbound webhooks: it has its URL. Whether
 * deliveries are accepted right now is `webhookConfig.enabled` (the receiver
 * answers 403 when it is off), and `hasWebhookTrigger` is both. A flow with
 * webhooks keeps polling when it has a poll schedule: webhooks only add speed.
 *
 * A document from before triggers replaced `type` and without an endpoint
 * still counts when its retired `type` says webhook (the migration
 * 2026-10-17 gives every such flow its endpoint; this is the safety net).
 */
export function isWebhookFlow(flow: FlowTriggerFields): boolean {
  return hasWebhookEndpoint(flow) || flow.type === "webhook";
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
 * A label for API clients that still read `type`: "webhook" when the webhook
 * trigger is the sync's only freshness source, else "scheduled". Display
 * only: never persisted, never branched on.
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
