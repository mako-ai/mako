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
import {
  appendBigQueryChangeEvents,
  isBigQueryCdcEnabledForFlow,
  mapWebhookEventToChangeInput,
  resolveDestinationTypeForFlow,
} from "../../services/bigquery-cdc.service";
import { cdcMaterializerService } from "../../sync-cdc/materializer.service";

/**
 * Process a single webhook event immediately
 */
export const webhookEventProcessFunction = inngest.createFunction(
  {
    id: "webhook-event-process",
    name: "Process Webhook Event",
    concurrency: {
      limit: 5, // Keep low to avoid BigQuery DML concurrency limits
      key: "event.data.flowId", // Avoid global throttling across all flows
    },
  },
  { event: "webhook/event.process" },
  async ({ event, step }) => {
    const {
      flowId,
      eventId,
      isReplay = false,
    } = event.data as {
      flowId: string;
      eventId: string;
      isReplay?: boolean;
    };
    const logger = getSyncLogger(`webhook.${flowId}`);

    logger.debug("Processing webhook event", { flowId, eventId, isReplay });

    // Get the webhook event
    const webhookEvent = (await step.run("fetch-webhook-event", async () => {
      const event = await WebhookEvent.findOne({ flowId, eventId });
      if (!event) {
        throw new Error(`Webhook event not found: ${eventId}`);
      }
      return event;
    })) as any; // Type assertion needed due to Inngest step typing

    // Mark event as processing
    await step.run("mark-event-processing", async () => {
      await WebhookEvent.updateOne(
        { _id: webhookEvent._id },
        {
          $set: { status: "processing" },
          $inc: { attempts: 1 },
        },
      );
    });

    // Get flow details
    const flow: any = await step.run("fetch-flow-details", async () => {
      const found = await Flow.findById(flowId);
      if (!found) {
        throw new Error(`Flow not found: ${flowId}`);
      }
      return found.toObject();
    });

    // Process the event
    const result = await step.run("process-event", async () => {
      try {
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
        const flatData: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(data)) {
          flatData[key.replace(/\./g, "_")] = value;
        }

        const documentData = {
          ...flatData,
          _dataSourceId: dataSource._id,
          _dataSourceName: dataSource.name,
          _syncedAt: new Date(),
          _webhookEventId: webhookEvent.eventId,
        };

        const destinationType = await resolveDestinationTypeForFlow(flow);
        const isBigQueryCdcEnabled = isBigQueryCdcEnabledForFlow(
          flow,
          destinationType,
        );

        // For activity events, resolve sub-type from the data's _type field
        // so we route to the correct per-sub-type table (e.g. activities:Call → call)
        let resolvedEntity = mapping.entity;
        if (mapping.entity === "activities" && data._type) {
          resolvedEntity = `activities:${data._type}`;
        }

        // IMPORTANT: keep this logic inside the same step block.
        // Inngest does not support nesting step.run calls.
        let backfillGate: { active: boolean; staleCleared: boolean } = {
          active: false,
          staleCleared: false,
        };
        if (flow.tableDestination?.connectionId) {
          const executionsCollection = Flow.db.collection("flow_executions");
          const activeBackfillExecution = await executionsCollection.findOne({
            flowId: new Types.ObjectId(flowId),
            status: "running",
            "context.syncMode": "full",
          });

          // Source of truth: a running full-sync execution means webhook apply
          // must be deferred, even if backfillState.active drifted to false.
          if (activeBackfillExecution) {
            backfillGate = { active: true, staleCleared: false };
          }

          const latestFlow = await Flow.findById(flowId)
            .select({ backfillState: 1 })
            .lean();
          if (latestFlow?.backfillState?.active) {
            const activeExecution = activeBackfillExecution;

            // If no running execution exists, the gate may be stale (e.g. abandoned run).
            // But we need a grace window right after backfill starts, before the
            // flow execution document is fully initialized.
            if (!activeExecution) {
              const startedAt = latestFlow.backfillState.startedAt
                ? new Date(latestFlow.backfillState.startedAt)
                : null;
              const gateAgeMs = startedAt
                ? Date.now() - startedAt.getTime()
                : Number.POSITIVE_INFINITY;
              const withinStartupGrace = gateAgeMs < 5 * 60 * 1000; // 5 minutes

              if (withinStartupGrace) {
                backfillGate = { active: true, staleCleared: false };
                logger.info(
                  "Backfill gate active during startup grace window",
                  {
                    flowId,
                    eventId: webhookEvent.eventId,
                    gateAgeMs,
                  },
                );
              } else {
                await Flow.updateOne(
                  { _id: new Types.ObjectId(flowId) },
                  {
                    $set: {
                      "backfillState.active": false,
                      "backfillState.completedAt": new Date(),
                    },
                  },
                );
                backfillGate = { active: false, staleCleared: true };
              }
            } else {
              backfillGate = { active: true, staleCleared: false };
            }
          } else if (activeBackfillExecution) {
            // Self-heal drift: keep flag aligned so UI and downstream checks
            // reflect the actual running backfill.
            await Flow.updateOne(
              { _id: new Types.ObjectId(flowId) },
              {
                $set: {
                  "backfillState.active": true,
                  "backfillState.startedAt":
                    activeBackfillExecution.startedAt || new Date(),
                  "backfillState.completedAt": null,
                },
              },
            );

            logger.warn(
              "Backfill gate flag drift detected; restored active=true from running execution",
              {
                flowId,
                eventId: webhookEvent.eventId,
              },
            );
          }
        }

        if (backfillGate.staleCleared) {
          logger.warn("Cleared stale backfill gate before webhook apply", {
            flowId,
            eventId: webhookEvent.eventId,
          });
        }

        const shouldDeferApply =
          !!flow.tableDestination?.connectionId &&
          backfillGate.active &&
          !isReplay;

        if (isBigQueryCdcEnabled && flow.tableDestination?.connectionId) {
          const change = await mapWebhookEventToChangeInput({
            entity: resolvedEntity,
            operation: mapping.operation,
            recordId: String(id),
            payload: documentData,
            webhookEvent: {
              eventId: webhookEvent.eventId,
              receivedAt: new Date(webhookEvent.receivedAt),
            },
          });

          await appendBigQueryChangeEvents({
            workspaceId: new Types.ObjectId(String(flow.workspaceId)),
            flowId: new Types.ObjectId(flowId),
            changes: [change],
            enqueue: true,
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

        // During backfill, queue webhook apply and defer destination writes.
        // We'll replay pending webhook events after swap completes.
        if (shouldDeferApply) {
          await WebhookEvent.updateOne(
            { _id: webhookEvent._id },
            {
              $set: {
                status: "pending",
                entity: resolvedEntity,
                operation: mapping.operation,
                recordId: String(id),
                applyStatus: "pending",
              },
            },
          );

          logger.info("Deferred webhook apply due to active backfill", {
            eventId: webhookEvent.eventId,
            entity: resolvedEntity,
            operation: mapping.operation,
          });

          return {
            processed: false,
            reason: "Deferred until backfill replay",
            entity: resolvedEntity,
            operation: mapping.operation,
          };
        }

        // Skip disabled entities (unchecked in flow config)
        if (flow.entityLayouts?.length) {
          const layout = flow.entityLayouts.find(
            (l: any) =>
              l.entity === resolvedEntity || l.entity === mapping.entity,
          );
          if (layout && layout.enabled === false) {
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
            return {
              processed: false,
              reason: `Entity ${resolvedEntity} is disabled`,
            };
          }
        }

        // ========== SQL/BigQuery destination path ==========
        if (flow.tableDestination?.connectionId) {
          const entityTableName = getEntityTableName(
            flow.tableDestination.tableName,
            resolvedEntity,
          );

          // Resolve per-entity layout from flow.entityLayouts
          const entityLayout = (flow.entityLayouts || []).find(
            (l: any) =>
              l.entity === resolvedEntity || l.entity === mapping.entity,
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
                _dataSourceId: dataSource._id,
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
    });

    // Update flow stats
    await step.run("update-flow-stats", async () => {
      await Flow.updateOne(
        { _id: flowId },
        {
          $set: {
            lastRunAt: new Date(),
            lastSuccessAt: result.processed ? new Date() : undefined,
          },
          $inc: {
            runCount: 1,
          },
        },
      );
    });

    return {
      success: true,
      eventId: webhookEvent.eventId,
      processed: result.processed,
      details: result,
    };
  },
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
      }).limit(100);

      const stalePendingCutoff = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes
      const staleProcessingCutoff = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes

      // Safety net: pending rows can happen if event publish succeeded in DB but
      // runner delivery failed (e.g. local dev runner restart).
      const stalePendingEvents = await WebhookEvent.find({
        status: "pending",
        attempts: { $lt: 5 },
        receivedAt: { $lt: stalePendingCutoff },
      }).limit(100);

      // Safety net: processing rows can be left behind when a worker crashes
      // mid-flight before status is finalized.
      const staleProcessingEvents = await WebhookEvent.find({
        status: "processing",
        attempts: { $lt: 5 },
        receivedAt: { $lt: staleProcessingCutoff },
      }).limit(100);

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

        // Trigger processing
        await inngest.send({
          name: "webhook/event.process",
          data: {
            flowId: event.flowId.toString(),
            eventId: event.eventId,
          },
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

/**
 * Materialize staged BigQuery CDC events into live tables.
 */
export const bigQueryCdcMaterializeFunction = inngest.createFunction(
  {
    id: "bigquery-cdc-materialize",
    name: "BigQuery CDC Materialize",
    concurrency: {
      limit: 1,
      key: "event.data.flowId + ':' + event.data.entity",
    },
  },
  { event: "bigquery/cdc.materialize" },
  async ({ event, step, logger }) => {
    const { workspaceId, flowId, entity, force } = event.data as {
      workspaceId: string;
      flowId: string;
      entity: string;
      force?: boolean;
    };
    const maxEvents = Math.max(
      parseInt(process.env.BIGQUERY_CDC_MATERIALIZE_MAX_EVENTS || "5000", 10) ||
        5000,
      100,
    );

    const result = await step.run("materialize-bigquery-cdc-entity", async () => {
      return cdcMaterializerService.materializeEntity({
        workspaceId,
        flowId,
        entity,
        maxEvents,
      });
    });

    logger.info("BigQuery CDC materialization completed", {
      flowId,
      entity,
      force: Boolean(force),
      staged: (result as any).staged,
      applied: (result as any).applied,
      lastMaterializedSeq: (result as any).lastMaterializedSeq,
      skipped: (result as any).skipped,
      reason: (result as any).reason,
    });

    if ((result as any).staged >= maxEvents) {
      await step.sendEvent("continue-materialize", {
        name: "bigquery/cdc.materialize",
        data: { workspaceId, flowId, entity, force: true },
      });
    }

    return { success: true, ...result };
  },
);
