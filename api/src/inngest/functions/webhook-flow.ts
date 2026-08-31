import { inngest } from "../client";
import {
  WebhookEvent,
  Flow,
  Connector as DataSource,
  DatabaseConnection,
  CdcEntityState,
} from "../../database/workspace-schema";
import { connectorRegistry } from "../../connectors/registry";
import type { BaseConnector } from "../../connectors/base/BaseConnector";
import { Types } from "mongoose";
import { hasCdcDestinationAdapter } from "../../sync-cdc/adapters/registry";
import { isEntityEnabledForFlow } from "../../sync-cdc/entity-selection";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
} from "../../sync-cdc/normalization";
import { cdcIngestService } from "../../sync-cdc/ingest";
import { cdcConsumerService } from "../../sync-cdc/consumer";
import { cdcBackfillService } from "../../sync-cdc/backfill";
import { cleanupStalePendingCdcEvents } from "../../sync-cdc/cdc-stale-pending-cleanup";
import { reconcileOrphanedWebhookApplyStatus } from "../../sync-cdc/cdc-orphan-applystatus";

const CDC_MATERIALIZE_CONCURRENCY = Math.max(
  parseInt(process.env.CDC_MATERIALIZE_CONCURRENCY || "8", 10) || 8,
  1,
);

const CDC_MATERIALIZE_CONCURRENCY_PER_FLOW = Math.max(
  parseInt(process.env.CDC_MATERIALIZE_CONCURRENCY_PER_FLOW || "3", 10) || 3,
  1,
);

type WebhookCdcRecord = {
  entity: string;
  recordId: string;
  operation: "upsert" | "delete";
  payload: Record<string, unknown>;
  sourceTs: Date;
  source: "webhook";
  changeId: string;
};

/**
 * Convert a single WebhookEvent into the (possibly multiple) canonical CDC
 * records a connector emits for it. Routing through extractWebhookCdcRecords
 * lets connectors fan out one webhook into several entities (e.g. Calendly
 * invitee.created -> invitees + scheduled_events). Falls back to the base
 * mapping + extractWebhookData for connectors that emit a single record.
 *
 * Each record is enriched with the same system fields the single-record path
 * used (_dataSourceId/_dataSourceName/_syncedAt), filtered by the flow's
 * enabled-entity selection, and given a stable changeId for idempotency.
 *
 * `extractedCount` reports how many records the connector emitted *before* the
 * enabled-entity filter, so callers can tell "extraction yielded nothing"
 * (genuine failure → retry) apart from "everything got filtered out as
 * disabled/unselected" (intentional drop).
 */
function buildWebhookCdcRecords(params: {
  connector: BaseConnector;
  dataSource: { id: string; name: string };
  flow: Parameters<typeof isEntityEnabledForFlow>[0];
  webhookEvent: {
    eventId: string;
    eventType: string;
    rawPayload: unknown;
    receivedAt: Date | string;
  };
}): { records: WebhookCdcRecord[]; extractedCount: number } {
  const { connector, dataSource, flow, webhookEvent } = params;

  const rawRecords = (
    connector.extractWebhookCdcRecords(
      webhookEvent.rawPayload,
      webhookEvent.eventType,
    ) ?? []
  ).filter(record => record != null);

  const receivedAt = new Date(webhookEvent.receivedAt);
  const out: WebhookCdcRecord[] = [];

  for (const record of rawRecords) {
    const sourcePayload = (record.payload || {}) as Record<string, unknown>;

    // Defensive sub-entity resolution for connectors that emit a generic
    // "activities" parent with a `_type` discriminator (Close already
    // pre-resolves the sub-entity in its mapping, so this is a no-op there).
    let entity = record.entity;
    if (entity === "activities" && sourcePayload._type) {
      entity = `activities:${sourcePayload._type}`;
    }

    const baseEntity = entity.split(":")[0];
    if (!isEntityEnabledForFlow(flow, entity, baseEntity)) {
      continue;
    }

    const payload: Record<string, unknown> = {
      ...normalizePayloadKeys(sourcePayload),
      _dataSourceId: dataSource.id,
      _dataSourceName: dataSource.name,
      _syncedAt: new Date(),
    };

    const recordId = String(record.recordId ?? payload.id ?? "");
    if (!recordId) continue;

    const operation: "upsert" | "delete" =
      record.operation === "delete" ? "delete" : "upsert";

    const sourceTs =
      record.sourceTs instanceof Date
        ? record.sourceTs
        : resolveSourceTimestamp(payload, receivedAt);

    const changeId =
      typeof record.changeId === "string" && record.changeId.length > 0
        ? record.changeId
        : `webhook:${webhookEvent.eventId}:${entity}:${recordId}:${operation}`;

    out.push({
      entity,
      recordId,
      operation,
      payload,
      sourceTs,
      source: "webhook",
      changeId,
    });
  }

  return { records: out, extractedCount: rawRecords.length };
}

