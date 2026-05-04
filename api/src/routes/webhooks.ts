import { Hono } from "hono";
import { Types } from "mongoose";
import {
  Flow,
  WebhookEvent,
  Connector as DataSource,
  DatabaseConnection,
} from "../database/workspace-schema";
import { enqueueWebhookProcess } from "../inngest/webhook-process-enqueue";
import { v4 as uuidv4 } from "uuid";
import { connectorRegistry } from "../connectors/registry";
import {
  isEntityEnabledForFlow,
  resolveConfiguredEntities,
} from "../sync-cdc/entity-selection";
import { hasCdcDestinationAdapter } from "../sync-cdc/adapters/registry";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import type { AuthenticatedContext } from "../middleware/workspace.middleware";
import { workspaceService } from "../services/workspace.service";
import { enrichContextWithWorkspace, loggers } from "../logging";

const logger = loggers.inngest("webhook");

const router = new Hono();

function isCdcFlow(
  flow: { syncEngine?: string; tableDestination?: { connectionId?: unknown } },
  destinationType?: string,
): boolean {
  return (
    flow.syncEngine === "cdc" &&
    Boolean(flow.tableDestination?.connectionId) &&
    hasCdcDestinationAdapter(destinationType)
  );
}

async function requireWebhookTestAccess(
  c: AuthenticatedContext,
  workspaceId: string,
) {
  const authenticatedWorkspace = c.get("workspace");
  const user = c.get("user");

  if (authenticatedWorkspace) {
    if (authenticatedWorkspace._id.toString() !== workspaceId) {
      return c.json(
        { error: "API key not authorized for this workspace" },
        403,
      );
    }
  } else if (user) {
    const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
    if (!hasAccess) {
      return c.json({ error: "Access denied to workspace" }, 403);
    }
  } else {
    return c.json({ error: "Unauthorized" }, 401);
  }

  enrichContextWithWorkspace(workspaceId);
  c.set("workspaceId", workspaceId);
  return null;
}

/**
 * Webhook endpoint handler
 * URL structure: /api/webhooks/:workspaceId/:flowId
 *
 * CDC flows: saves WebhookEvent as "pending" and returns 200 immediately.
 * The 2-min cron (cdcMaterializeSchedulerFunction) ingests pending events
 * into CdcChangeEvents and triggers materialization — no per-webhook Inngest
 * events are emitted.
 *
 * Non-CDC (legacy SQL) flows: saves WebhookEvent and enqueues via Inngest
 * for immediate processing (unchanged).
 */
