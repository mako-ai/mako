import { inngest } from "../client";
import {
  WebhookEvent,
  Flow,
  Connector as DataSource,
  DatabaseConnection,
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
import {
  enqueueWebhookProcess,
  type WebhookFlowRoutingHint,
} from "../webhook-process-enqueue";

const WEBHOOK_SQL_PROCESS_CONCURRENCY = Math.max(
  parseInt(process.env.WEBHOOK_SQL_PROCESS_CONCURRENCY || "5", 10) || 5,
  1,
);

const WEBHOOK_CDC_INGEST_PROCESS_CONCURRENCY = Math.max(
  parseInt(process.env.WEBHOOK_CDC_PROCESS_CONCURRENCY || "25", 10) || 25,
  5,
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
          throw new Error(`Flow not found: ${flowId}`);
        }
        const flow: any = flowDoc.toObject();

        const dataSource = await DataSource.findById(flow.dataSourceId);
        const database = await DatabaseConnection.findById(
          flow.destinationDatabaseId,
        );

        if (!dataSource || !database) {
          throw new Error("Invalid data source or database");
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
            enqueue: true,
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
 * CDC ingest path: Mongo staging + cdc/materialize only (no warehouse DML here).
 * Higher per-flow concurrency is safe; materialization stays serialized per entity.
 */
export const webhookEventProcessCdcFunction = inngest.createFunction(
  {
    id: "webhook-event-process-cdc",
    name: "Process Webhook Event (CDC ingest)",
    concurrency: {
      limit: WEBHOOK_CDC_INGEST_PROCESS_CONCURRENCY,
      key: "event.data.flowId",
    },
  },
  { event: "webhook/event.process.cdc" },
  runWebhookEventProcess,
);

/**
 * Cleanup old webhook events (simplified version)
 */
export const webhookCleanupFunction = inngest.createFunction(
  {
    id: "webhook-cleanup",
    name: "Cleanup Old Webhook Events",
  },
  { cron: "0 2 * * *" }, // Run daily at 2 AM
  async ({ step, logger }) => {
    const result = await step.run("cleanup-old-events", async () => {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // Delete completed events older than 30 days
      const deleteResult = await WebhookEvent.deleteMany({
        status: "completed",
        processedAt: { $lt: thirtyDaysAgo },
      });

      logger.info("Cleaned up old webhook events", {
        deleted: deleteResult.deletedCount,
      });

      return { deleted: deleteResult.deletedCount };
    });

    return result;
  },
);

/**
 * Retry failed webhook events (simplified version)
 */
export const webhookRetryFunction = inngest.createFunction(
  {
    id: "webhook-retry-failed",
    name: "Retry Failed Webhook Events",
  },
  { cron: "*/30 * * * *" }, // Run every 30 minutes
  async ({ step, logger }) => {
    const result = await step.run("retry-failed-events", async () => {
      // Find failed events with less than 5 attempts
      const failedEvents = await WebhookEvent.find({
        status: "failed",
        attempts: { $lt: 5 },
      }).limit(500);

      const stalePendingCutoff = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes
      const staleProcessingCutoff = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes

      // Safety net: pending rows can happen if event publish succeeded in DB but
      // runner delivery failed (e.g. local dev runner restart).
      const stalePendingEvents = await WebhookEvent.find({
        status: "pending",
        attempts: { $lt: 5 },
        receivedAt: { $lt: stalePendingCutoff },
      }).limit(500);

      // Safety net: processing rows can be left behind when a worker crashes
      // mid-flight before status is finalized.
      const staleProcessingEvents = await WebhookEvent.find({
        status: "processing",
        attempts: { $lt: 5 },
        receivedAt: { $lt: staleProcessingCutoff },
      }).limit(500);

      const allEvents = [
        ...failedEvents,
        ...stalePendingEvents,
        ...staleProcessingEvents,
      ];
      const uniqueEvents = Array.from(
        new Map(allEvents.map(event => [event._id.toString(), event])).values(),
      );

      if (uniqueEvents.length === 0) {
        return { retried: 0, failed: 0, stalePending: 0, staleProcessing: 0 };
      }

      const flowIds = Array.from(
        new Set(uniqueEvents.map(e => e.flowId.toString())),
      );
      const routingByFlowId = new Map<
        string,
        { flow: WebhookFlowRoutingHint; destinationType?: string }
      >();
      for (const fid of flowIds) {
        const flowDoc = await Flow.findById(fid)
          .select("syncEngine destinationDatabaseId tableDestination")
          .lean();
        if (!flowDoc) continue;
        const destId = flowDoc.destinationDatabaseId;
        const destConn =
          destId != null
            ? await DatabaseConnection.findById(destId).select("type").lean()
            : null;
        routingByFlowId.set(fid, {
          flow: flowDoc as WebhookFlowRoutingHint,
          destinationType: destConn?.type,
        });
      }

      // Reset events to pending and trigger reprocessing
      let totalRetried = 0;
      for (const event of uniqueEvents) {
        // Ensure state is pending before re-drive.
        // For pending rows this is idempotent.
        await WebhookEvent.updateOne(
          { _id: event._id },
          {
            $set: { status: "pending", applyStatus: "pending" },
            $unset: { applyError: "", error: "", processedAt: "" },
          },
        );

        const fid = event.flowId.toString();
        const routing = routingByFlowId.get(fid);
        await enqueueWebhookProcess({
          flowId: fid,
          eventId: event.eventId,
          flow: routing?.flow,
          destinationTypeHint: routing?.destinationType,
        });

        totalRetried++;
      }

      logger.info("Retried failed webhook events", {
        total: totalRetried,
        failed: failedEvents.length,
        stalePending: stalePendingEvents.length,
        staleProcessing: staleProcessingEvents.length,
      });

      return {
        retried: totalRetried,
        failed: failedEvents.length,
        stalePending: stalePendingEvents.length,
        staleProcessing: staleProcessingEvents.length,
      };
    });

    return result;
  },
);

async function runCdcMaterialization(params: {
  eventData: unknown;
  step: any;
  logger: any;
  continuationEventName: string;
}) {
  const { workspaceId, flowId, entity, force } = params.eventData as {
    workspaceId: string;
    flowId: string;
    entity: string;
    force?: boolean;
  };
  const maxEvents = Math.max(
    parseInt(process.env.BIGQUERY_CDC_MATERIALIZE_MAX_EVENTS || "7500", 10) ||
      7500,
    100,
  );

  const materializeStartedAt = Date.now();
  const result = await params.step.run("materialize-cdc-entity", async () => {
    return cdcConsumerService.materializeEntity({
      workspaceId,
      flowId,
      entity,
      maxEvents,
    });
  });
  const materializeStepDurationMs = Date.now() - materializeStartedAt;

  params.logger.info("CDC materialization completed", {
    flowId,
    entity,
    force: Boolean(force),
    materializeStepDurationMs,
    processed: (result as any).processed,
    applied: (result as any).applied,
    latestIngestSeq: (result as any).latestIngestSeq,
    skipped: (result as any).skipped,
    reason: (result as any).reason,
  });

  if ((result as any).processed >= maxEvents) {
    await params.step.sendEvent("continue-materialize", {
      name: params.continuationEventName,
      data: { workspaceId, flowId, entity, force: true },
    });
  }

  return { success: true, ...result };
}

/**
 * Materialize staged CDC events into live tables.
 * Canonical event name for all destination adapters.
 */
export const cdcMaterializeFunction = inngest.createFunction(
  {
    id: "cdc-materialize",
    name: "CDC Materialize",
    concurrency: {
      limit: 1,
      key: "event.data.flowId + ':' + event.data.entity",
    },
  },
  { event: "cdc/materialize" },
  async ({ event, step, logger }) => {
    return runCdcMaterialization({
      eventData: event.data,
      step,
      logger,
      continuationEventName: "cdc/materialize",
    });
  },
);