/**
 * webhookCleanupFunction — REMOVED.
 * Superseded by a TTL index on webhookevents.receivedAt (7 days).
 * MongoDB's background thread handles expiration automatically.
 */

/**
 * Retry failed / stuck webhook events.
 *
 * All webhook flows are CDC: this resets failed and stale-processing events to
 * "pending" so the CDC scheduler cron re-ingests them on its next cycle. There
 * is no per-event Inngest enqueue anymore (the legacy `webhook/event.process`
 * pipeline was decommissioned).
 */
export const webhookRetryFunction = inngest.createFunction(
  {
    id: "webhook-retry-failed",
    name: "Retry Failed Webhook Events",
    triggers: { cron: "*/30 * * * *" },
  },
  async ({ step, logger }) => {
    const result = await step.run("retry-failed-events", async () => {
      const failedEvents = await WebhookEvent.find({
        status: "failed",
        attempts: { $lt: 5 },
      })
        .select("_id flowId eventId")
        .limit(500)
        .lean();

      const staleProcessingCutoff = new Date(Date.now() - 5 * 60 * 1000);
      const staleProcessingEvents = await WebhookEvent.find({
        status: "processing",
        attempts: { $lt: 5 },
        receivedAt: { $lt: staleProcessingCutoff },
      })
        .select("_id flowId eventId")
        .limit(500)
        .lean();

      const allEvents = [...failedEvents, ...staleProcessingEvents];
      if (allEvents.length === 0) {
        return { retried: 0, failed: 0, staleProcessing: 0 };
      }

      // Reset all to pending — the CDC scheduler cron picks them up.
      await WebhookEvent.updateMany(
        { _id: { $in: allEvents.map(e => e._id) } },
        {
          $set: { status: "pending" },
          $unset: { applyError: "", error: "", processedAt: "" },
        },
      );

      logger.info("Reset webhook events to pending for retry", {
        total: allEvents.length,
        failed: failedEvents.length,
        staleProcessing: staleProcessingEvents.length,
      });

      return {
        retried: allEvents.length,
        failed: failedEvents.length,
        staleProcessing: staleProcessingEvents.length,
      };
    });

    return result;
  },
);

const CDC_MATERIALIZE_MAX_EVENTS = Math.max(
  parseInt(process.env.BIGQUERY_CDC_MATERIALIZE_MAX_EVENTS || "15000", 10) ||
    15000,
  100,
);

const CDC_MATERIALIZE_MAX_EVENTS_BACKFILL = Math.max(
  parseInt(
    process.env.BIGQUERY_CDC_MATERIALIZE_MAX_EVENTS_BACKFILL || "5000",
    10,
  ) || 5000,
  100,
);

const CDC_CIRCUIT_BREAKER_BASE_BACKOFF_S = 60;
const CDC_CIRCUIT_BREAKER_MAX_BACKOFF_S = 30 * 60;

function circuitBreakerBackoffMs(consecutiveFailures: number): number {
  const seconds = Math.min(
    CDC_CIRCUIT_BREAKER_BASE_BACKOFF_S * 2 ** (consecutiveFailures - 1),
    CDC_CIRCUIT_BREAKER_MAX_BACKOFF_S,
  );
  return seconds * 1000;
}

