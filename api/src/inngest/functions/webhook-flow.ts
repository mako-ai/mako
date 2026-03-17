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

/**
 * Process a single webhook event immediately
 */
export const webhookEventProcessFunction = inngest.createFunction(
  {
    id: "webhook-event-process",
    name: "Process Webhook Event",
    concurrency: {
      limit: 25, // Handle many events in parallel
    },
  },
  { event: "webhook/event.process" },
  async ({ event, step }) => {
    const { flowId, eventId } = event.data;
    const logger = getSyncLogger(`webhook.${flowId}`);

    logger.debug("Processing webhook event", { flowId, eventId });

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
                processedAt: new Date(),
                processingDurationMs:
                  Date.now() - new Date(webhookEvent.receivedAt).getTime(),
              },
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

        // For activity events, resolve sub-type from the data's _type field
        // so we route to the correct per-sub-type table (e.g. activities:Call → call)
        let resolvedEntity = mapping.entity;
        if (mapping.entity === "activities" && data._type) {
          resolvedEntity = `activities:${data._type}`;
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
                processingDurationMs:
                  Date.now() - new Date(webhookEvent.receivedAt).getTime(),
              },
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
              processingDurationMs:
                Date.now() - new Date(webhookEvent.receivedAt).getTime(),
            },
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
              error: {
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              },
            },
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

      if (failedEvents.length === 0) {
        return { retried: 0 };
      }

      // Reset events to pending and trigger reprocessing
      let totalRetried = 0;
      for (const event of failedEvents) {
        await WebhookEvent.updateOne(
          { _id: event._id },
          { $set: { status: "pending" } },
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
      });

      return { retried: totalRetried };
    });

    return result;
  },
);
