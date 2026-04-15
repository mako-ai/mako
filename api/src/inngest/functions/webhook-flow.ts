import { inngest } from "../client";
import {
  WebhookEvent,
  Flow,
  Connector as DataSource,
  DatabaseConnection,
  CdcEntityState,
} from "../../database/workspace-schema";
import { getSyncLogger } from "../logging";
import { connectorRegistry } from "../../connectors/registry";
import { createDestinationWriter } from "../../services/destination-writer.service";
import { getEntityTableName } from "../../sync/sync-orchestrator";
import { Types } from "mongoose";
import { hasCdcDestinationAdapter } from "../../sync-cdc/adapters/registry";
import { isEntityEnabledForFlow } from "../../sync-cdc/entity-selection";
import {
  normalizePayloadKeys,
  resolveSourceTimestamp,
} from "../../sync-cdc/normalization";
import { cdcIngestService } from "../../sync-cdc/ingest";
import { cdcConsumerService } from "../../sync-cdc/consumer";
import { enqueueWebhookProcess } from "../webhook-process-enqueue";

const WEBHOOK_SQL_PROCESS_CONCURRENCY = Math.max(
  parseInt(process.env.WEBHOOK_SQL_PROCESS_CONCURRENCY || "5", 10) || 5,
  1,
);

