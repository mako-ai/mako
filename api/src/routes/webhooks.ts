import { Hono } from "hono";
import {
  Flow,
  WebhookEvent,
  Connector as DataSource,
} from "../database/workspace-schema";
import { inngest } from "../inngest/client";
import { v4 as uuidv4 } from "uuid";
import { connectorRegistry } from "../connectors/registry";
import { loggers } from "../logging";

const logger = loggers.inngest("webhook");

const router = new Hono();

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function enqueueWebhookEventProcessing(payload: {
  flowId: string;
  workspaceId: string;
  eventId: string;
  isTest?: boolean;
}) {
  const maxAttempts = 3;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await inngest.send({
        name: "webhook/event.process",
        data: payload,
      });
      return;
    } catch (error) {
      lastError = error;
      logger.warn("Failed to enqueue webhook event for processing", {
        flowId: payload.flowId,
        eventId: payload.eventId,
        attempt,
        maxAttempts,
        error: error instanceof Error ? error.message : String(error),
      });

      if (attempt < maxAttempts) {
        await delay(attempt * 300);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unknown enqueue error");
}

/**
 * Webhook endpoint handler
 * URL structure: /api/webhooks/:workspaceId/:flowId
 */
router.post("/webhooks/:workspaceId/:flowId", async c => {
  const { workspaceId, flowId } = c.req.param();

  logger.debug("Webhook received", { workspaceId, flowId });

  // For Stripe webhooks, we need the raw body as Buffer
  // Using arrayBuffer and converting to Buffer preserves the exact bytes
  const rawBodyBuffer = Buffer.from(await c.req.arrayBuffer());
  const rawBodyText = rawBodyBuffer.toString("utf8");
  const headers = c.req.header();

  logger.debug("Webhook payload details", {
    headers,
    bodyLength: rawBodyBuffer.length,
    bodyPreview: rawBodyText.substring(0, 200),
  });

  try {
    // 1. Quick validation - find the flow
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

    // 2. Get the data source and connector
    const dataSource = await DataSource.findById(flow.dataSourceId);
    if (!dataSource) {
      return c.json({ error: "Data source not found" }, 404);
    }

    // Ensure connector registry is ready before resolving connector type.
    await connectorRegistry.ensureInitialized();

    // Get the connector for this data source type
    const connector = connectorRegistry.getConnector(dataSource);
    if (!connector) {
      return c.json(
        { error: `Connector not found for type: ${dataSource.type}` },
        500,
      );
    }

    // 3. Verify webhook signature using connector
    let event: any;

    if (connector.supportsWebhooks()) {
      logger.debug("Verifying webhook signature", {
        secretLength: flow.webhookConfig.secret?.length,
        secretPrefix: flow.webhookConfig.secret?.substring(0, 10),
      });

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

      logger.info("Webhook signature verified successfully");
      event = verificationResult.event;
    } else {
      // Connector doesn't support webhooks but we received one anyway
      // Parse the raw body as JSON
      try {
        event = JSON.parse(rawBodyText);
      } catch (e) {
        logger.error("Invalid JSON payload", { error: e });
        return c.json({ error: "Invalid JSON payload" }, 400);
      }
    }

    // 3. Store the raw event for processing
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
      signature: JSON.stringify(headers), // Store all headers for audit/debugging
    });

    await webhookEvent.save();

    // 5. Update webhook stats
    await Flow.updateOne(
      { _id: flowId },
      {
        $set: { "webhookConfig.lastReceivedAt": new Date() },
        $inc: { "webhookConfig.totalReceived": 1 },
      },
    );

    // 6. Trigger immediate processing via Inngest
    try {
      await enqueueWebhookEventProcessing({
        flowId,
        workspaceId,
        eventId: webhookEvent.eventId,
      });
    } catch (enqueueError) {
      await WebhookEvent.updateOne(
        { _id: webhookEvent._id },
        {
          $set: {
            status: "failed",
            applyStatus: "failed",
            applyError: {
              code: "ENQUEUE_FAILED",
              message:
                enqueueError instanceof Error
                  ? enqueueError.message
                  : "Failed to enqueue webhook event for processing",
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

      logger.error("Failed to enqueue webhook event", {
        flowId,
        eventId: webhookEvent.eventId,
        error:
          enqueueError instanceof Error
            ? enqueueError.message
            : String(enqueueError),
      });

      return c.json(
        {
          received: false,
          error: "Failed to enqueue webhook processing",
          eventId: webhookEvent.eventId,
        },
        503,
      );
    }

    // 8. Return success immediately
    logger.info("Webhook processed successfully", {
      eventId: webhookEvent.eventId,
    });
    return c.json({ received: true, eventId: webhookEvent.eventId }, 200);
  } catch (error) {
    logger.error("Webhook handler error", { error });

    // Still return 200 to prevent retries for our errors
    return c.json(
      {
        received: false,
        error: "Internal processing error, event saved for retry",
      },
      200,
    );
  }
});

/**
 * Test webhook endpoint
 * Sends a test event to verify webhook configuration
 */
router.post("/webhooks/:workspaceId/:flowId/test", async c => {
  const { workspaceId, flowId } = c.req.param();

  try {
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

    // Trigger processing
    await enqueueWebhookEventProcessing({
      flowId,
      workspaceId,
      eventId: webhookEvent.eventId,
      isTest: true,
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
});

export { router as webhookRoutes };