const CDC_MATERIALIZE_MAX_ITERATIONS = 5;

async function runCdcMaterialization(params: {
  eventData: unknown;
  step: any;
  logger: any;
}) {
  const { workspaceId, flowId, entity, force } = params.eventData as {
    workspaceId: string;
    flowId: string;
    entity: string;
    force?: boolean;
  };

  const circuitCheck = (await params.step.run(
    "check-circuit-breaker",
    async () => {
      const entityState = await CdcEntityState.findOne({
        flowId: new Types.ObjectId(flowId),
        entity,
      })
        .select("consecutiveFailures lastFailedAt lastFailureError")
        .lean();

      const failures = entityState?.consecutiveFailures || 0;
      if (failures === 0) return { open: false, failures: 0 };

      const lastFailedAt = entityState?.lastFailedAt
        ? new Date(entityState.lastFailedAt).getTime()
        : 0;
      const backoffMs = circuitBreakerBackoffMs(failures);
      const elapsed = Date.now() - lastFailedAt;

      if (elapsed < backoffMs) {
        return {
          open: true,
          failures,
          backoffMs,
          elapsedMs: elapsed,
          retryAfterMs: backoffMs - elapsed,
          lastError: entityState?.lastFailureError,
        };
      }

      return { open: false, failures, halfOpen: true };
    },
  )) as any;

  if (circuitCheck.open && !force) {
    params.logger.info("CDC materialization skipped (circuit breaker open)", {
      flowId,
      entity,
      consecutiveFailures: circuitCheck.failures,
      backoffMs: circuitCheck.backoffMs,
      retryAfterMs: circuitCheck.retryAfterMs,
      lastError: circuitCheck.lastError,
    });
    return {
      success: true,
      skipped: true,
      reason: "circuit_breaker_open",
      consecutiveFailures: circuitCheck.failures,
      retryAfterMs: circuitCheck.retryAfterMs,
    };
  }

  let totalProcessed = 0;
  let totalApplied = 0;
  let iterations = 0;
  let lastResult: any = null;

  while (iterations < CDC_MATERIALIZE_MAX_ITERATIONS) {
    const iteration = iterations;
    const materializeStartedAt = Date.now();
    const result = (await params.step.run(
      `materialize-cdc-entity-${iteration}`,
      async () => {
        const flow = await Flow.findById(flowId)
          .select("backfillState.status")
          .lean();
        const isBackfilling = flow?.backfillState?.status === "running";
        const maxEvents = isBackfilling
          ? CDC_MATERIALIZE_MAX_EVENTS_BACKFILL
          : CDC_MATERIALIZE_MAX_EVENTS;

        const materializeResult = await cdcConsumerService.materializeEntity({
          workspaceId,
          flowId,
          entity,
          maxEvents,
        });
        return { ...materializeResult, isBackfilling, maxEvents };
      },
    )) as any;
    const materializeStepDurationMs = Date.now() - materializeStartedAt;

    params.logger.info("CDC materialization iteration completed", {
      flowId,
      entity,
      iteration,
      isBackfilling: result.isBackfilling,
      maxEvents: result.maxEvents,
      materializeStepDurationMs,
      processed: result.processed,
      applied: result.applied,
      latestIngestSeq: result.latestIngestSeq,
      skipped: result.skipped,
      reason: result.reason,
    });

    totalProcessed += result.processed || 0;
    totalApplied += result.applied || 0;
    lastResult = result;
    iterations++;

    if (result.processed < result.maxEvents) {
      break;
    }
  }

  return {
    success: true,
    totalProcessed,
    totalApplied,
    iterations,
    ...lastResult,
  };
}

/**
 * Materialize staged CDC events into live tables.
 * Canonical event name for all destination adapters.
 */