async function runWebhookEventProcess({
  event,
  step,
}: {
  event: { data: Record<string, unknown> };
  step: {
    run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
  };
}) {
  const { flowId, eventId } = event.data as {
    flowId: string;
    eventId: string;
  };
  const logger = getSyncLogger(`webhook.${flowId}`);

  logger.debug("Processing webhook event", { flowId, eventId });

  // Load webhook row and flip to processing in one step (fewer Inngest round-trips).
  const webhookEvent = (await step.run("prepare-webhook-event", async () => {
    const doc = await WebhookEvent.findOne({ flowId, eventId });
    if (!doc) {
      throw new Error(`Webhook event not found: ${eventId}`);
    }
    await WebhookEvent.updateOne(
      { _id: doc._id },
      {
        $set: { status: "processing" },
        $inc: { attempts: 1 },
      },
    );
    return doc.toObject();
  })) as any; // Type assertion needed due to Inngest step typing

  // Process the event (load Flow here so we do not pay a separate step.run for it).
  const result = (await step.run("process-event", async () => {
    const stepStartedAt = Date.now();

    const processWebhookJob = async () => {
      try {
        const flowDoc = await Flow.findById(flowId);
        if (!flowDoc) {
          logger.warn("Flow not found – marking webhook event as dropped", {
            flowId,
            eventId: webhookEvent.eventId,
          });
          await WebhookEvent.updateOne(
            { _id: webhookEvent._id },
            {
              $set: {
                status: "completed",
                applyStatus: "dropped",
                processedAt: new Date(),
                applyError: {
                  code: "FLOW_NOT_FOUND",
                  message: `Flow ${flowId} no longer exists`,
                },
                processingDurationMs:
                  Date.now() - new Date(webhookEvent.receivedAt).getTime(),
              },
            },
          );
          return { processed: false, reason: `Flow ${flowId} not found` };
        }
        const flow: any = flowDoc.toObject();

        const dataSource = await DataSource.findById(flow.dataSourceId);
        const database = await DatabaseConnection.findById(
          flow.destinationDatabaseId,
        );

        if (!dataSource || !database) {
          logger.warn(
            "Data source or database not found – marking webhook event as dropped",
            {
              flowId,
              eventId: webhookEvent.eventId,
              dataSourceId: flow.dataSourceId,
              databaseId: flow.destinationDatabaseId,
            },
          );
          await WebhookEvent.updateOne(
            { _id: webhookEvent._id },
            {
              $set: {
                status: "completed",
                applyStatus: "dropped",
                processedAt: new Date(),
                applyError: {
                  code: "MISSING_DEPENDENCY",
                  message: `Data source or database for flow ${flowId} no longer exists`,
                },
                processingDurationMs:
                  Date.now() - new Date(webhookEvent.receivedAt).getTime(),
              },
            },
          );
          return {
            processed: false,
            reason: "Data source or database not found",
          };
        }

        // Get MongoDB connection through mongoose
        const dbConnection = Flow.db;
        // Use the actual database name from connection, not the label
        const dbName = database.connection.database || database.name;
        const db = dbConnection.useDb(dbName);

        // Get the connector for event mapping
        const connector = connectorRegistry.getConnector(dataSource);
        if (!connector) {
          throw new Error(`Connector not found for type: ${dataSource.type}`);
        }

        // Get event mapping
        const eventType = webhookEvent.eventType;
        const mapping = connector.getWebhookEventMapping(eventType);

        if (!mapping) {
          logger.warn("Unknown event type", {
            eventType,
            eventId: webhookEvent.eventId,
            connectorType: dataSource.type,
          });

          // Mark as completed even if we don't process it
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

          return { processed: false, reason: "Unknown event type" };
        }

        // Extract data using connector
        const extractedData = connector.extractWebhookData(
          webhookEvent.rawPayload,
        );
        if (!extractedData) {
          throw new Error("Failed to extract data from webhook event");
        }

        const { id, data } = extractedData;

        // Flatten keys with dots (e.g. Close custom fields "custom.cf_xxx")
        // BigQuery interprets dots as struct field access which breaks queries
        const documentData = {
          ...normalizePayloadKeys(data),
          _dataSourceId: dataSource.id,
          _dataSourceName: dataSource.name,
          _syncedAt: new Date(),
        };

        const destinationType = database.type;
        const isCdcEnabled =
          flow.syncEngine === "cdc" &&
          Boolean(flow.tableDestination?.connectionId) &&
          hasCdcDestinationAdapter(destinationType);

        // For activity events, resolve sub-type from the data's _type field
        // so we route to the correct per-sub-type table (e.g. activities:Call → call)
        let resolvedEntity = mapping.entity;
        if (mapping.entity === "activities" && data._type) {
          resolvedEntity = `activities:${data._type}`;
        }

        const entityLayout = (flow.entityLayouts || []).find(
          (l: any) =>
            l.entity === resolvedEntity || l.entity === mapping.entity,
        );
        const isEntityEnabled = isEntityEnabledForFlow(
          flow,
          resolvedEntity,
          mapping.entity,
        );

        // When entity layouts are configured, only explicitly enabled entities
        // are allowed through (both webhook and backfill-driven writes).
        if (!isEntityEnabled) {
          await WebhookEvent.updateOne(
            { _id: webhookEvent._id },
            {
              $set: {
                status: "completed",
                applyStatus: "dropped",
                applyError: {
                  code: "ENTITY_DISABLED",
                  message: `Entity ${resolvedEntity} is disabled or not selected in flow configuration`,
                },
                processedAt: new Date(),
                processingDurationMs:
                  Date.now() - new Date(webhookEvent.receivedAt).getTime(),
              },
              $unset: { appliedAt: "" },
            },
          );
          return {
            processed: false,
            reason: `Entity ${resolvedEntity} is disabled`,
          };
        }

        if (isCdcEnabled && flow.tableDestination?.connectionId) {
          const sourceTs = resolveSourceTimestamp(
            documentData,
            new Date(webhookEvent.receivedAt),
          );
          await cdcIngestService.appendNormalizedEvents({
            workspaceId: String(flow.workspaceId),
            flowId: String(flowId),
            events: [
              {
                entity: resolvedEntity,
                recordId: String(id),
                operation: mapping.operation,
                payload: documentData,
                sourceTs,
                source: "webhook",
                changeId: `webhook:${webhookEvent.eventId}:${resolvedEntity}:${id}:${mapping.operation}`,
                webhookEventId: String(webhookEvent._id),
              },
            ],
          });

          await WebhookEvent.updateOne(
            { _id: webhookEvent._id },
            {
              $set: {
                status: "completed",
                processedAt: new Date(),
                entity: resolvedEntity,
                operation: mapping.operation,
                recordId: String(id),
                applyStatus: "pending",
                processingDurationMs:
                  Date.now() - new Date(webhookEvent.receivedAt).getTime(),
              },
              $inc: { applyAttempts: 1 },
              $unset: { applyError: "" },
            },
          );

          logger.info("Queued webhook event for BigQuery CDC materialization", {
            eventId: webhookEvent.eventId,
            flowId,
            entity: resolvedEntity,
            operation: mapping.operation,
          });

          return {
            processed: true,
            reason: "Queued for CDC materialization",
            entity: resolvedEntity,
            operation: mapping.operation,
          };
        }

        // ========== SQL/BigQuery destination path ==========
        if (flow.tableDestination?.connectionId) {
          const entityTableName = getEntityTableName(
            flow.tableDestination.tableName,
            resolvedEntity,
          );

          const entityTableDest = {
            ...flow.tableDestination,
            tableName: entityTableName,
            connectionId: new Types.ObjectId(
              flow.tableDestination.connectionId,
            ),
            partitioning: entityLayout
              ? {
                  enabled: true,
                  type: "time" as const,
                  field: entityLayout.partitionField,
                  granularity: entityLayout.partitionGranularity || "day",
                }
              : flow.tableDestination.partitioning,
            clustering: entityLayout?.clusterFields?.length
              ? {
                  enabled: true,
                  fields: entityLayout.clusterFields,
                }
              : flow.tableDestination.clustering,
          };

          const writer = await createDestinationWriter(
            {
              destinationDatabaseId: new Types.ObjectId(
                flow.destinationDatabaseId,
              ),
              destinationDatabaseName: flow.destinationDatabaseName,
              tableDestination: entityTableDest,
            },
            dataSource.name,
          );
          (writer as any).config.deleteMode = flow.deleteMode;

          logger.info("Processing webhook event (SQL destination)", {
            eventType,
            entity: resolvedEntity,
            operation: mapping.operation,
            id,
            table: entityTableName,
          });

          if (mapping.operation === "upsert") {
            const result = await writer.writeBatch([documentData], {
              keyColumns: ["id", "_dataSourceId"],
              conflictStrategy: "update",
            });
            if (!result.success) {
              throw new Error(`SQL upsert failed: ${result.error}`);
            }
          } else if (mapping.operation === "delete") {
            const deleteMode = flow.deleteMode || "hard";
            if (deleteMode === "soft") {
              const softDeleteDoc = {
                ...documentData,
                is_deleted: true,
                deleted_at: new Date(),
              };
              const result = await writer.writeBatch([softDeleteDoc], {
                keyColumns: ["id", "_dataSourceId"],
                conflictStrategy: "update",
              });
              if (!result.success) {
                throw new Error(`SQL soft delete failed: ${result.error}`);
              }
            } else {
              const result = await writer.deleteByKeys({
                id,
                _dataSourceId: dataSource.id,
              });
              if (!result.success) {
                throw new Error(`SQL hard delete failed: ${result.error}`);
              }
            }
          }

          await WebhookEvent.updateOne(
            { _id: webhookEvent._id },
            {
              $set: {
                status: "completed",
                processedAt: new Date(),
                entity: resolvedEntity,
                operation: mapping.operation,
                recordId: String(id),
                applyStatus: "applied",
                appliedAt: new Date(),
                processingDurationMs:
                  Date.now() - new Date(webhookEvent.receivedAt).getTime(),
              },
              $inc: { applyAttempts: 1 },
              $unset: { applyError: "" },
            },
          );

          logger.info("Webhook event processed (SQL)", {
            eventId: webhookEvent.eventId,
            eventType,
            entity: resolvedEntity,
            operation: mapping.operation,
            table: entityTableName,
          });

          return {
            processed: true,
            entity: resolvedEntity,
            operation: mapping.operation,
          };
        }

        // ========== Legacy MongoDB destination path (unchanged) ==========
        const collectionName = `${dataSource.name}_${mapping.entity}`;
        const collection = db.collection(collectionName);

        const stagingCollectionName = `${collectionName}_staging`;
        let stagingCollection = null;

        try {
          const stagingCol = db.collection(stagingCollectionName);
          const indexes = await stagingCol.indexes();
          if (indexes && indexes.length > 0) {
            stagingCollection = stagingCol;
            logger.info("Staging collection found, will write to both", {
              stagingCollection: stagingCollectionName,
            });
          }
        } catch {
          logger.debug("No staging collection found", {
            stagingCollection: stagingCollectionName,
          });
        }

        logger.info("Processing webhook event", {
          eventType,
          entity: mapping.entity,
          operation: mapping.operation,
          id,
          collection: collectionName,
          hasStaging: !!stagingCollection,
        });

        if (mapping.operation === "upsert") {
          await collection.updateOne(
            { id },
            { $set: documentData },
            { upsert: true },
          );

          if (stagingCollection) {
            await stagingCollection.updateOne(
              { id },
              { $set: documentData },
              { upsert: true },
            );
          }
        } else if (mapping.operation === "delete") {
          await collection.deleteOne({ id });

          if (stagingCollection) {
            await stagingCollection.deleteOne({ id });
          }
        }

        await WebhookEvent.updateOne(
          { _id: webhookEvent._id },
          {
            $set: {
              status: "completed",
              processedAt: new Date(),
              entity: resolvedEntity,
              operation: mapping.operation,
              recordId: String(id),
              applyStatus: "applied",
              appliedAt: new Date(),
              processingDurationMs:
                Date.now() - new Date(webhookEvent.receivedAt).getTime(),
            },
            $inc: { applyAttempts: 1 },
            $unset: { applyError: "" },
          },
        );

        logger.info("Webhook event processed successfully", {
          eventId: webhookEvent.eventId,
          eventType,
          entity: mapping.entity,
          operation: mapping.operation,
          collection: collectionName,
          updatedStaging: !!stagingCollection,
        });

        return {
          processed: true,
          entity: mapping.entity,
          operation: mapping.operation,
        };
      } catch (error) {
        // Mark event as failed
        await WebhookEvent.updateOne(
          { _id: webhookEvent._id },
          {
            $set: {
              status: "failed",
              applyStatus: "failed",
              applyError: {
                message: error instanceof Error ? error.message : String(error),
                code: "APPLY_FAILED",
              },
              error: {
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              },
            },
            $inc: { applyAttempts: 1 },
          },
        );

        logger.error("Failed to process webhook event", {
          eventId: webhookEvent.eventId,
          error: error instanceof Error ? error.message : String(error),
        });

        throw error;
      }
    };

    try {
      const jobResult = (await processWebhookJob()) as {
        processed: boolean;
        [key: string]: unknown;
      };
      await Flow.updateOne(
        { _id: flowId },
        {
          $set: {
            lastRunAt: new Date(),
            lastSuccessAt: jobResult.processed ? new Date() : undefined,
          },
          $inc: { runCount: 1 },
        },
      );
      logger.info("webhook_process_step_completed", {
        flowId,
        eventId,
        stepDurationMs: Date.now() - stepStartedAt,
        processed: jobResult.processed,
      });
      return jobResult;
    } catch (error) {
      logger.warn("webhook_process_step_failed", {
        flowId,
        eventId,
        stepDurationMs: Date.now() - stepStartedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  })) as any;

  return {
    success: true,
    eventId: webhookEvent.eventId,
    processed: (result as { processed: boolean }).processed,
    details: result,
  };
}

/**
 * Process webhook events that apply directly to the warehouse (non-CDC table path).
 * Keep concurrency low — each run can issue DML against BigQuery/SQL.
 */
export const webhookEventProcessFunction = inngest.createFunction(
  {
    id: "webhook-event-process",
    name: "Process Webhook Event",
    concurrency: {
      limit: WEBHOOK_SQL_PROCESS_CONCURRENCY,
      key: "event.data.flowId",
    },
  },
  { event: "webhook/event.process" },
  runWebhookEventProcess,
);

/**
 * @deprecated CDC ingest is now handled by the 2-min cron scheduler.
 * Kept as a no-op so Inngest doesn't error on in-flight events during deploy.
 */
export const webhookEventProcessCdcFunction = inngest.createFunction(
  {
    id: "webhook-event-process-cdc",
    name: "Process Webhook Event (CDC ingest) [DEPRECATED]",
  },
  { event: "webhook/event.process.cdc" },
  async () => {
    return {
      skipped: true,
      reason: "Deprecated — CDC ingest moved to cron scheduler",
    };
  },
);

/**
 * webhookCleanupFunction — REMOVED.
 * Superseded by a TTL index on webhookevents.receivedAt (7 days).
 * MongoDB's background thread handles expiration automatically.
 */

/**
 * Retry failed / stuck webhook events.
 *
 * CDC events: resets status to "pending" so the 2-min cron picks them up.
 * Non-CDC events: resets to "pending" and re-enqueues via Inngest.
 */
export const webhookRetryFunction = inngest.createFunction(
  {
    id: "webhook-retry-failed",
    name: "Retry Failed Webhook Events",
  },
  { cron: "*/30 * * * *" },
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

      // Reset all to pending
      await WebhookEvent.updateMany(
        { _id: { $in: allEvents.map(e => e._id) } },
        {
          $set: { status: "pending" },
          $unset: { applyError: "", error: "", processedAt: "" },
        },
      );

      // Non-CDC events need explicit Inngest enqueue since the cron
      // only handles CDC flows. Look up which flows are CDC to decide.
      const flowIds = [...new Set(allEvents.map(e => e.flowId.toString()))];
      const flows = await Flow.find({ _id: { $in: flowIds } })
        .select("_id syncEngine destinationDatabaseId tableDestination")
        .lean();

      const cdcFlowIds = new Set<string>();
      for (const f of flows) {
        if (!f.destinationDatabaseId) continue;
        const dest = await DatabaseConnection.findById(f.destinationDatabaseId)
          .select("type")
          .lean();
        if (
          f.syncEngine === "cdc" &&
          Boolean((f as any).tableDestination?.connectionId) &&
          hasCdcDestinationAdapter(dest?.type)
        ) {
          cdcFlowIds.add(f._id.toString());
        }
      }

      let nonCdcEnqueued = 0;
      for (const evt of allEvents) {
        if (!cdcFlowIds.has(evt.flowId.toString())) {
          try {
            await enqueueWebhookProcess({
              flowId: evt.flowId.toString(),
              eventId: evt.eventId,
            });
            nonCdcEnqueued++;
          } catch {
            // Will be picked up on the next retry cycle
          }
        }
      }

      logger.info("Reset webhook events to pending for retry", {
        total: allEvents.length,
        failed: failedEvents.length,
        staleProcessing: staleProcessingEvents.length,
        nonCdcEnqueued,
      });

      return {
        retried: allEvents.length,
        failed: failedEvents.length,
        staleProcessing: staleProcessingEvents.length,
        nonCdcEnqueued,
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
      finish: "15m",
    },
    singleton: {
      key: "event.data.flowId + ':' + event.data.entity",
      mode: "skip",
    },
    cancelOn: [{ event: "cdc/materialize.cancel", match: "data.flowId" }],
  },
  { event: "cdc/materialize" },
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

const CDC_INGEST_BATCH_LIMIT = 1000;

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
    if (!byFlow.has(fid)) byFlow.set(fid, []);
    byFlow.get(fid)!.push(evt);
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
      // Non-CDC events shouldn't reach the cron ingest. Mark as completed
      // so they don't loop. The non-CDC SQL path uses its own Inngest event.
      await WebhookEvent.updateMany(
        { _id: { $in: events.map(e => e._id) } },
        {
          $set: {
            status: "completed",
            applyStatus: "dropped",
            processedAt: new Date(),
            applyError: {
              code: "NOT_CDC_FLOW",
              message: `Flow ${flowId} is not a CDC flow — event should use the SQL webhook path`,
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

      const extractedData = connector.extractWebhookData(
        webhookEvent.rawPayload,
      );
      if (!extractedData) {
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
        flowFailed++;
        totalFailed++;
        continue;
      }

      const { id, data } = extractedData;
      const documentData = {
        ...normalizePayloadKeys(data),
        _dataSourceId: dataSource.id,
        _dataSourceName: dataSource.name,
        _syncedAt: new Date(),
      };

      let resolvedEntity = mapping.entity;
      if (mapping.entity === "activities" && data._type) {
        resolvedEntity = `activities:${data._type}`;
      }

      if (!isEntityEnabledForFlow(flow, resolvedEntity, mapping.entity)) {
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
                message: `Entity ${resolvedEntity} is disabled or not selected in flow configuration`,
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

      const sourceTs = resolveSourceTimestamp(
        documentData,
        new Date(webhookEvent.receivedAt),
      );

      cdcEvents.push({
        entity: resolvedEntity,
        recordId: String(id),
        operation: mapping.operation,
        payload: documentData,
        sourceTs,
        source: "webhook",
        changeId: `webhook:${webhookEvent.eventId}:${resolvedEntity}:${id}:${mapping.operation}`,
        webhookEventId: String(webhookEvent._id),
      });

      processedIds.push({
        _id: webhookEvent._id,
        entity: resolvedEntity,
        operation: mapping.operation,
        recordId: String(id),
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
 * Unified CDC scheduler: runs every 2 minutes.
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
  },
  { cron: "*/5 * * * *" },
  async ({ step, logger }) => {
    const ingestResult = (await step.run("ingest-pending-webhooks", () =>
      ingestPendingWebhookEvents(logger),
    )) as { ingested: number; dropped: number; failed: number };

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
      await step.sendEvent(
        "trigger-materializations",
        buildMaterializeEvents(staleEntities),
      );
      totalTriggered = staleEntities.length;
    }

    if (ingestResult.ingested > 0 || totalTriggered > 0) {
      logger.info("CDC scheduler completed", {
        ingested: ingestResult.ingested,
        dropped: ingestResult.dropped,
        failed: ingestResult.failed,
        materializeTriggered: totalTriggered,
      });
    }

    return {
      ingested: ingestResult.ingested,
      dropped: ingestResult.dropped,
      failed: ingestResult.failed,
      materializeTriggered: totalTriggered,
    };
  },
);