router.post("/webhooks/:workspaceId/:flowId", async c => {
  const { workspaceId, flowId } = c.req.param();

  logger.debug("Webhook received", { workspaceId, flowId });

  const rawBodyBuffer = Buffer.from(await c.req.arrayBuffer());
  const rawBodyText = rawBodyBuffer.toString("utf8");
  const headers = c.req.header();

  try {
    const flow = await Flow.findOne({
      _id: flowId,
      workspaceId: workspaceId,
      type: "webhook",
    });

    if (!flow) {
      logger.warn("Webhook received for invalid flow", { flowId });
      return c.json({ error: "Invalid webhook endpoint" }, 404);
    }

    if (!flow.webhookConfig?.enabled) {
      logger.warn("Webhook received for disabled flow", { flowId });
      return c.json({ error: "Webhook endpoint disabled" }, 403);
    }

    const dataSource = await DataSource.findById(flow.dataSourceId);
    if (!dataSource) {
      return c.json({ error: "Data source not found" }, 404);
    }

    const connector = connectorRegistry.getConnector(dataSource);
    if (!connector) {
      return c.json(
        { error: `Connector not found for type: ${dataSource.type}` },
        500,
      );
    }

    let event: any;

    if (connector.supportsWebhooks()) {
      const verificationResult = await connector.verifyWebhook({
        payload: rawBodyText,
        headers: headers,
        secret: flow.webhookConfig.secret,
      });

      if (!verificationResult.valid) {
        logger.error("Webhook signature verification failed", {
          error: verificationResult.error,
        });
        return c.json(
          { error: verificationResult.error || "Invalid signature" },
          400,
        );
      }

      event = verificationResult.event;
    } else {
      try {
        event = JSON.parse(rawBodyText);
      } catch (e) {
        logger.error("Invalid JSON payload", { error: e });
        return c.json({ error: "Invalid JSON payload" }, 400);
      }
    }

    const webhookEvent = new WebhookEvent({
      flowId,
      workspaceId,
      eventId: event.id || uuidv4(),
      eventType:
        event.type ||
        event.event_type ||
        event.action ||
        (event.event?.object_type && event.event?.action
          ? `${event.event.object_type}.${event.event.action}`
          : "unknown"),
      receivedAt: new Date(),
      status: "pending",
      attempts: 0,
      rawPayload: event,
      signature: JSON.stringify(headers),
    });

    await webhookEvent.save();

    await Flow.updateOne(
      { _id: flowId },
      {
        $set: { "webhookConfig.lastReceivedAt": new Date() },
        $inc: { "webhookConfig.totalReceived": 1 },
      },
    );

    // CDC flows: save and return. The 2-min cron handles ingest + materialization.
    const destConn = flow.destinationDatabaseId
      ? await DatabaseConnection.findById(flow.destinationDatabaseId)
          .select("type")
          .lean()
      : null;

    if (isCdcFlow(flow, destConn?.type)) {
      logger.info("Webhook saved for CDC cron ingest", {
        eventId: webhookEvent.eventId,
        flowId,
      });
      return c.json({ received: true, eventId: webhookEvent.eventId }, 200);
    }

    // Non-CDC flows: early entity filter + enqueue via Inngest (existing path)
    const mapping = connector.getWebhookEventMapping(webhookEvent.eventType);
    if (mapping) {
      const baseEntity = mapping.entity.split(":")[0];
      const { entities: configuredEntities } = resolveConfiguredEntities(flow);
      const hasSubTypes = configuredEntities.some(e =>
        e.startsWith(baseEntity + ":"),
      );
      if (
        !hasSubTypes &&
        !isEntityEnabledForFlow(flow, mapping.entity, baseEntity)
      ) {
        await WebhookEvent.updateOne(
          { _id: webhookEvent._id },
          {
            $set: {
              status: "completed",
              applyStatus: "dropped",
              entity: mapping.entity,
              applyError: {
                code: "ENTITY_DISABLED",
                message: `Entity ${mapping.entity} is disabled or not selected in flow configuration`,
              },
              processedAt: new Date(),
              processingDurationMs:
                Date.now() - webhookEvent.receivedAt.getTime(),
            },
            $unset: { appliedAt: "" },
          },
        );
        return c.json(
          { received: true, eventId: webhookEvent.eventId, dropped: true },
          200,
        );
      }
    }

    try {
      await enqueueWebhookProcess({
        flowId,
        workspaceId,
        eventId: webhookEvent.eventId,
        flow: {
          syncEngine: flow.syncEngine,
          destinationDatabaseId: flow.destinationDatabaseId,
          tableDestination: flow.tableDestination,
        },
        destinationTypeHint: destConn?.type,
      });
    } catch (enqueueError) {
      await WebhookEvent.updateOne(
        { _id: webhookEvent._id },
        {
          $set: {
            status: "failed",
            applyStatus: "failed",
            processedAt: new Date(),
            applyError: {
              code: "ENQUEUE_FAILED",
              message:
                enqueueError instanceof Error
                  ? enqueueError.message
                  : String(enqueueError),
            },
            error: {
              message:
                enqueueError instanceof Error
                  ? enqueueError.message
                  : String(enqueueError),
            },
          },
        },
      );

      logger.error("Failed to enqueue webhook event for processing", {
        flowId,
        eventId: webhookEvent.eventId,
        error:
          enqueueError instanceof Error
            ? enqueueError.message
            : String(enqueueError),
      });

      return c.json({ received: false, eventId: webhookEvent.eventId }, 200);
    }

    return c.json({ received: true, eventId: webhookEvent.eventId }, 200);
  } catch (error) {
    logger.error("Webhook handler error", { error });
    return c.json({ received: false, error: "Internal processing error" }, 200);
  }
});

/**
 * Test webhook endpoint
 * Sends a test event to verify webhook configuration
 */
router.post(
  "/webhooks/:workspaceId/:flowId/test",
  unifiedAuthMiddleware,
  async (c: AuthenticatedContext) => {
    const { workspaceId, flowId } = c.req.param();

    try {
      if (
        !Types.ObjectId.isValid(workspaceId) ||
        !Types.ObjectId.isValid(flowId)
      ) {
        return c.json({ error: "Invalid webhook test endpoint" }, 400);
      }

      const accessDenied = await requireWebhookTestAccess(c, workspaceId);
      if (accessDenied) return accessDenied;

      const flow = await Flow.findOne({
        _id: flowId,
        workspaceId: workspaceId,
        type: "webhook",
      });

      if (!flow) {
        return c.json({ error: "Webhook flow not found" });
      }

      // Create a test event
      const testEvent = {
        id: `test_${uuidv4()}`,
        type: "test.webhook",
        created: Math.floor(Date.now() / 1000),
        data: {
          message: "This is a test webhook event",
          timestamp: new Date().toISOString(),
        },
      };

      // Store the test event
      const webhookEvent = new WebhookEvent({
        flowId,
        workspaceId,
        eventId: testEvent.id,
        eventType: testEvent.type,
        receivedAt: new Date(),
        status: "pending",
        attempts: 0,
        rawPayload: testEvent,
      });

      await webhookEvent.save();

      const destConn = flow.destinationDatabaseId
        ? await DatabaseConnection.findById(flow.destinationDatabaseId)
            .select("type")
            .lean()
        : null;

      if (isCdcFlow(flow, destConn?.type)) {
        return c.json({
          success: true,
          message:
            "Test webhook saved — will be ingested on next cron cycle (<=2 min)",
          eventId: testEvent.id,
        });
      }

      await enqueueWebhookProcess({
        flowId,
        workspaceId,
        eventId: webhookEvent.eventId,
        isTest: true,
        flow: {
          syncEngine: flow.syncEngine,
          destinationDatabaseId: flow.destinationDatabaseId,
          tableDestination: flow.tableDestination,
        },
        destinationTypeHint: destConn?.type,
      });

      return c.json({
        success: true,
        message: "Test webhook sent successfully",
        eventId: testEvent.id,
      });
    } catch (error) {
      logger.error("Test webhook error", { error });
      return c.json({ error: "Failed to send test webhook" }, 500);
    }
  },
);

export { router as webhookRoutes };