export const cdcMaterializeFunction = inngest.createFunction(
  {
    id: "cdc-materialize",
    name: "CDC Materialize",
    retries: 0,
    timeouts: {
      finish: "30m",
    },
    cancelOn: [{ event: "cdc/materialize.cancel", match: "data.flowId" }],
    concurrency: [
      {
        scope: "fn",
        limit: CDC_MATERIALIZE_CONCURRENCY,
      },
      {
        scope: "fn",
        key: "event.data.flowId",
        limit: CDC_MATERIALIZE_CONCURRENCY_PER_FLOW,
      },
    ],
    singleton: {
      key: "event.data.flowId + ':' + event.data.entity",
      mode: "skip",
    },
    triggers: { event: "cdc/materialize" },
  },
  async ({ event, step, logger }) => {
    return runCdcMaterialization({
      eventData: event.data,
      step,
      logger,
    });
  },
);

/**
 * Find CDC entities where lastIngestSeq > lastMaterializedSeq, respecting
 * the circuit-breaker backoff for consecutively failing entities.
 */
async function findStaleEntities(): Promise<
  Array<{
    workspaceId: { toString(): string };
    flowId: { toString(): string };
    entity: string;
  }>
> {
  const candidates = await CdcEntityState.find({
    $expr: { $gt: ["$lastIngestSeq", "$lastMaterializedSeq"] },
  })
    .select("workspaceId flowId entity consecutiveFailures lastFailedAt")
    .lean();

  if (candidates.length === 0) return [];

  const now = Date.now();
  const eligible = candidates.filter(c => {
    const failures = (c as any).consecutiveFailures || 0;
    if (failures === 0) return true;
    const lastFailed = (c as any).lastFailedAt
      ? new Date((c as any).lastFailedAt).getTime()
      : 0;
    return now - lastFailed >= circuitBreakerBackoffMs(failures);
  });

  const flowIds = Array.from(new Set(eligible.map(c => c.flowId.toString())));
  if (flowIds.length === 0) return [];
  const existingFlows = await Flow.find({ _id: { $in: flowIds } })
    .select("_id")
    .lean();
  const existingFlowIdSet = new Set(existingFlows.map(f => f._id.toString()));

  return eligible.filter(c => existingFlowIdSet.has(c.flowId.toString()));
}

function buildMaterializeEvents(
  entities: Array<{
    workspaceId: { toString(): string };
    flowId: { toString(): string };
    entity: string;
  }>,
) {
  return entities.map(e => ({
    name: "cdc/materialize" as const,
    data: {
      workspaceId: String(e.workspaceId),
      flowId: String(e.flowId),
      entity: e.entity,
      force: false,
    },
  }));
}

// How many pending WebhookEvents the cron ingests per run, GLOBALLY across all
// flows. The effective ingest ceiling is roughly
//   CDC_INGEST_BATCH_LIMIT / (scheduler cron interval).
// Raise this (and/or shorten the cron) if the pending WebhookEvent backlog
// grows faster than it drains. Requires the { status, receivedAt } index.
const CDC_INGEST_BATCH_LIMIT = Math.max(
  parseInt(process.env.CDC_INGEST_BATCH_LIMIT || "2000", 10) || 2000,
  100,
);

/**
 * Ingest pending WebhookEvents into CdcChangeEvents, grouped by flow.
 * Returns the number of events ingested.
 */
