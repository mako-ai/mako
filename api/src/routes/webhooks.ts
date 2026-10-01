import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { Types } from "mongoose";
import {
  Flow,
  WebhookEvent,
  SourceConnection,
} from "../database/workspace-schema";
import { v4 as uuidv4 } from "uuid";
import { connectorRegistry } from "../connectors/registry";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { enrichContextWithWorkspace, loggers } from "../logging";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
  type AuthEnv,
} from "../openapi/core";

const logger = loggers.inngest("webhook");

const router = createRouter();

const WebhookParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
  flowId: z.string().openapi({ param: { name: "flowId", in: "path" } }),
});

async function requireWebhookTestAccess(
  c: Context<AuthEnv>,
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
 * Saves the inbound event as a "pending" WebhookEvent and returns 200
 * immediately. The CDC scheduler cron (cdcMaterializeSchedulerFunction)
 * ingests pending events into CdcChangeEvents and triggers materialization —
 * no per-webhook Inngest events are emitted. The legacy real-time webhook
 * processing pipeline (webhook/event.process) has been decommissioned.
 */
router.openapi(
  createRoute({
    method: "post",
    path: "/webhooks/{workspaceId}/{flowId}",
    tags: ["Webhooks"],
    summary: "Receive an inbound connector webhook",
    description:
      "Inbound webhook receiver for connector flows. Public — authenticated via the connector's signature, not session/API key.",
    security: [],
    request: { params: WebhookParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const { workspaceId, flowId } = c.req.param();

    logger.debug("Webhook received", { workspaceId, flowId });

    const rawBodyBuffer = Buffer.from(await c.req.arrayBuffer());
    const rawBodyText = rawBodyBuffer.toString("utf8");
    const headers = c.req.header();
    const query = c.req.query();

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

      const sourceConnection = await SourceConnection.findById(
        flow.dataSourceId,
      );
      if (!sourceConnection) {
        return c.json({ error: "Data source not found" }, 404);
      }

      const connector = connectorRegistry.getConnectorFor(sourceConnection);
      if (!connector) {
        return c.json(
          { error: `Connector not found for type: ${sourceConnection.type}` },
          500,
        );
      }

      let event: any;

      if (connector.supportsWebhooks()) {
        const verificationResult = await connector.verifyWebhook({
          payload: rawBodyText,
          headers: headers,
          secret: flow.webhookConfig.secret,
          query,
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
        // Close (and some other vendors) nest the unique event id at
        // `event.event.id`; the top-level `event.id` is the OBJECT id, which is
        // stable across updates. Falling back to it would defeat the
        // (flowId,eventId) unique index for vendor retries. Prefer the nested
        // event id, then top-level, then a random id as a last resort.
        eventId: event.id || event.event?.id || uuidv4(),
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

      // Save and return. The CDC scheduler cron ingests pending events into
      // CdcChangeEvents and triggers materialization (entity filtering happens
      // at ingest time). No per-webhook Inngest event is emitted.
      logger.info("Webhook saved for CDC cron ingest", {
        eventId: webhookEvent.eventId,
        flowId,
      });
      return c.json({ received: true, eventId: webhookEvent.eventId }, 200);
    } catch (error) {
      logger.error("Webhook handler error", { error });
      return c.json(
        { received: false, error: "Internal processing error" },
        200,
      );
    }
  },
);

/**
 * Test webhook endpoint
 * Sends a test event to verify webhook configuration
 */
router.openapi(
  createRoute({
    method: "post",
    path: "/webhooks/{workspaceId}/{flowId}/test",
    tags: ["Webhooks"],
    summary: "Send a test webhook event",
    security: AUTH_SECURITY,
    middleware: [unifiedAuthMiddleware] as const,
    request: { params: WebhookParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
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

      return c.json({
        success: true,
        message:
          "Test webhook saved — will be ingested on the next CDC cron cycle (<=5 min)",
        eventId: testEvent.id,
      });
    } catch (error) {
      logger.error("Test webhook error", { error });
      return c.json({ error: "Failed to send test webhook" }, 500);
    }
  },
);

export { router as webhookRoutes };