async function ingestPendingWebhookEvents(logger: {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
}): Promise<{ ingested: number; dropped: number; failed: number }> {
  const pendingEvents = await WebhookEvent.find({
    status: "pending",
  })
    .sort({ receivedAt: 1 })
    .limit(CDC_INGEST_BATCH_LIMIT)
    .lean();

  if (pendingEvents.length === 0) {
    return { ingested: 0, dropped: 0, failed: 0 };
  }

  // Mark as processing
  await WebhookEvent.updateMany(
    { _id: { $in: pendingEvents.map(e => e._id) } },
    { $set: { status: "processing" }, $inc: { attempts: 1 } },
  );

  // Group by flowId for efficient lookups
  const byFlow = new Map<string, typeof pendingEvents>();
  for (const evt of pendingEvents) {
    const fid = evt.flowId.toString();
    const bucket = byFlow.get(fid);
    if (bucket) {
      bucket.push(evt);
    } else {
      byFlow.set(fid, [evt]);
    }
  }

  let totalIngested = 0;
  let totalDropped = 0;
  let totalFailed = 0;

  for (const [flowId, events] of byFlow) {
    const flowDoc = await Flow.findById(flowId);
    if (!flowDoc) {
      await WebhookEvent.updateMany(
        { _id: { $in: events.map(e => e._id) } },
        {
          $set: {
            status: "completed",
            applyStatus: "dropped",
            processedAt: new Date(),
            applyError: {
              code: "FLOW_NOT_FOUND",
              message: `Flow ${flowId} no longer exists`,
            },
          },
        },
      );
      totalDropped += events.length;
      continue;
    }
    const flow: any = flowDoc.toObject();

    const dataSource = await DataSource.findById(flow.dataSourceId);
    const database = await DatabaseConnection.findById(
      flow.destinationDatabaseId,
    );

    if (!dataSource || !database) {
      await WebhookEvent.updateMany(
        { _id: { $in: events.map(e => e._id) } },
        {
          $set: {
            status: "completed",
            applyStatus: "dropped",
            processedAt: new Date(),
            applyError: {
              code: "MISSING_DEPENDENCY",
              message: `Data source or database for flow ${flowId} no longer exists`,
            },
          },
        },
      );
      totalDropped += events.length;
      continue;
    }

    const connector = connectorRegistry.getConnector(dataSource);
    if (!connector) {
      logger.warn("Connector not found for data source", {
        flowId,
        type: dataSource.type,
      });
      await WebhookEvent.updateMany(
        { _id: { $in: events.map(e => e._id) } },
        {
          $set: {
            status: "failed",
            applyStatus: "failed",
            processedAt: new Date(),
            applyError: {
              code: "CONNECTOR_NOT_FOUND",
              message: `Connector not found for type: ${dataSource.type}`,
            },
          },
        },
      );
      totalFailed += events.length;
      continue;
    }

    const destinationType = database.type;
    const isCdcEnabled =
      flow.syncEngine === "cdc" &&
      Boolean(flow.tableDestination?.connectionId) &&
      hasCdcDestinationAdapter(destinationType);

    if (!isCdcEnabled) {
      // Legacy real-time webhook processing was decommissioned: all webhook
      // flows must be CDC. A non-CDC webhook flow can only exist if it was
      // never migrated (e.g. a Mongo-collection destination with no CDC
      // adapter). Drop with a loud warning so it surfaces for manual review
      // instead of silently looping forever.
      logger.warn(
        "Dropping webhook events for non-CDC flow (legacy webhook path removed)",
        {
          flowId,
          destinationType,
          count: events.length,
        },
      );
      await WebhookEvent.updateMany(
        { _id: { $in: events.map(e => e._id) } },
        {
          $set: {
            status: "completed",
            applyStatus: "dropped",
            processedAt: new Date(),
            applyError: {
              code: "NOT_CDC_FLOW",
              message: `Flow ${flowId} is not a CDC flow — legacy webhook processing has been removed. Migrate this flow to a CDC-capable destination.`,
            },
          },
        },
      );
      totalDropped += events.length;
      continue;
    }

    const cdcEvents: Array<{
      entity: string;
      recordId: string;
      operation: "upsert" | "delete";
      payload: Record<string, unknown>;
      sourceTs: Date;
      source: "webhook";
      changeId: string;
      webhookEventId: string;
    }> = [];
    const processedIds: Array<{
      _id: any;
      entity: string;
      operation: string;
      recordId: string;
      receivedAt: Date;
    }> = [];
    let flowDropped = 0;
    let flowFailed = 0;

    for (const webhookEvent of events) {
      const mapping = connector.getWebhookEventMapping(webhookEvent.eventType);

      if (!mapping) {
        await WebhookEvent.updateOne(
          { _id: webhookEvent._id },
          {
            $set: {
              status: "completed",
              applyStatus: "applied",
              appliedAt: new Date(),
              processedAt: new Date(),
              processingDurationMs:
                Date.now() - new Date(webhookEvent.receivedAt).getTime(),
            },
            $unset: { applyError: "" },
          },
        );
        continue;
      }

      // Fan out into every entity the connector emits for this event
      // (e.g. Calendly invitee.created -> invitees + scheduled_events).
      const { records, extractedCount } = buildWebhookCdcRecords({
        connector,
        dataSource: { id: dataSource.id, name: dataSource.name },
        flow,
        webhookEvent: {
          eventId: webhookEvent.eventId,
          eventType: webhookEvent.eventType,
          rawPayload: webhookEvent.rawPayload,
          receivedAt: webhookEvent.receivedAt,
        },
      });

      if (extractedCount === 0) {
        // Mapping existed but the connector produced no usable record:
        // malformed/unexpected payload. Mark failed so it's surfaced (matches
        // the legacy extract-failed path).
        flowFailed++;
        totalFailed++;
        await WebhookEvent.updateOne(
          { _id: webhookEvent._id },
          {
            $set: {
              status: "failed",
              applyStatus: "failed",
              processedAt: new Date(),
              applyError: {
                code: "EXTRACT_FAILED",
                message: "Failed to extract data from webhook event",
              },
              processingDurationMs:
                Date.now() - new Date(webhookEvent.receivedAt).getTime(),
            },
          },
        );
        continue;
      }

      if (records.length === 0) {
        // Records were extracted but all got filtered out by the flow's
        // enabled-entity selection. Intentional drop, not a failure.
        flowDropped++;
        totalDropped++;
        await WebhookEvent.updateOne(
          { _id: webhookEvent._id },
          {
            $set: {
              status: "completed",
              applyStatus: "dropped",
              applyError: {
                code: "ENTITY_DISABLED",
                message: `No enabled entity for event ${webhookEvent.eventType} in flow configuration`,
              },
              processedAt: new Date(),
              processingDurationMs:
                Date.now() - new Date(webhookEvent.receivedAt).getTime(),
            },
            $unset: { appliedAt: "" },
          },
        );
        continue;
      }

      for (const record of records) {
        cdcEvents.push({
          entity: record.entity,
          recordId: record.recordId,
          operation: record.operation,
          payload: record.payload,
          sourceTs: record.sourceTs,
          source: "webhook",
          changeId: record.changeId,
          webhookEventId: String(webhookEvent._id),
        });
      }

      // Bookkeeping on the WebhookEvent uses the primary (first) record.
      const primary = records[0];
      processedIds.push({
        _id: webhookEvent._id,
        entity: primary.entity,
        operation: primary.operation,
        recordId: primary.recordId,
        receivedAt: webhookEvent.receivedAt,
      });
    }

    if (cdcEvents.length > 0) {
      await cdcIngestService.appendNormalizedEvents({
        workspaceId: String(flow.workspaceId),
        flowId: String(flowId),
        events: cdcEvents,
      });
    }

    if (processedIds.length > 0) {
      const bulkOps = processedIds.map(item => ({
        updateOne: {
          filter: { _id: item._id },
          update: {
            $set: {
              status: "completed",
              processedAt: new Date(),
              entity: item.entity,
              operation: item.operation,
              recordId: item.recordId,
              applyStatus: "pending",
              processingDurationMs:
                Date.now() - new Date(item.receivedAt).getTime(),
            },
            $inc: { applyAttempts: 1 },
            $unset: { applyError: "" },
          },
        },
      }));
      await WebhookEvent.bulkWrite(bulkOps);
    }

    await Flow.updateOne(
      { _id: flowId },
      {
        $set: {
          lastRunAt: new Date(),
          lastSuccessAt: cdcEvents.length > 0 ? new Date() : undefined,
        },
        $inc: { runCount: 1 },
      },
    );

    totalIngested += cdcEvents.length;

    logger.info("CDC cron ingest completed for flow", {
      flowId,
      batchSize: events.length,
      cdcIngested: cdcEvents.length,
      dropped: flowDropped,
      failed: flowFailed,
    });
  }

  return {
    ingested: totalIngested,
    dropped: totalDropped,
    failed: totalFailed,
  };
}

/**
 * Unified CDC scheduler: runs every 5 minutes.
 *
 * Step 1 — Ingest: finds pending WebhookEvents, normalizes them into
 * CdcChangeEvents, and marks them as completed.
 *
 * Step 2 — Materialize: finds stale entities (lastIngestSeq > lastMaterializedSeq)
 * and emits cdc/materialize events. The singleton on cdc-materialize deduplicates
 * concurrent triggers.
 */
export const cdcMaterializeSchedulerFunction = inngest.createFunction(
  {
    id: "cdc-materialize-scheduler",
    name: "CDC Ingest + Materialize Scheduler",
    concurrency: { limit: 1 },
    triggers: { cron: "*/5 * * * *" },
  },
  async ({ step, logger }) => {
    const ingestResult = (await step.run("ingest-pending-webhooks", () =>
      ingestPendingWebhookEvents(logger),
    )) as { ingested: number; dropped: number; failed: number };

    // Reap CDC events that are still materialization-pending but whose paired
    // webhook completed long ago (apply never finalized). Without this, stuck
    // pending CdcChangeEvents accumulate forever — there is no TTL on the
    // "pending" status (only applied/dropped have TTL indexes).
    const cleanupResult = (await step.run(
      "cleanup-stale-pending-cdc",
      cleanupStalePendingCdcEvents,
    )) as Awaited<ReturnType<typeof cleanupStalePendingCdcEvents>>;

    // Self-heal the flow "pending" counter: flip WebhookEvents stuck at
    // applyStatus:"pending" whose CDC events are all terminal (or were deduped)
    // to "applied". Without this, the count grows forever and the UI looks
    // stuck even when there is no real materialization backlog.
    const orphanReconcile = (await step.run(
      "reconcile-orphaned-applystatus",
      reconcileOrphanedWebhookApplyStatus,
    )) as Awaited<ReturnType<typeof reconcileOrphanedWebhookApplyStatus>>;

    // Safety net: resume any flow stuck in a repartition pause (e.g. the
    // repartition job's process died before its resume step ran).
    await step.run("recover-stale-repartition-pauses", () =>
      cdcBackfillService.recoverStaleRepartitionPauses(),
    );

    const staleEntities = (await step.run(
      "find-stale-entities",
      findStaleEntities,
    )) as Array<{
      workspaceId: { toString(): string };
      flowId: { toString(): string };
      entity: string;
    }>;

    let totalTriggered = 0;
    if (staleEntities.length > 0) {
      const DISPATCH_BATCH = 20;
      for (let i = 0; i < staleEntities.length; i += DISPATCH_BATCH) {
        const batch = staleEntities.slice(i, i + DISPATCH_BATCH);
        await step.sendEvent(
          `trigger-materializations-${i}`,
          buildMaterializeEvents(batch),
        );
      }
      totalTriggered = staleEntities.length;
    }

    if (
      ingestResult.ingested > 0 ||
      totalTriggered > 0 ||
      cleanupResult.droppedCdc > 0 ||
      orphanReconcile.resolved > 0
    ) {
      logger.info("CDC scheduler completed", {
        ingested: ingestResult.ingested,
        dropped: ingestResult.dropped,
        failed: ingestResult.failed,
        materializeTriggered: totalTriggered,
        staleCdcDropped: cleanupResult.droppedCdc,
        staleWebhooksDropped: cleanupResult.droppedWebhooks,
        staleCursorsAdvanced: cleanupResult.cursorsAdvanced,
        orphanApplyStatusResolved: orphanReconcile.resolved,
      });
    }

    return {
      ingested: ingestResult.ingested,
      dropped: ingestResult.dropped,
      failed: ingestResult.failed,
      materializeTriggered: totalTriggered,
      staleCdcDropped: cleanupResult.droppedCdc,
      orphanApplyStatusResolved: orphanReconcile.resolved,
    };
  },
);
